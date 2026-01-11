const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const crypto = require("node:crypto");

// --- Helper to load the addon (similar to runtime.ts) ---
function getProcessMonitor() {
  const platform = process.platform;
  let addonName = "";
  if (platform === "linux") addonName = "linux-process-monitor.node";
  else if (platform === "darwin") addonName = "darwin-process-monitor.node";
  else if (platform === "win32") addonName = "win32-process-monitor.node";
  else throw new Error(`Unsupported platform: ${platform}`);

  const localBuildPath = path.join(__dirname, "..", "build", "Release", addonName);

  if (fs.existsSync(localBuildPath)) {
    return require(localBuildPath);
  }

  throw new Error(`Addon not found at ${localBuildPath}. Run 'npm run build:addon' first.`);
}

const monitor = getProcessMonitor();

// --- Wrappers for the monitor.spawn API ---

function createPipeServer(pipeName) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(pipeName, () => {
      resolve(server);
    });
    server.on("error", reject);
  });
}

function spawnPromise(args, options = {}) {
  const { timeoutMs = 0, memoryLimitMB = 0, input = null } = options;

  return new Promise((resolve, reject) => {
    (async () => {
      const command = process.execPath;

      // Generate unique pipe names
      const id = crypto.randomBytes(8).toString("hex");
      let pipeNameIn, pipeNameOut, pipeNameErr;

      if (process.platform === "win32") {
        pipeNameIn = `\\\\.\\pipe\\foc-test-${id}-in`;
        pipeNameOut = `\\\\.\\pipe\\foc-test-${id}-out`;
        pipeNameErr = `\\\\.\\pipe\\foc-test-${id}-err`;
      } else {
        const os = require("node:os");
        const tmpDir = os.tmpdir();
        pipeNameIn = path.join(tmpDir, `foc-test-${id}-in.sock`);
        pipeNameOut = path.join(tmpDir, `foc-test-${id}-out.sock`);
        pipeNameErr = path.join(tmpDir, `foc-test-${id}-err.sock`);
      }

      let serverIn, serverOut, serverErr;
      let socketIn, socketOut, socketErr;

      try {
        serverIn = await createPipeServer(pipeNameIn);
        serverOut = await createPipeServer(pipeNameOut);
        serverErr = await createPipeServer(pipeNameErr);

        let connectedCount = 0;
        const checkConnected = () => {
          connectedCount++;
          if (connectedCount === 3) {
            // All connected
            serverIn.close();
            serverOut.close();
            serverErr.close();

            // Handle IO
            let output = "";
            let errorOutput = "";

            socketOut.setEncoding("utf8");
            socketOut.on("data", (chunk) => (output += chunk));

            socketErr.setEncoding("utf8");
            socketErr.on("data", (chunk) => (errorOutput += chunk));

            if (input) {
              socketIn.write(input);
              socketIn.end();
            } else {
              socketIn.end();
            }

            // Wait for close
            const streamPromises = [
              new Promise((res) => socketOut.on("close", res)),
              new Promise((res) => socketErr.on("close", res)),
            ];

            Promise.all([spawnResult.result, ...streamPromises])
              .then(([stats]) => {
                resolve({
                  ...stats,
                  output,
                  errorOutput,
                });
              })
              .catch(reject);
          }
        };

        serverIn.on("connection", (socket) => {
          socketIn = socket;
          checkConnected();
        });
        serverOut.on("connection", (socket) => {
          socketOut = socket;
          checkConnected();
        });
        serverErr.on("connection", (socket) => {
          socketErr = socket;
          checkConnected();
        });

        const spawnResult = monitor.spawn(
          command,
          args,
          process.cwd(),
          timeoutMs,
          memoryLimitMB,
          pipeNameIn,
          pipeNameOut,
          pipeNameErr,
          () => {} // onSpawn
        );
      } catch (err) {
        if (serverIn) serverIn.close();
        if (serverOut) serverOut.close();
        if (serverErr) serverErr.close();
        reject(err);
      }
    })();
  });
}

// --- CHECKS ---

test("Basic Execution: Hello World", { timeout: 10000 }, async () => {
  const res = await spawnPromise(["-e", 'console.log("Hello Native")']);
  assert.strictEqual(res.exitCode, 0);
  assert.match(res.output, /Hello Native/);
  assert.strictEqual(res.timedOut, false);
});

