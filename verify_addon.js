const monitor = require('./build/Release/linux-process-monitor.node');
console.log('Addon loaded. Exported keys:', Object.keys(monitor));

if (Object.keys(monitor).includes('waitForProcess')) {
    console.error('FAIL: waitForProcess still exported!');
    process.exit(1);
}

if (!Object.keys(monitor).includes('spawn')) {
    console.error('FAIL: spawn NOT exported!');
    process.exit(1);
}

console.log('SUCCESS: Addon exports are correct (only spawn).');

// Basic smoke test spawn
const res = monitor.spawn('/usr/bin/echo', ['Hello'], process.cwd(), 1000, 0, () => {});
console.log('Spawned PID:', res.pid);
res.result.then(result => {
    console.log('Process result:', result);
    console.log('Verification finished successfully.');
    process.exit(0);
}).catch(err => {
    console.error('Spawn failed:', err);
    process.exit(1);
});
