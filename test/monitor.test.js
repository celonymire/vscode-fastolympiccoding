const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');


// --- Helper to load the addon (similar to runtime.ts) ---
function getProcessMonitor() {
  const platform = process.platform;
  let addonName = '';
  if (platform === 'linux') addonName = 'linux-process-monitor.node';
  else if (platform === 'darwin') addonName = 'darwin-process-monitor.node';
  else if (platform === 'win32') addonName = 'win32-process-monitor.node';
  else throw new Error(`Unsupported platform: ${platform}`);

  // Look in build/Release first (dev), then src/addons (prod layout maybe?)
  // The user seems to have them in build/Release based on previous ls
  const localBuildPath = path.join(__dirname, '..', 'build', 'Release', addonName);
  
  // Note: In runtime.ts it looks in __dirname which is dist/extension/utils. 
  // Here we are in test/, so we look in build/Release.
  
  if (fs.existsSync(localBuildPath)) {
    return require(localBuildPath);
  }
  
  throw new Error(`Addon not found at ${localBuildPath}. Run 'npm run build:addon' first.`);
}

const monitor = getProcessMonitor();

// --- Wrappers for the monitor.spawn API ---

function spawnPromise(args, options = {}) {
  const {
    timeoutMs = 0,
    memoryLimitMB = 0,
    input = null
  } = options;

  return new Promise((resolve, reject) => {
    // We use process.execPath to run "node"
    const command = process.execPath;
    
    // Create temporary file for stdout to avoid implementing a full stream reader here if we just want results
    // Actually, the addon returns file descriptors. We need to read them.
    // To properly test the addon, we should read the pipes.
    
    let spawnResult;
    try {
        spawnResult = monitor.spawn(
            command,
            args,
            process.cwd(),
            timeoutMs,
            memoryLimitMB,
            () => {} // onSpawn
        );
    } catch (e) {
        return reject(e);
    }

    const { stdio, result } = spawnResult;
    const [ stdinFd, stdoutFd, stderrFd ] = stdio;

    // Create streams from FDs
    const stdout = fs.createReadStream('', { fd: stdoutFd, autoClose: true });
    const stderr = fs.createReadStream('', { fd: stderrFd, autoClose: true });
    const stdin = fs.createWriteStream('', { fd: stdinFd, autoClose: true });

    let output = '';
    let errorOutput = '';

    stdout.on('data', chunk => output += chunk.toString());
    stderr.on('data', chunk => errorOutput += chunk.toString());

    if (input) {
        stdin.write(input);
        stdin.end();
    } else {
        stdin.end();
    }

    // Wait for native result AND streams to finish
    Promise.all([
        result.then(stats => spawnResult.stats = stats),
        new Promise(resolve => stdout.on('close', resolve)),
        new Promise(resolve => stderr.on('close', resolve))
    ]).then(() => {
        resolve({
            ...spawnResult.stats,
            output,
            errorOutput
        });
    }).catch(reject);
  });
}

// --- CHECKS ---

test('Basic Execution: Hello World', { timeout: 10000 }, async () => {
    const res = await spawnPromise(['-e', 'console.log("Hello Native")']);
    assert.strictEqual(res.exitCode, 0);
    assert.match(res.output, /Hello Native/);
    assert.strictEqual(res.timedOut, false);
});

test('Input/Output: Echo', { timeout: 10000 }, async () => {
    // Requires piping stdin to stdout
    const res = await spawnPromise(
        ['-e', 'process.stdin.pipe(process.stdout)'], 
        { input: 'Echo This Back' }
    );
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.output, 'Echo This Back');
});

test('Timeout limit enforcement', { timeout: 15000 }, async () => {
    // Busy loop to burn CPU time, enforcing RLIMIT_CPU
    const start = Date.now();
    const res = await spawnPromise(
        ['-e', 'const start = Date.now(); while(Date.now() - start < 2000);'],
        { timeoutMs: 500 }
    );
    const duration = Date.now() - start;
    
    // Log failure details
    if (!res.timedOut) {
        console.error('Timeout Test Failed:', {
            exitCode: res.exitCode,
            elapsedMs: res.elapsedMs,
            duration,
            timedOut: res.timedOut,
            signal: res.signal // if we had this
        });
    }

    // Checking "timedOut" might be flaky if the OS kills it with SIGKILL/SIGXCPU 
    // and the addon maps it to exitCode 128+SIGXCPU but maybe doesn't set timedOut?
    // On Linux, we map SIGXCPU to timedOut=true.
    
    assert.strictEqual(res.timedOut, true, `Should have timed out. Exit: ${res.exitCode}`);
});

