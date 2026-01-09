# Judge Addon Usage

The judge addon is a unified native C++ implementation (built with node-addon-api + libuv). It spawns processes, streams stdout/stderr in real time, supports interactive stdin, and (where implemented) tracks/enforces resource limits.

## Features

- **Off-event-loop execution**: process spawning and monitoring run in a dedicated libuv loop on a worker thread
- **Streaming stdio**: stdout/stderr are delivered via callbacks as data arrives
- **Interactive stdin**: write/end stdin while the process is running
- **Resource limits (platform-dependent)**:
  - peak memory tracking (`maxMemoryBytes`)
  - time limit enforcement
  - memory limit enforcement

## API

### Building the addon

```bash
npm run build:addon
```

This builds `build/Release/judge.node` (see `binding.gyp`).

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

runnable.on("spawn", () => {
  runnable.process?.stdin.write("QUERY 1\n");
});

runnable.on("stdout:data", (data) => {
  console.log("Response:", data);
  runnable.process?.stdin.write("QUERY 2\n");
});

await runnable.done;
```

## Implementation Notes

- Memory tracking is **peak memory** (`maxMemoryBytes`), not current RSS.
- Memory/time enforcement is implemented in the native addon where available; other platforms may currently run without enforcement.

## Platform Support

- **Linux**:
  - Peak RSS tracked via `/proc/<pid>/status` (`VmHWM`). Sampled periodically (every 50ms) and read once at process exit.
  - Memory limit enforcement uses `prlimit(..., RLIMIT_AS, ...)` (address space), plus best-effort peak RSS reporting.
  - CPU time limit uses `prlimit(..., RLIMIT_CPU, ...)` and a wall-clock timer is used as a safety net.
- **Windows**:
  - Uses Job Objects for containment + memory limit enforcement.
  - Enforces _total_ CPU time (user + kernel) by polling Job Object accounting and terminating the job when the sum exceeds `timeoutMs`.
  - **Job Object limitation**: built-in job time limits cover user time only, which is why polling is used.
- **macOS (darwin)**:
  - Peak RSS tracked via `proc_pid_rusage()` with `RUSAGE_INFO_V4`. Sampled periodically (every 50ms) and read once at process exit.
  - CPU time tracking uses `proc_pid_rusage()` polling (user + kernel time in nanoseconds).
  - Both CPU and memory limits enforced by polling and sending `SIGKILL` when limits exceeded.
  - No OS-level enforcement (macOS lacks `prlimit()` and Job Object equivalents), but polling-based approach provides millisecond-level accuracy.

## Fallback Behavior

Currently, `Runnable` expects `judge.node` to be available. If you later add a pure-JS fallback (e.g. `child_process.spawn` + sampling), document it here.

## VS Code Platform Scope

For desktop VS Code (non-web), targeting these OSes covers the supported platforms:

- Windows (`win32`)
- Linux (`linux`)
- macOS (`darwin`)

You’ll still need to consider CPU architectures (e.g. `x64` and `arm64`) if distributing prebuilt binaries.
