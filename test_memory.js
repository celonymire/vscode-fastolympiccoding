const monitor = require('./build/Release/linux-process-monitor.node');
const fs = require('fs');

// Create a python script that uses memory
const pyScript = `
import time
# Allocate ~100MB
x = bytearray(100 * 1024 * 1024)
time.sleep(0.5)
`;
fs.writeFileSync('mem.py', pyScript);

async function test() {
    console.log("Starting memory process...");
    // 0: cmd, 1: args, 2: cwd, 3: timeoutMs, 4: memoryLimitMB, 5: onSpawn
    const res = monitor.spawn('/usr/bin/python3', ['mem.py'], process.cwd(), 5000, 150, () => {
        console.log("Process spawned!");
    });
    
    try {
        const result = await res.result;
        console.log("Result:", result);
        if (result.peakMemoryBytes === 0) {
            console.error("FAIL: Memory is 0!");
        } else {
            console.log(`SUCCESS: Memory is ${result.peakMemoryBytes} bytes (~${(result.peakMemoryBytes / 1024 / 1024).toFixed(2)} MB)`);
        }
    } catch (e) {
        console.error("Error:", e);
    }
}

test();