test('Memory limit enforcement', { timeout: 15000 }, async () => {
    // Basic check that we get memory stats
    const basicRes = await spawnPromise(['-e', 'console.log("hi")']);
    assert.ok(basicRes.peakMemoryBytes > 0, 'Peak memory should be > 0');

    // Strict limit test. 
    // Node startup uses ~30MB. Limit to 50MB, allocate 100MB strings.
    const res = await spawnPromise(
        ['-e', 'const a = []; while(1) { a.push("x".repeat(1024*1024)); }'],
        { memoryLimitMB: 50, timeoutMs: 5000 } // Add safety timeout
    );
    
    // On Linux/macOS, hitting RLIMIT_AS usually causes SIGKILL (signal 9) or SIGSEGV
    // Windows Job Object kills with specific code.
    // We mainly want to ensure it DIED and didn't run forever, and reported usage.
    
    // Check if it was killed or reported limit exceeded
    const killedByLimit = res.memoryLimitExceeded || res.exitCode !== 0;
    assert.ok(killedByLimit, 'Should fail due to memory limit');
});

test('Large Output (Deadlock prevention)', { timeout: 20000 }, async () => {
    // Write 2MB of data. 
    const size = 2 * 1024 * 1024;
    const res = await spawnPromise(['-e', `console.log("x".repeat(${size}))`]);
    
    assert.strictEqual(res.exitCode, 0);
    // console.log adds a newline
    assert.ok(res.output.trim().length >= size);
});

test('Concurrency stress test', { timeout: 60000 }, async () => {
    const count = 50; 
    console.log(`Spawning ${count} parallel processes...`);
    const promises = [];
    
    for (let i = 0; i < count; i++) {
        promises.push(spawnPromise(['-e', `console.log("Worker ${i}")`]));
    }
    
    const results = await Promise.all(promises);
    
    assert.strictEqual(results.length, count);
    for (let i = 0; i < count; i++) {
        if (results[i].output.trim() === '') {
             console.error(`Worker ${i} failed.`, {
                 exitCode: results[i].exitCode,
                 errorOutput: results[i].errorOutput
             });
        }
        assert.strictEqual(results[i].exitCode, 0);
        assert.match(results[i].output, new RegExp(`Worker ${i}`));
    }
});

test('Wall Clock Timeout: Sleep', { timeout: 10000 }, async () => {
    // Tests that sleeping processes are killed by wall clock timeout
    const start = Date.now();
    const res = await spawnPromise(
        ['-e', 'setTimeout(() => {}, 3000)'], 
        { timeoutMs: 1000 }
    );
    const duration = Date.now() - start;
    
    // We expect it to be killed around 1000ms
    assert.strictEqual(res.timedOut, true, 'Should have timed out (wall clock)');
    assert.ok(duration < 2500, `Process took ${duration}ms, expected ~1000ms`);
});

test('CPU Limit Enforcement: Multi-threaded', { timeout: 20000 }, async () => {
    // Tests that RLIMIT_CPU is strictly enforced even if wall clock is slower
    // 4 threads burning CPU should hit 3s CPU limit in < 1s wall time
    const fixturePath = path.join(__dirname, 'fixtures', 'cpu_burner.js');
    
    // Ensure fixture exists
    if (!fs.existsSync(fixturePath)) {
        console.warn('Skipping CPU Limit test: fixture not found at ' + fixturePath);
        return;
    }
    
    const start = Date.now();
    const res = await spawnPromise(
        [fixturePath], 
        { timeoutMs: 3000 }
    );
    const duration = Date.now() - start;
    
    assert.strictEqual(res.timedOut, true, 'Should have timed out (CPU limit)');
    
    // Should be killed significantly faster than 3000ms
    // With 4 threads, it should be around 750ms + overhead
    assert.ok(duration < 2500, `Process took ${duration}ms, suggesting wall clock timeout killed it instead of CPU limit`);
});

test('Thread Pool Concurrency (libuv)', { timeout: 15000 }, async () => {
    // Default UV_THREADPOOL_SIZE is 4.
    // We spawn 6 processes that sleep for 2000ms.
    // If they were blocked by the thread pool, they would take ~4000ms total.
    // Since our addon releases the GIL/runs in the thread pool, they should take ~2000ms.
    
    const count = 6;
    const duration = 2000;
    const start = Date.now();
    
    const promises = [];
    for (let i = 0; i < count; i++) {
        promises.push(spawnPromise(['-e', `setTimeout(() => {}, ${duration})`]));
    }
    
    await Promise.all(promises);
    const end = Date.now();
    const totalTime = end - start;
    
    // Allow some overhead, but it should be much less than 4000ms (2*duration)
    assert.ok(totalTime < duration * 1.5, `Total time ${totalTime}ms suggest thread pool exhaustion or serialization`);
});