test("Input/Output: Echo", { timeout: 10000 }, async () => {
  // Requires piping stdin to stdout
  const res = await spawnPromise(["-e", "process.stdin.pipe(process.stdout)"], {
    input: "Echo This Back",
  });
  assert.strictEqual(res.exitCode, 0);
  assert.strictEqual(res.output, "Echo This Back");
});

test("Timeout limit enforcement", { timeout: 15000 }, async () => {
  // Busy loop to burn CPU time, enforcing RLIMIT_CPU
  const start = Date.now();
  const res = await spawnPromise(
    ["-e", "const start = Date.now(); while(Date.now() - start < 2000);"],
    { timeoutMs: 500 }
  );
  const duration = Date.now() - start;

  // Log failure details
  if (!res.timedOut) {
    console.error("Timeout Test Failed:", {
      exitCode: res.exitCode,
      elapsedMs: res.elapsedMs,
      duration,
      timedOut: res.timedOut,
    });
  }

  // Checking "timedOut" might be flaky if the OS kills it with SIGKILL/SIGXCPU
  // and the addon maps it to exitCode 128+SIGXCPU but maybe doesn't set timedOut?
  // On Linux, we map SIGXCPU to timedOut=true.

  assert.strictEqual(res.timedOut, true, `Should have timed out. Exit: ${res.exitCode}`);
});

test("Memory limit enforcement", { timeout: 15000 }, async () => {
  // Basic check that we get memory stats
  const basicRes = await spawnPromise(["-e", 'console.log("hi")']);
  assert.ok(basicRes.peakMemoryBytes > 0, "Peak memory should be > 0");

  // Strict limit test.
  // Node startup uses ~30MB. Limit to 50MB, allocate 100MB strings.
  const res = await spawnPromise(
    ["-e", 'const a = []; while(1) { a.push("x".repeat(1024*1024)); }'],
    { memoryLimitMB: 50, timeoutMs: 5000 } // Add safety timeout
  );

  // On Linux/macOS, hitting RLIMIT_AS usually causes SIGKILL (signal 9) or SIGSEGV
  // Windows Job Object kills with specific code.
  // We mainly want to ensure it DIED and didn't run forever, and reported usage.

  // Check that the addon correctly identified memory limit exhaustion
  if (res.memoryLimitExceeded !== true) {
    console.log("Memory limit test result:", {
      exitCode: res.exitCode,
      memoryLimitExceeded: res.memoryLimitExceeded,
      timedOut: res.timedOut,
      peakMemoryBytes: res.peakMemoryBytes,
      elapsedMs: res.elapsedMs
    });
  }
  assert.strictEqual(res.memoryLimitExceeded, true, "memoryLimitExceeded should be true");
  assert.notStrictEqual(res.exitCode, 0, "exitCode should be non-zero");
});

test("Large Output (Deadlock prevention)", { timeout: 20000 }, async () => {
  // Write 2MB of data.
  const size = 2 * 1024 * 1024;
  const res = await spawnPromise(["-e", `console.log("x".repeat(${size}))`]);

  assert.strictEqual(res.exitCode, 0);
  // console.log adds a newline
  assert.ok(res.output.trim().length >= size);
});

test("Concurrency stress test", { timeout: 60000 }, async () => {
  const count = 50;
  console.log(`Spawning ${count} parallel processes...`);
  const promises = [];

  for (let i = 0; i < count; i++) {
    promises.push(spawnPromise(["-e", `console.log("Worker ${i}")`]));
  }

  const results = await Promise.all(promises);

  assert.strictEqual(results.length, count);
  for (let i = 0; i < count; i++) {
    if (results[i].output.trim() === "") {
      console.error(`Worker ${i} failed.`, {
        exitCode: results[i].exitCode,
        errorOutput: results[i].errorOutput,
      });
    }
    assert.strictEqual(results[i].exitCode, 0);
    assert.match(results[i].output, new RegExp(`Worker ${i}`));
  }
});

