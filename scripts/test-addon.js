#!/usr/bin/env node

/**
 * Test script for the judge addon in isolation.
 * Run with: node scripts/test-addon.js
 */

const path = require("path");

const addonPath = path.join(__dirname, "..", "dist", "judge.node");
console.log("Loading addon from:", addonPath);

let addon;
try {
  addon = require(addonPath);
  console.log("Addon loaded successfully");
  console.log("Exports:", Object.keys(addon));
} catch (err) {
  console.error("Failed to load addon:", err);
  process.exit(1);
}

// Test 1: Simple echo command
function testEcho() {
  return new Promise((resolve) => {
    console.log("\n=== Test 1: Echo command ===");

    let stdout = "";
    let stderr = "";

    const handle = addon.spawnProcess(
      ["echo", "Hello from addon!"],
      process.cwd(),
      5000, // 5s timeout
      256, // 256 MB memory limit
      (data) => {
        console.log("[stdout]", JSON.stringify(data));
        stdout += data;
      },
      (data) => {
        console.log("[stderr]", JSON.stringify(data));
        stderr += data;
      },
      () => {
        console.log("[spawn] Process spawned");
      },
      (err, result) => {
        if (err) {
          console.error("Error:", err);
        } else {
          console.log("Result:", result);
          console.log("Total stdout:", JSON.stringify(stdout));
          console.log("Total stderr:", JSON.stringify(stderr));
        }
        resolve();
      }
    );

    console.log("Process handle:", handle);
    console.log("Handle methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(handle)));
  });
}

// Test 2: Cat with stdin (pre-spawn buffered)
function testCatWithStdin() {
  return new Promise((resolve) => {
    console.log("\n=== Test 2: Cat with stdin (pre-spawn) ===");

    let stdout = "";
    let stderr = "";

    const handle = addon.spawnProcess(
      ["cat"],
      process.cwd(),
      5000,
      256,
      (data) => {
        console.log("[stdout]", JSON.stringify(data));
        stdout += data;
      },
      (data) => {
        console.log("[stderr]", JSON.stringify(data));
        stderr += data;
      },
      () => {
        console.log("[spawn] Process spawned");
      },
      (err, result) => {
        if (err) {
          console.error("Error:", err);
        } else {
          console.log("Result:", result);
          console.log("Total stdout:", JSON.stringify(stdout));
        }
        resolve();
      }
    );

    console.log("Writing to stdin...");
    handle.writeStdin("Line 1\n");
    handle.writeStdin("Line 2\n");
    handle.endStdin();
    console.log("Stdin closed");
  });
}

// Test 3: Interactive stdin (write after spawn)
function testInteractiveStdin() {
  return new Promise((resolve) => {
    console.log("\n=== Test 3: Interactive stdin (write after spawn) ===");

    let stdout = "";

    const handle = addon.spawnProcess(
      ["cat"],
      process.cwd(),
      5000,
      256,
      (data) => {
        console.log("[stdout]", JSON.stringify(data));
        stdout += data;
      },
      (data) => {
        console.log("[stderr]", JSON.stringify(data));
      },
      () => {
        console.log("[spawn] Process spawned");
      },
      (err, result) => {
        if (err) {
          console.error("Error:", err);
        } else {
          console.log("Result:", result);
          console.log("Total stdout:", JSON.stringify(stdout));
          if (stdout === "Interactive 1\nInteractive 2\n") {
            console.log("✓ Interactive stdin works!");
          } else {
            console.log("✗ Interactive stdin failed!");
          }
        }
        resolve();
      }
    );

    // Delay writes to simulate interactive input
    setTimeout(() => {
      console.log("Writing first line after 100ms...");
      handle.writeStdin("Interactive 1\n");
    }, 100);

    setTimeout(() => {
      console.log("Writing second line after 200ms...");
      handle.writeStdin("Interactive 2\n");
    }, 200);

    setTimeout(() => {
      console.log("Closing stdin after 300ms...");
      handle.endStdin();
    }, 300);
  });
}

// Test 4: Kill process
function testKill() {
  return new Promise((resolve) => {
    console.log("\n=== Test 4: Kill process ===");

    const startTime = Date.now();

    const handle = addon.spawnProcess(
      ["sleep", "10"],
      process.cwd(),
      0, // no timeout
      256,
      (data) => console.log("[stdout]", data),
      (data) => console.log("[stderr]", data),
      () => console.log("[spawn] Process spawned"),
      (err, result) => {
        const elapsed = Date.now() - startTime;
        if (err) {
          console.error("Error:", err);
        } else {
          console.log("Result:", result);
          console.log("Elapsed:", elapsed, "ms");
          if (elapsed < 1000 && result.termSignal === 9) {
            console.log("✓ Process was killed successfully!");
          } else {
            console.log("✗ Kill did not work as expected");
          }
        }
        resolve();
      }
    );

    // Kill after 200ms
    setTimeout(() => {
      console.log("Killing process after 200ms...");
      handle.kill();
    }, 200);
  });
}

// Test 5: Timeout test
function testTimeout() {
  return new Promise((resolve) => {
    console.log("\n=== Test 5: Timeout test (should timeout after 1s) ===");

    const handle = addon.spawnProcess(
      ["sleep", "10"],
      process.cwd(),
      1000, // 1s timeout
      256,
      (data) => console.log("[stdout]", data),
      (data) => console.log("[stderr]", data),
      () => console.log("[spawn] Process spawned"),
      (err, result) => {
        if (err) {
          console.error("Error:", err);
        } else {
          console.log("Result:", result);
          console.log("Timed out:", result.timedOut);
        }
        resolve();
      }
    );
  });
}

// Test 6: Spawn error
function testSpawnError() {
  return new Promise((resolve) => {
    console.log("\n=== Test 6: Spawn error (non-existent command) ===");

    const handle = addon.spawnProcess(
      ["nonexistent_command_12345"],
      process.cwd(),
      5000,
      256,
      (data) => console.log("[stdout]", data),
      (data) => console.log("[stderr]", data),
      () => console.log("[spawn] Process spawned"),
      (err, result) => {
        if (err) {
          console.log("Got expected error:", err.message);
        } else {
          console.log("Result:", result);
          console.log("Spawn error flag:", result.spawnError);
        }
        resolve();
      }
    );
  });
}

// Test 7: Cat with stdin written but NOT closed (like extension does)
function testCatNoClose() {
  return new Promise((resolve) => {
    console.log("\n=== Test 7: Cat with stdin NOT closed (mimics extension) ===");

    let stdout = "";
    let stderr = "";

    const handle = addon.spawnProcess(
      ["cat"],
      process.cwd(),
      2000, // 2s timeout to prevent hanging forever
      256,
      (data) => {
        console.log("[stdout]", JSON.stringify(data));
        stdout += data;
      },
      (data) => {
        console.log("[stderr]", JSON.stringify(data));
        stderr += data;
      },
      () => {
        console.log("[spawn] Process spawned");
        console.log("Writing to stdin WITHOUT closing...");
        handle.writeStdin("Test line\n");
        console.log("Stdin written but not closed");
      },
      (err, result) => {
        if (err) {
          console.error("Error:", err);
        } else {
          console.log("Result:", result);
          console.log("Total stdout:", JSON.stringify(stdout));
          if (result.timedOut) {
            console.log("⚠ Process timed out (expected - cat waits for EOF)");
          } else {
            console.log("✓ Process completed without timeout");
          }
        }
        resolve();
      }
    );
  });
}

async function main() {
  try {
    await testEcho();
    await testCatWithStdin();
    await testInteractiveStdin();
    await testKill();
    await testTimeout();
    await testSpawnError();
    await testCatNoClose();
    console.log("\n=== All tests completed ===");
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  }
}

main();
