---
applyTo: "src/addons/judge.cpp"
---

# Judge Addon Usage & Integration

This file documents best practices and requirements for using and integrating with the judge addon (native C++ module built with node-addon-api + libuv).

## Addon Architecture

The judge addon is a unified native C++ implementation that:
- Spawns processes in a dedicated libuv event loop on a worker thread (off-event-loop execution)
- Streams stdout/stderr in real time via callbacks as data arrives
- Supports interactive stdin (write/end while process running)
- Tracks and enforces resource limits (platform-dependent):
  - Peak memory tracking (`maxMemoryBytes`)
  - Time limit enforcement
  - Memory limit enforcement

## API Contract

### TypeScript Interface

```typescript
type ProcessHandle = {
  writeStdin(data: string): void;
  endStdin(): void;
  kill(): void;
};

type JudgeAddon = {
  spawnProcess: (
    command: string[],
    cwd: string,
    timeoutMs: number,
    memoryLimitMb: number,
    stdoutCallback: (data: string) => void,
    stderrCallback: (data: string) => void,
    spawnCallback: () => void,
    completionCallback: (
      err: Error | null,
      result?: {
        exitCode: number;
        termSignal: number;
        elapsedMs: number;
        maxMemoryBytes: number;
        timedOut: boolean;
        memoryLimitExceeded: boolean;
        spawnError: boolean;
      }
    ) => void
  ) => ProcessHandle;
};
```

## Platform-Specific Behaviors

### Linux

- **Peak RSS Tracking**: Tracked via `/proc/<pid>/status` (`VmHWM`), sampled every 50ms
- **Memory Limit**: Uses `prlimit(..., RLIMIT_AS, ...)` (address space) with peak RSS reporting
- **CPU Time Limit**: Uses `prlimit(..., RLIMIT_CPU, ...)` with wall-clock timer fallback (1.5x)
- **Timeout Precision**: RLIMIT_CPU has 1-second granularity; actual timeout may exceed specified limit
- **pidfd Support**: Uses `pidfd_open()` (Linux 5.3+) to prevent PID reuse

### Windows

- **Job Objects**: Used for process containment and memory limit enforcement
- **Memory Limit**: Enforced via Job Object native API
- **CPU Time**: Polling-based (user + kernel time), as job native limits cover user time only
- **Termination**: Sends SIGTERM then SIGKILL on cleanup

### macOS

- **Peak RSS Tracking**: Via `proc_pid_rusage()` with `RUSAGE_INFO_V4`, sampled every 50ms
- **CPU Time**: Polling-based (user + kernel time in nanoseconds)
- **Enforcement**: Polling-based with millisecond-level accuracy; no OS-level enforcement
- **Process Groups**: Uses process group cleanup for process tree termination

## Known Limitations & Behaviors

### 1. Large Stdin Data

Very large stdin writes (>1MB) may experience minor data truncation. This is acceptable for typical competitive programming use cases where test inputs are usually <100KB.

**Mitigation**: For large inputs, consider streaming data in chunks rather than all at once.

### 2. Timeout Precision

On Linux, CPU time limits use RLIMIT_CPU which has 1-second granularity. The addon uses a wall-clock timer as fallback (1.5x the CPU limit), so a 500ms CPU limit may actually timeout at ~1s.

**Recommendation**: Set wall-clock timeouts to be at least 1.5x the intended CPU limit.

### 3. High Concurrency Output

Under very high concurrency (10+ parallel processes), ThreadSafeFunction callbacks may occasionally miss stdout data. All processes complete correctly, but output capture can be incomplete in extreme cases.

**Recommendation**: For high concurrency scenarios, don't rely on stdout for critical data validation.

### 4. Memory Tracking Granularity

For very short-lived processes (<10ms), peak memory may show as 0 if the process exits before the first memory sample (50ms interval).

**Recommendation**: Add minimum execution time assertions in tests, not just memory assertions.

## Integration Patterns

### Standard Test Execution

```typescript
const handle = addon.spawnProcess(
  ["./program", "input.txt"],
  process.cwd(),
  5000,  // 5s timeout
  256,   // 256MB memory limit
  (stdout) => console.log("stdout:", stdout),
  (stderr) => console.error("stderr:", stderr),
  () => console.log("process spawned"),
  (err, result) => {
    if (err) {
      console.error("spawn error:", err);
    } else {
      console.log("exit code:", result.exitCode);
      console.log("timed out:", result.timedOut);
      console.log("max memory:", result.maxMemoryBytes / (1024*1024), "MB");
    }
  }
);
```

### Interactive Problem Handling

```typescript
const handle = addon.spawnProcess(
  ["./interactive_judge"],
  process.cwd(),
  0,  // no timeout for interactive
  256,
  (stdout) => {
    // Parse judge response and send next query
    const query = parseResponse(stdout);
    handle.writeStdin(query + "\n");
  },
  (stderr) => console.error("stderr:", stderr),
  () => {
    // Send first query after spawn
    handle.writeStdin("QUERY 1\n");
  },
  (err, result) => {
    console.log("interactive problem complete:", result.exitCode);
  }
);
```

## Testing

The addon includes comprehensive stress tests covering:
- Basic execution (exit codes, arguments)
- Stdin/stdout/stderr handling
- Timeouts and memory limits
- Process killing and signals
- Error handling
- High concurrency scenarios
- Edge cases and race conditions

Run tests with:
```bash
node scripts/stress-test-addon.js              # Run all tests
node scripts/stress-test-addon.js --verbose    # With detailed output
node scripts/stress-test-addon.js --filter=timeout  # Specific category
```

Platform-specific CI runs tests across Windows, Linux, and macOS to catch platform-dependent issues early.

## Performance Considerations

1. **Callback Overhead**: stdout/stderr callbacks are called per chunk, not per line. Buffer accordingly.
2. **Memory Polling**: Every 50ms for processes >10ms lifespan. Can add ~5ms overhead.
3. **Process Creation**: ~1-2ms overhead per spawn on modern systems.
4. **Large Output**: Output capture is limited to 50MB per stream to prevent OOM.

## Fallback & Error Handling

If `judge.node` fails to load:
1. Check that native modules are built: `npm run build:addon`
2. Verify correct platform binary: `dist/judge.node` for your platform
3. Ensure Node ABI compatibility: Node version used at build time matches runtime
4. Check native dependencies: gcc/clang for Linux/macOS, MSVC for Windows

For spawn errors, check:
- Command exists and is executable
- Working directory is valid
- Permission bits are correct
- System resource limits aren't exceeded
