#!/usr/bin/env node
// Test script to verify prlimit()-based resource limiting

const { spawn } = require("child_process");
const addon = require("./build/Release/linux-process-monitor.node");

console.log("Testing prlimit()-based resource limiting...\n");

// Test 1: CPU timeout (should trigger SIGXCPU)
console.log("Test 1: CPU timeout");
const cpuHog = spawn("bash", ["-c", "while true; do :; done"]);
console.log(`Started CPU hog with PID ${cpuHog.pid}`);

addon
  .waitForProcess(cpuHog.pid, 500, 0) // 500ms timeout, no memory limit
  .then((result) => {
    console.log("Result:", result);
    console.log(`  - timedOut: ${result.timedOut} (expected: true)`);
    console.log(`  - exitCode: ${result.exitCode} (expected: ~152 for SIGXCPU)`);
    console.log(`  - elapsedMs: ${result.elapsedMs.toFixed(2)}ms`);
    console.log();

    // Test 2: Memory limit
    console.log("Test 2: Memory limit (100MB)");
    const memHog = spawn("bash", [
      "-c",
      `
      python3 -c "
import time
data = []
try:
    for i in range(200):
        data.append(' ' * (1024 * 1024))  # 1MB per iteration
        time.sleep(0.01)
except:
    pass
"
    `,
    ]);
    console.log(`Started memory hog with PID ${memHog.pid}`);

    return addon.waitForProcess(memHog.pid, 10000, 100 * 1024 * 1024); // 10s timeout, 100MB limit
  })
  .then((result) => {
    console.log("Result:", result);
    console.log(`  - memoryLimitExceeded: ${result.memoryLimitExceeded} (expected: true)`);
    console.log(`  - timedOut: ${result.timedOut} (expected: false)`);
    console.log(`  - peakMemoryBytes: ${(result.peakMemoryBytes / 1024 / 1024).toFixed(2)}MB`);
    console.log();

    // Test 3: Normal exit
    console.log("Test 3: Normal exit");
    const normalProcess = spawn("bash", ["-c", "sleep 0.1 && exit 42"]);
    console.log(`Started normal process with PID ${normalProcess.pid}`);

    return addon.waitForProcess(normalProcess.pid, 5000, 0); // 5s timeout, no memory limit
  })
  .then((result) => {
    console.log("Result:", result);
    console.log(`  - exitCode: ${result.exitCode} (expected: 42)`);
    console.log(`  - timedOut: ${result.timedOut} (expected: false)`);
    console.log(`  - memoryLimitExceeded: ${result.memoryLimitExceeded} (expected: false)`);
    console.log();

    console.log("✅ All tests completed!");
  })
  .catch((err) => {
    console.error("❌ Error:", err);
    process.exit(1);
  });
