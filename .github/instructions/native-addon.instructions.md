---
applyTo: "src/addons/**/*.cpp"
---

This repo includes **platform-specific** native addons used for efficient process execution and monitoring. These addons replace Node.js `child_process` for running user code to strictly enforce time and memory limits and provide accurate resource usage statistics.

- **Windows:** `win32-process-monitor` – uses **Job Objects** and efficient completion ports/events.
- **Linux:** `linux-process-monitor` – uses **pidfd** (kernel 5.3+) and polling for memory limits.
- **macOS:** `darwin-process-monitor` – uses **kqueue** for process events and **proc_pid_rusage** for accurate stats.

When working on these files:

### 1. Unified Spawn & Monitor
The addons export a `spawn` function that handles the entire lifecycle:
-   **Spawning**: Forks/Creates the process with the correct flags (e.g., suspended on Windows).
-   **Limits**: Enforces Time and Memory limits natively.
    -   *Windows*: Job Object limits (Hard enforcement).
    -   *Linux/macOS*: Polling (50ms interval) for memory; `SIGXCPU` / wall-clock checks for time.
-   **Waiting**: Uses non-blocking OS primitives (`pidfd_open`+`poll`, `kqueue`, `WaitForMultipleObjects`) in a `Napi::AsyncWorker`.
-   **IPC**: Communicates stdio via Named Pipes (Windows) or Unix Sockets (Linux/macOS) established *before* execution.

### 2. Platform Implementation Details (Parity Required)
Functionality must be consistent across all three platforms.

#### Linux (`linux-process-monitor.cpp`)
-   **Mechanism**: Uses `pidfd_open` (available in Linux 5.3+) to avoid PID reuse races.
-   **Memory**: Polls `/proc/[pid]/status` for `VmHWM` (Peak Resident Set Size). This is preferred over `RLIMIT_AS` which is unreliable for V8/Node runtimes.
-   **Zombie Handling**: MUST capture `VmHWM` *before* reaping the zombie logic, as the entry disappears or resets after `wait4`.

#### macOS (`darwin-process-monitor.cpp`)
-   **Mechanism**: Uses `kqueue` with `EVFILT_PROC` (for exit) and `EVFILT_USER` (for cancellation).
-   **Stats**: Uses `proc_pid_rusage` to get `phys_footprint` (most accurate memory metric) and nanosecond-precision CPU time.
-   **Timebase**: Handles Mach absolute time conversion for Apple Silicon correctness.

#### Windows (`win32-process-monitor.cpp`)
-   **Mechanism**: Uses **Job Objects** to group the process. This allows the OS to automatically terminate the process if it exceeds hard memory/CPU limits.
-   **Unicode**: usage of Wide String APIs (`CreateProcessW`, `std::wstring`) is mandatory.

### 3. Runtime Integration (`src/extension/utils/runtime.ts`)
-   The `Runnable` class delegates execution entirely to the native addon when available.
-   **No Fallback**: Unlike previous versions, we do *not* fallback to `child_process` + `pidusage` for these heavy tasks, as strict limit enforcement is required.
-   **Cancellation**: The addon exposes a `cancel()` function that sets an event/writes to a generic FD to wake up the worker thread immediately.

### 4. Build & Distribution
-   **Commands**: `npm run build:addon` builds via `node-gyp`.
-   **CI**: GitHub Actions builds the specific addon for the target platform (Linux/Windows/macOS) during the VSIX packaging step.
-   **Bundling**: `rspack.config.ts` copies the appropriate `.node` file to `dist/` based on the generic platform.

### 5. Code Style
-   **Safety**: Always check return codes (`errno`, `GetLastError`) and return meaningful errors to JS.
-   **Non-blocking**: Changes must preserve the asynchronous nature of the worker. Never block the main thread.
-   **Memory**: Use `std::shared_ptr` for state shared between the main thread (cancellation) and the worker thread.
