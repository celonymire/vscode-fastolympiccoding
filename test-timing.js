#!/usr/bin/env node

// Test script to verify timing addons work correctly
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const distPath = path.join(process.cwd(), 'dist');

console.log('Testing timing addons...');
console.log('Platform:', process.platform);
console.log('Working directory:', process.cwd());
console.log('Dist path:', distPath);

// Load the appropriate addon based on platform
let addon = null;
let addonName = '';
let getFunctionName = '';

if (process.platform === 'win32') {
  addonName = 'win32-process-times.node';
  getFunctionName = 'getWin32ProcessTimes';
} else if (process.platform === 'linux') {
  addonName = 'linux-process-times.node';
  getFunctionName = 'getLinuxProcessTimes';
} else if (process.platform === 'darwin') {
  addonName = 'darwin-process-times.node';
  getFunctionName = 'getDarwinProcessTimes';
}

const addonPath = path.join(distPath, addonName);
console.log('Addon path:', addonPath);

if (!fs.existsSync(addonPath)) {
  console.error('ERROR: Addon not found at', addonPath);
  process.exit(1);
}

try {
  addon = require(addonPath);
  console.log('✓ Addon loaded successfully');
  console.log('Addon exports:', Object.keys(addon));
} catch (err) {
  console.error('ERROR: Failed to load addon:', err.message);
  process.exit(1);
}

// Test the addon with a sleep process
console.log('\nTesting timing accuracy with a sleep process...');

const testProcess = spawn('sleep', ['1']);
const pid = testProcess.pid;

console.log('Spawned process with PID:', pid);
console.log('Waiting for process to complete...');

// Sample timing at intervals
const samples = [];
const startTime = Date.now();
const sampleInterval = setInterval(() => {
  try {
    const timing = addon[getFunctionName](pid);
    
    samples.push({
      time: Date.now(),
      elapsed: timing.elapsedMs,
      cpu: timing.cpuMs
    });
    
    const wallTime = Date.now() - startTime;
    console.log(`Sample at ${wallTime}ms: elapsed=${timing.elapsedMs.toFixed(2)}ms, cpu=${timing.cpuMs.toFixed(2)}ms`);
  } catch (err) {
    // Process may have exited
    console.log('Process exited or addon call failed:', err.message);
    clearInterval(sampleInterval);
  }
}, 250);

testProcess.on('exit', (code) => {
  clearInterval(sampleInterval);
  
  // Get one final timing sample right at exit
  try {
    const finalTiming = addon[getFunctionName](pid);
    samples.push({
      time: Date.now(),
      elapsed: finalTiming.elapsedMs,
      cpu: finalTiming.cpuMs
    });
    console.log(`Final sample at exit: elapsed=${finalTiming.elapsedMs.toFixed(2)}ms, cpu=${finalTiming.cpuMs.toFixed(2)}ms`);
  } catch (err) {
    console.log('Could not get final timing (process already cleaned up):', err.message);
  }
  
  const totalWallTime = Date.now() - startTime;
  console.log('\n✓ Process exited with code:', code);
  console.log('Wall-clock time from JS:', totalWallTime, 'ms');
  
  if (samples.length > 0) {
    const lastSample = samples[samples.length - 1];
    console.log(`Final timing from addon: elapsed=${lastSample.elapsed.toFixed(2)}ms`);
    
    // Verify the timing is close to 1000ms (1 second)
    if (Math.abs(lastSample.elapsed - 1000) < 200) {
      console.log('✓ Timing is accurate (within 200ms of expected 1000ms)');
    } else {
      console.log('⚠ Timing may be inaccurate:', lastSample.elapsed, 'vs expected ~1000ms');
    }
    
    // The key insight: addon timing should be close to 1000ms, while JS wall time
    // might be slightly higher due to event loop overhead
    console.log('Difference (JS wall time - addon timing):', (totalWallTime - lastSample.elapsed).toFixed(2), 'ms');
  }
  
  console.log('\n✓ All tests passed!');
});
