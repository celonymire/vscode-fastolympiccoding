---
applyTo: "src/addons/**/*.cpp"
---

## Purpose

Platform-specific native addons for strict process execution with:

- Hard time and memory limit enforcement
- Accurate resource usage statistics
- Non-blocking execution via Node.js Async Workers

## Platform Implementations

### Linux (`linux-process-monitor.cpp`)

- Uses `pidfd_open` (kernel 5.3+) to avoid PID reuse races
- Polls `/proc/[pid]/status` for `VmHWM` (Peak Resident Set Size)
- **Critical**: Capture `VmHWM` before reaping zombie; values disappear after `wait4`
- Memory enforcement via polling (10ms interval), not `RLIMIT_AS`
- Uses `eventfd` to signal and wake the worker thread for cancellation

### macOS (`darwin-process-monitor.cpp`)

- Uses `kqueue` with `EVFILT_PROC` (exit events) and `EVFILT_USER` (cancellation)
- Uses `proc_pid_rusage` for accurate stats: `phys_footprint` (memory), nanosecond CPU time
- Handles Mach absolute time conversion for Apple Silicon

### Windows (`win32-process-monitor.cpp`)

- Uses **Job Objects** for hard memory/CPU limits (OS-enforced)
- Process created suspended, added to Job, then resumed
- Uses `WaitForMultipleObjects` with a polling loop to handle process exit, cancellation events, and wall-clock timeouts
- **All APIs use Wide Strings** (`CreateProcessW`, `std::wstring`)

## Spawn API

```typescript
// Spawn function signature
// spawn(command, args, cwd, timeoutMs, memoryLimitMB, pipeNameIn, pipeNameOut, pipeNameErr, onSpawn)

interface NativeSpawnResult {
  pid: number;
  result: Promise<AddonResult>;
  cancel: () => void;
}

interface AddonResult {
  elapsedMs: number;
  peakMemoryBytes: number;
  exitCode: number | null;
  timedOut: boolean;
  memoryLimitExceeded: boolean;
  stopped: boolean; // Cancelled
}
```

## IPC

Stdio uses Named Pipes (Windows) or Unix Sockets (Linux/macOS). The extension creates the pipes/sockets and passes their paths to the addon's `spawn` function, which then connects to them internally before executing the child process.

## Cancellation

Each addon exposes a `cancel()` function that:

- Writes to a signal fd / sets an event
- Wakes the worker thread immediately
- Process is terminated, `stopped: true` in result

## Build

- `npm run build:addon`: Builds via node-gyp
- CI builds platform-specific `.node` files during VSIX packaging
- rspack copies the appropriate addon to `dist/`

## Code Guidelines

- Always check return codes (`errno`, `GetLastError`)
- Never block the Node.js main thread
- Use `std::shared_ptr` for state shared between main thread and worker
- Return meaningful errors to JavaScript