test("Wall Clock Timeout: Sleep", { timeout: 10000 }, async () => {
  // Tests that sleeping processes are killed by wall clock timeout
  // Policy matches 2x timeoutMs for leniency
  const start = Date.now();
  // Request 1000ms timeout -> Enforced as 2000ms wall limit
  // Sleep for 3000ms -> Should die around 2000ms
  const res = await spawnPromise(["-e", "setTimeout(() => {}, 3000)"], { timeoutMs: 1000 });
  const duration = Date.now() - start;

  assert.strictEqual(res.timedOut, true, "Should have timed out (wall clock)");
  assert.ok(duration >= 2000, `Process took ${duration}ms, expected >= 2000ms (2x policy)`);
  assert.ok(duration < 3000, `Process took ${duration}ms, expected < 3000ms`);
});

test("Execution: Spaced Paths", { timeout: 10000 }, async () => {
  // 1. Create a directory with spaces
  const tmpDir = require("os").tmpdir();
  const spacedDir = path.join(tmpDir, "foc space test");
  if (!fs.existsSync(spacedDir)) fs.mkdirSync(spacedDir, { recursive: true });

  // 2. Create a script inside it
  const scriptPath = path.join(spacedDir, "hello.js");
  fs.writeFileSync(scriptPath, 'console.log("Spaced Hello");');

  // 3. Run it using node
  // This tests ARGS with spaces (the script path)
  const res = await spawnPromise([scriptPath]);
  assert.strictEqual(res.exitCode, 0);
  assert.match(res.output, /Spaced Hello/);

  // 4. Try copying node executable to a spaced path (if possible/fast)
  // Skipping full node copy as it might be permission heavy or slow.
  // Instead relying on args test which exercises QuoteArg logic similarly.

  // Cleanup
  try {
    fs.rmSync(spacedDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

test("Input/Output: Spaced Path Script", { timeout: 10000 }, async () => {
  // 1. Create a directory with spaces
  const tmpDir = require("os").tmpdir();
  const spacedDir = path.join(tmpDir, "foc space input test");
  if (!fs.existsSync(spacedDir)) fs.mkdirSync(spacedDir, { recursive: true });

  // 2. Create a script that reads stdin
  const scriptPath = path.join(spacedDir, "echo_stdin.js");
  fs.writeFileSync(
    scriptPath,
    `
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            process.stdout.write(chunk);
        });
    `
  );

  // 3. Run it and provide input
  const inputStr = "Hello From Spaced Path";
  const res = await spawnPromise([scriptPath], { input: inputStr });

  assert.strictEqual(res.exitCode, 0);
  assert.strictEqual(res.output, inputStr);

  // Cleanup
  try {
    fs.rmSync(spacedDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

test("CPU Limit Enforcement: Multi-threaded", { timeout: 20000 }, async () => {
  // Tests that RLIMIT_CPU is strictly enforced even if wall clock is slower
  // 4 threads burning CPU should hit 3s CPU limit in < 1s wall time
  const fixturePath = path.join(__dirname, "fixtures", "cpu_burner.js");

  // Ensure fixture exists
  if (!fs.existsSync(fixturePath)) {
    console.warn("Skipping CPU Limit test: fixture not found at " + fixturePath);
    return;
  }

  const start = Date.now();
  const res = await spawnPromise([fixturePath], { timeoutMs: 3000 });
  const duration = Date.now() - start;

  assert.strictEqual(res.timedOut, true, "Should have timed out (CPU limit)");

  // Should be killed significantly faster than 3000ms
  // With 4 threads, it should be around 750ms + overhead
  assert.ok(
    duration < 2500,
    `Process took ${duration}ms, suggesting wall clock timeout killed it instead of CPU limit`
  );
});

test("Thread Pool Concurrency (libuv)", { timeout: 15000 }, async () => {
  // Default UV_THREADPOOL_SIZE is 4.
  // We spawn 6 processes that sleep for 2000ms.
  // If they were blocked by the thread pool, they would take ~4000ms total.
  // Since our addon releases the GIL/runs in the thread pool, they should take ~2000ms.

  const count = 6;
  const duration = 2000;
  const start = Date.now();

  const promises = [];
  for (let i = 0; i < count; i++) {
    promises.push(spawnPromise(["-e", `setTimeout(() => {}, ${duration})`]));
  }

  await Promise.all(promises);
  const end = Date.now();
  const totalTime = end - start;

  // Allow some overhead, but it should be much less than 4000ms (2*duration)
  assert.ok(
    totalTime < duration * 1.5,
    `Total time ${totalTime}ms suggest thread pool exhaustion or serialization`
  );
});
