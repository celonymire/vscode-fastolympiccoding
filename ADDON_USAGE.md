# Judge Addon Usage

The judge addon is a unified native C++ implementation using libuv that replaces the separate linux-memory-stats and win32-memory-stats addons. It provides process spawning, memory statistics, and stdin interaction in a single addon, moving all operations off the Node.js event loop.

## Features

- **Unified memory statistics**: Cross-platform memory monitoring for Windows and Linux
- **Off-event-loop execution**: Process spawning, stdio capture, and monitoring happen in a separate libuv event loop
- **Stdin support**: Write input data to running processes, support for interactive problems
- **Integrated memory tracking**: Native memory monitoring built into the process execution
- **Timeout management**: Precise timeout handling via libuv timers
- **Memory limit enforcement**: Automatic process termination when memory limits are exceeded
- **Full stdio capture**: Complete stdout/stderr capture

## API

The addon is automatically used by the `Runnable` class when available. The implementation transparently falls back to Node.js child_process + pidusage if the addon isn't available.

### Building the addon

```bash
npm run build:addon
```

This builds `build/Release/judge.node`.

### TypeScript Interface

```typescript
type JudgeAddon = {
  getMemoryStats: (pid: number) => { rss: number; peakRss: number };
  spawnProcess: (
    command: string[],
    cwd: string,
    timeoutMs: number,
    memoryLimitMb: number,
    callback: (
      err: Error | null,
      result?: {
        exitCode: number;
        termSignal: number;
        elapsedMs: number;
        maxMemoryBytes: number;
        stdout: string;
        stderr: string;
        timedOut: boolean;
        memoryLimitExceeded: boolean;
        spawnError: boolean;
        errorMessage: string;
      }
    ) => void
  ) => void;
};
```

## Usage Example

### Process Spawning with Stdin

```typescript
const runnable = new Runnable();
runnable.run(["./myprogram", "arg1", "arg2"], 5000, 256);

// Write to stdin
runnable.process?.stdin.write("test input\n");
runnable.process?.stdin.end(); // Signal EOF

runnable
  .on("stdout:data", (data) => console.log("stdout:", data))
  .on("stderr:data", (data) => console.error("stderr:", data))
  .on("close", (code, signal) => console.log("exit:", code, signal));

const termination = await runnable.done;
console.log("Termination reason:", termination);
console.log("Elapsed time:", runnable.elapsed, "ms");
console.log("Max memory:", runnable.maxMemoryBytes / (1024 * 1024), "MB");
```

### Interactive Problems

```typescript
const runnable = new Runnable();
runnable.run(["./interactive_program"], 5000, 256);

// Write queries and read responses
runnable.on("spawn", () => {
  runnable.process?.stdin.write("QUERY 1\n");
});

runnable.on("stdout:data", (data) => {
  console.log("Response:", data);
  // Send next query based on response
  runnable.process?.stdin.write("QUERY 2\n");
});

await runnable.done;
```

### Memory Statistics (Standalone)

The addon also exports a standalone memory stats function that works with any process:

```typescript
const addon = getJudgeAddon();
if (addon) {
  const stats = addon.getMemoryStats(processId);
  console.log("RSS:", stats.rss / (1024 * 1024), "MB");
  console.log("Peak RSS:", stats.peakRss / (1024 * 1024), "MB");
}
```

This function is used internally by the `Runnable` class when falling back to Node.js child_process.

## Implementation Details

### C++ Components

- **JudgeWorker**: N-API AsyncWorker that manages the execution on a worker thread
- **ProcessContext**: Holds process state, handles, timers, and results
- **Memory sampling**: Platform-specific implementations for Windows and Linux
- **libuv integration**: Uses `uv_process_t`, `uv_pipe_t`, and `uv_timer_t` for async operations

### Key Differences from Node.js child_process

1. **Blocking behavior**: The addon runs in a worker thread and blocks on `uv_run()`, preventing interference with the Node.js event loop
2. **Memory tracking**: Native memory stats are sampled at 100ms intervals using platform APIs
3. **Complete capture**: Stdout/stderr are fully captured before returning (no streaming)
4. **Precise timing**: High-resolution timing via `uv_hrtime()`

### Platform Support

- **Linux**: Full support with `/proc/<pid>/status` memory tracking
- **Windows**: Full support with Windows Job Objects for automatic limit enforcement and peak memory tracking
  - **Job Object Limitations**: The addon optimistically creates job objects for memory/time limit enforcement. In rare scenarios, job object creation may fail:
    1. **Nested jobs in CI/CD**: If VS Code runs in a job that disallows breakaway, child processes cannot join new jobs (common in CI/CD: GitHub Actions, Azure Pipelines)
    2. **Resource exhaustion**: System runs out of job object handles (extremely rare)
    3. **Permission restrictions**: Restricted security contexts in enterprise environments
  - **Failure behavior**: If job objects fail, the addon continues without OS-level memory enforcement on Windows. For desktop competitive programming use, these scenarios are unlikely.
- **Other platforms**: Basic support without native memory tracking

## Performance

The addon provides better performance characteristics for the Judge/Stress testing workflows:

- No Node.js event loop contention during long-running compilations
- More accurate memory tracking via native APIs
- Lower overhead for stdio capture
- Better timeout precision

## Fallback Behavior

If the addon fails to load or isn't available:

- The `Runnable` class automatically uses Node.js `child_process.spawn()` for process execution
- Memory sampling attempts to use the addon's `getMemoryStats()` function if available
- If the addon is completely unavailable, falls back to the `pidusage` npm package
- Functionality remains identical from the caller's perspective
- A warning is logged explaining why the addon isn't available

## Migration from Separate Memory Addons

This addon replaces the previous `linux-memory-stats.node` and `win32-memory-stats.node` addons:

- **Before**: Separate addons for Linux and Windows memory stats, plus Node.js child_process
- **After**: Single unified `judge.node` addon for both process execution and memory stats
- **Benefits**: Reduced build complexity, unified codebase, better integration, smaller bundle size

The old memory stats addons are deprecated and no longer built. All functionality has been consolidated into the judge addon.
