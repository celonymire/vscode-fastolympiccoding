#include <napi.h>
#include <uv.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <signal.h>
#include <string>
#include <vector>

#ifdef __linux__
#include <fcntl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace {

constexpr size_t PIPE_BUFFER_SIZE = 65536;
constexpr uint64_t MEMORY_SAMPLE_INTERVAL_MS = 250;
constexpr uint64_t BYTES_PER_MEGABYTE = 1024 * 1024;

struct ProcessResult {
  int64_t exitCode = 0;
  int termSignal = 0;
  uint64_t elapsedMs = 0;
  uint64_t maxMemoryBytes = 0;
  bool timedOut = false;
  bool memoryLimitExceeded = false;
  bool spawnError = false;
};

// Shared state between ProcessHandle and JudgeWorker
// Uses mutex for thread-safe stdin buffering and async signaling
struct StdinState {
  std::mutex mutex;
  std::string buffer;
  bool closed = false;
  bool killRequested = false;
  std::atomic<bool> workerActive{true};
  uv_async_t *stdinAsync = nullptr; // Set by worker thread
};

struct ProcessContext {
  uv_loop_t *loop = nullptr;
  uv_process_t process = {};
  uv_pipe_t stdinPipe = {};
  uv_pipe_t stdoutPipe = {};
  uv_pipe_t stderrPipe = {};
  uv_timer_t timeoutTimer = {};
  uv_timer_t memoryTimer = {};
  uv_async_t stdinAsync = {};

  ProcessResult result;
  uint64_t startTime = 0;
  uint64_t timeoutMs = 0;
  uint64_t memoryLimitBytes = 0;

  bool processExited = false;
  bool stdinClosed = false;
  bool stdoutClosed = false;
  bool stderrClosed = false;
  bool timeoutTimerActive = false;
  bool memoryTimerActive = false;
  bool stdinAsyncActive = false;
  int closedHandles = 0;
  int totalHandles = 0;

  std::shared_ptr<StdinState> stdinState;

  void (*completionCallback)(ProcessContext *) = nullptr;

  Napi::ThreadSafeFunction stdoutCallback;
  Napi::ThreadSafeFunction stderrCallback;
  Napi::ThreadSafeFunction spawnCallback;

#ifdef __linux__
  int pidfd = -1; // File descriptor for the process (pidfd_open)
#endif

#ifdef _WIN32
  HANDLE jobObject = nullptr;
#endif
};

uint64_t GetMonotonicTimeMs() { return uv_hrtime() / 1000000ULL; }

#ifdef __linux__
// Wrapper for pidfd_open syscall (available since Linux 5.3)
// Returns a file descriptor that refers to the process
static int pidfd_open(pid_t pid, unsigned int flags) {
  return static_cast<int>(syscall(SYS_pidfd_open, pid, flags));
}

// Read peak RSS (high-water mark) from /proc/{pid}/status
// Returns peak resident set size in bytes
static uint64_t ReadProcessPeakMemory(int pid) {
  char path[64];
  std::snprintf(path, sizeof(path), "/proc/%d/status", pid);

  int fd = open(path, O_RDONLY);
  if (fd < 0) {
    return 0;
  }

  char buffer[4096];
  ssize_t bytesRead = read(fd, buffer, sizeof(buffer) - 1);
  close(fd);

  if (bytesRead < 0) {
    return 0;
  }
  buffer[bytesRead] = '\0';

  // Look for VmHWM (peak resident set size)
  char *line = buffer;
  char *end = buffer + bytesRead;

  while (line < end) {
    char *lineEnd = (char *)memchr(line, '\n', end - line);
    if (!lineEnd)
      lineEnd = end;

    if (lineEnd - line > 6 && strncmp(line, "VmHWM:", 6) == 0) {
      const char *p = line + 6;
      while (p < lineEnd && (*p == ' ' || *p == '\t'))
        ++p;
      unsigned long long kb = strtoull(p, nullptr, 10);
      return kb * 1024ULL;
    }

    line = lineEnd + 1;
  }

  return 0;
}
#endif

#ifdef _WIN32
#include <psapi.h>
#include <windows.h>

static uint64_t JobTotalCpuTimeMs(HANDLE jobObject) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accountingInfo = {};
  DWORD returnLength = 0;
  if (!QueryInformationJobObject(jobObject, JobObjectBasicAccountingInformation,
                                 &accountingInfo, sizeof(accountingInfo),
                                 &returnLength)) {
    return 0;
  }

  const uint64_t total100ns =
      static_cast<uint64_t>(accountingInfo.TotalUserTime.QuadPart) +
      static_cast<uint64_t>(accountingInfo.TotalKernelTime.QuadPart);
  return total100ns / 10000ULL;
}
#endif

void AllocBuffer(uv_handle_t *handle, size_t suggested_size, uv_buf_t *buf) {
  buf->base = new char[PIPE_BUFFER_SIZE];
  buf->len = PIPE_BUFFER_SIZE;
}

// Forward declaration
void OnHandleClose(uv_handle_t *handle);

void OnStdoutRead(uv_stream_t *stream, ssize_t nread, const uv_buf_t *buf) {
  auto *ctx = static_cast<ProcessContext *>(stream->data);

  if (nread > 0) {
    std::string data(buf->base, static_cast<size_t>(nread));

    if (ctx->stdoutCallback) {
      ctx->stdoutCallback.NonBlockingCall(
          [data](Napi::Env env, Napi::Function jsCallback) {
            jsCallback.Call({Napi::String::New(env, data)});
          });
    }
  } else if (nread < 0) {
    if (!ctx->stdoutClosed) {
      ctx->stdoutClosed = true;
      uv_close(reinterpret_cast<uv_handle_t *>(stream), OnHandleClose);
    }
  }

  if (buf->base) {
    delete[] buf->base;
  }
}

void OnStderrRead(uv_stream_t *stream, ssize_t nread, const uv_buf_t *buf) {
  auto *ctx = static_cast<ProcessContext *>(stream->data);

  if (nread > 0) {
    std::string data(buf->base, static_cast<size_t>(nread));

    if (ctx->stderrCallback) {
      ctx->stderrCallback.NonBlockingCall(
          [data](Napi::Env env, Napi::Function jsCallback) {
            jsCallback.Call({Napi::String::New(env, data)});
          });
    }
  } else if (nread < 0) {
    if (!ctx->stderrClosed) {
      ctx->stderrClosed = true;
      uv_close(reinterpret_cast<uv_handle_t *>(stream), OnHandleClose);
    }
  }

  if (buf->base) {
    delete[] buf->base;
  }
}

void OnStdinWrite(uv_write_t *req, int status) {
  delete[] static_cast<char *>(req->data);
  delete req;
}

void OnTimeoutTimerFired(uv_timer_t *timer) {
  auto *ctx = static_cast<ProcessContext *>(timer->data);
  if (!ctx->processExited) {
    ctx->result.timedOut = true;
#ifdef _WIN32
    if (ctx->jobObject) {
      TerminateJobObject(ctx->jobObject, 1);
    } else {
      uv_process_kill(&ctx->process, SIGTERM);
    }
#else
    uv_process_kill(&ctx->process, SIGKILL);
#endif
  }
}

#ifdef _WIN32
void OnWindowsCpuTimerTick(uv_timer_t *timer) {
  auto *ctx = static_cast<ProcessContext *>(timer->data);
  if (!ctx || ctx->processExited || ctx->timeoutMs == 0) {
    return;
  }
  if (!ctx->jobObject) {
    return;
  }

  const uint64_t cpuMs = JobTotalCpuTimeMs(ctx->jobObject);
  if (cpuMs >= ctx->timeoutMs) {
    ctx->result.timedOut = true;
    TerminateJobObject(ctx->jobObject, 1);
  }
}
#endif

void OnMemoryTimerTick(uv_timer_t *timer) {
  auto *ctx = static_cast<ProcessContext *>(timer->data);
  if (ctx->processExited) {
    return;
  }

  uint64_t currentMem = ReadProcessPeakMemory(ctx->process.pid);
  if (currentMem > ctx->result.maxMemoryBytes) {
    ctx->result.maxMemoryBytes = currentMem;
  }
}

// Called on worker thread when stdin data is available or kill is requested
void OnStdinAsync(uv_async_t *handle) {
  auto *ctx = static_cast<ProcessContext *>(handle->data);
  if (!ctx || !ctx->stdinState) {
    return;
  }

  std::string dataToWrite;
  bool shouldClose = false;
  bool shouldKill = false;

  {
    std::lock_guard<std::mutex> lock(ctx->stdinState->mutex);
    dataToWrite = std::move(ctx->stdinState->buffer);
    ctx->stdinState->buffer.clear();
    shouldClose = ctx->stdinState->closed;
    shouldKill = ctx->stdinState->killRequested;
  }

  // Handle kill request
  if (shouldKill && !ctx->processExited) {
    uv_process_kill(&ctx->process, SIGKILL);
    return;
  }

  // Write buffered data to stdin
  if (!dataToWrite.empty() && !ctx->stdinClosed) {
    auto *buf = new char[dataToWrite.size()];
    std::memcpy(buf, dataToWrite.data(), dataToWrite.size());

    auto *writeReq = new uv_write_t;
    writeReq->data = buf;

    uv_buf_t uvBuf =
        uv_buf_init(buf, static_cast<unsigned int>(dataToWrite.size()));
    uv_write(writeReq, reinterpret_cast<uv_stream_t *>(&ctx->stdinPipe), &uvBuf,
             1, OnStdinWrite);
  }

  // Close stdin if requested
  if (shouldClose && !ctx->stdinClosed) {
    ctx->stdinClosed = true;
    uv_close(reinterpret_cast<uv_handle_t *>(&ctx->stdinPipe), OnHandleClose);
  }
}

void TryComplete(ProcessContext *ctx) {
  if (ctx->closedHandles >= ctx->totalHandles && ctx->processExited) {
    if (ctx->completionCallback) {
      ctx->completionCallback(ctx);
    }
  }
}

void OnHandleClose(uv_handle_t *handle) {
  auto *ctx = static_cast<ProcessContext *>(handle->data);
  ctx->closedHandles++;
  TryComplete(ctx);
}

void OnProcessExit(uv_process_t *process, int64_t exit_status,
                   int term_signal) {
  auto *ctx = static_cast<ProcessContext *>(process->data);
  ctx->processExited = true;
  ctx->result.exitCode = exit_status;
  ctx->result.termSignal = term_signal;
  ctx->result.elapsedMs = GetMonotonicTimeMs() - ctx->startTime;

#ifdef _WIN32
  // On Windows, get peak memory from job object
  if (ctx->jobObject) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION extendedInfo = {};
    DWORD returnLength = 0;

    if (QueryInformationJobObject(
            ctx->jobObject, JobObjectExtendedLimitInformation, &extendedInfo,
            sizeof(extendedInfo), &returnLength)) {
      ctx->result.maxMemoryBytes = extendedInfo.PeakProcessMemoryUsed;
    }
  }
#else
  // On Linux, we've been tracking memory via periodic polling
  // Final check: read one more time
  uint64_t finalMem = ReadProcessPeakMemory(ctx->process.pid);
  if (finalMem > ctx->result.maxMemoryBytes) {
    ctx->result.maxMemoryBytes = finalMem;
  }

  // Close the pidfd
  if (ctx->pidfd >= 0) {
    close(ctx->pidfd);
    ctx->pidfd = -1;
  }

  // Check if process was killed by resource limits
  if (term_signal == SIGKILL && ctx->timeoutMs > 0) {
    // RLIMIT_CPU sends SIGKILL when CPU time limit is exceeded
    ctx->result.timedOut = true;
  }

  if (term_signal == SIGKILL && ctx->memoryLimitBytes > 0 &&
      ctx->result.maxMemoryBytes > ctx->memoryLimitBytes) {
    ctx->result.memoryLimitExceeded = true;
  }
#endif

#ifdef _WIN32
  // Check if process was terminated by job object limits
  constexpr int64_t STATUS_COMMITMENT_LIMIT = 0xC000012D;

  if (ctx->jobObject) {
    // Query job accounting information to determine which limit was hit
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accountingInfo = {};
    DWORD returnLength = 0;

    if (QueryInformationJobObject(
            ctx->jobObject, JobObjectBasicAccountingInformation,
            &accountingInfo, sizeof(accountingInfo), &returnLength)) {

      // Check if process time limit was exceeded
      if (ctx->timeoutMs > 0) {
        uint64_t processMsTime = JobTotalCpuTimeMs(ctx->jobObject);

        // If process time is close to or exceeds the limit, it was time-limited
        if (processMsTime >= ctx->timeoutMs * 95 / 100) {
          ctx->result.timedOut = true;
        }
      }
    }

    // Memory limit violation has a specific exit code
    if (exit_status == STATUS_COMMITMENT_LIMIT) {
      ctx->result.memoryLimitExceeded = true;
    }

    CloseHandle(ctx->jobObject);
    ctx->jobObject = nullptr;
  }
#endif

  uv_close(reinterpret_cast<uv_handle_t *>(&ctx->process), OnHandleClose);

  // Close the stdin async handle
  if (ctx->stdinAsyncActive) {
    uv_close(reinterpret_cast<uv_handle_t *>(&ctx->stdinAsync), OnHandleClose);
  } else {
    ctx->totalHandles--;
  }

  // Only close stdin if not already closed
  if (!ctx->stdinClosed) {
    ctx->stdinClosed = true;
    uv_close(reinterpret_cast<uv_handle_t *>(&ctx->stdinPipe), OnHandleClose);
  } else {
    ctx->totalHandles--;
  }

  // Close timers if active
  if (ctx->timeoutTimerActive) {
    uv_close(reinterpret_cast<uv_handle_t *>(&ctx->timeoutTimer),
             OnHandleClose);
  } else {
    ctx->totalHandles--;
  }

  if (ctx->memoryTimerActive) {
    uv_close(reinterpret_cast<uv_handle_t *>(&ctx->memoryTimer), OnHandleClose);
  } else {
    ctx->totalHandles--;
  }

  // Only close stdout/stderr if not already closed by EOF
  if (!ctx->stdoutClosed) {
    ctx->stdoutClosed = true;
    uv_close(reinterpret_cast<uv_handle_t *>(&ctx->stdoutPipe), OnHandleClose);
  } else {
    // Already closed and counted, so we need fewer handles to wait for
    ctx->totalHandles--;
  }
  if (!ctx->stderrClosed) {
    ctx->stderrClosed = true;
    uv_close(reinterpret_cast<uv_handle_t *>(&ctx->stderrPipe), OnHandleClose);
  } else {
    ctx->totalHandles--;
  }

  // Release thread-safe functions
  if (ctx->stdoutCallback) {
    ctx->stdoutCallback.Release();
  }
  if (ctx->stderrCallback) {
    ctx->stderrCallback.Release();
  }
  // spawnCallback is released immediately after use, not here
}

} // namespace

class JudgeWorker : public Napi::AsyncWorker {
private:
  std::vector<std::string> command_;
  std::string cwd_;
  uint64_t timeoutMs_;
  uint64_t memoryLimitMb_;
  std::unique_ptr<ProcessContext> ctx_;
  std::shared_ptr<StdinState> stdinState_;

public:
  JudgeWorker(Napi::Function &callback, const std::vector<std::string> &command,
              const std::string &cwd, uint64_t timeoutMs,
              uint64_t memoryLimitMb, Napi::ThreadSafeFunction stdoutCallback,
              Napi::ThreadSafeFunction stderrCallback,
              Napi::ThreadSafeFunction spawnCallback,
              std::shared_ptr<StdinState> stdinState)
      : Napi::AsyncWorker(callback), command_(command), cwd_(cwd),
        timeoutMs_(timeoutMs), memoryLimitMb_(memoryLimitMb),
        ctx_(std::make_unique<ProcessContext>()), stdinState_(stdinState) {
    ctx_->stdoutCallback = stdoutCallback;
    ctx_->stderrCallback = stderrCallback;
    ctx_->spawnCallback = spawnCallback;
  }

  ~JudgeWorker() override {
    // Mark worker as inactive so ProcessHandle won't try to access it
    if (stdinState_) {
      stdinState_->workerActive.store(false);
    }
  }

  void Execute() override {
    ctx_->loop = uv_loop_new();
    if (!ctx_->loop) {
      SetError("Failed to create event loop");
      return;
    }

    ctx_->memoryLimitBytes = memoryLimitMb_ * BYTES_PER_MEGABYTE;
    ctx_->timeoutMs = timeoutMs_;

    std::vector<char *> args;
    std::vector<std::unique_ptr<char[]>> argStorage;

    for (const auto &arg : command_) {
      auto argCopy = std::make_unique<char[]>(arg.size() + 1);
      std::strcpy(argCopy.get(), arg.c_str());
      args.push_back(argCopy.get());
      argStorage.push_back(std::move(argCopy));
    }
    args.push_back(nullptr);

    uv_pipe_init(ctx_->loop, &ctx_->stdinPipe, 0);
    uv_pipe_init(ctx_->loop, &ctx_->stdoutPipe, 0);
    uv_pipe_init(ctx_->loop, &ctx_->stderrPipe, 0);

    ctx_->stdinPipe.data = ctx_.get();
    ctx_->stdoutPipe.data = ctx_.get();
    ctx_->stderrPipe.data = ctx_.get();
    ctx_->process.data = ctx_.get();
    ctx_->timeoutTimer.data = ctx_.get();
    ctx_->memoryTimer.data = ctx_.get();

    uv_stdio_container_t stdio[3];
    stdio[0].flags =
        static_cast<uv_stdio_flags>(UV_CREATE_PIPE | UV_READABLE_PIPE);
    stdio[0].data.stream = reinterpret_cast<uv_stream_t *>(&ctx_->stdinPipe);
    stdio[1].flags =
        static_cast<uv_stdio_flags>(UV_CREATE_PIPE | UV_WRITABLE_PIPE);
    stdio[1].data.stream = reinterpret_cast<uv_stream_t *>(&ctx_->stdoutPipe);
    stdio[2].flags =
        static_cast<uv_stdio_flags>(UV_CREATE_PIPE | UV_WRITABLE_PIPE);
    stdio[2].data.stream = reinterpret_cast<uv_stream_t *>(&ctx_->stderrPipe);

    uv_process_options_t options = {};
    options.exit_cb = OnProcessExit;
    options.file = args[0];
    options.args = args.data();
    options.cwd = cwd_.empty() ? nullptr : cwd_.c_str();
    options.stdio_count = 3;
    options.stdio = stdio;
    options.flags =
        UV_PROCESS_WINDOWS_HIDE | UV_PROCESS_WINDOWS_VERBATIM_ARGUMENTS;

    ctx_->startTime = GetMonotonicTimeMs();

    int r = uv_spawn(ctx_->loop, &ctx_->process, &options);
    if (r < 0) {
      ctx_->result.spawnError = true;
      std::string errorMessage = std::string("Spawn failed: ") + uv_strerror(r);

      // Send spawn error to stderr
      if (ctx_->stderrCallback) {
        ctx_->stderrCallback.NonBlockingCall(
            [errorMessage](Napi::Env env, Napi::Function jsCallback) {
              jsCallback.Call({Napi::String::New(env, errorMessage)});
            });
        ctx_->stderrCallback.Release();
      }
      if (ctx_->stdoutCallback) {
        ctx_->stdoutCallback.Release();
      }
      // spawnCallback never called in error case, release it here
      if (ctx_->spawnCallback) {
        ctx_->spawnCallback.Release();
      }

      // Close the pipes we initialized and run until closed
      uv_close(reinterpret_cast<uv_handle_t *>(&ctx_->stdinPipe), nullptr);
      uv_close(reinterpret_cast<uv_handle_t *>(&ctx_->stdoutPipe), nullptr);
      uv_close(reinterpret_cast<uv_handle_t *>(&ctx_->stderrPipe), nullptr);

      // Run until all handles are processed
      while (uv_run(ctx_->loop, UV_RUN_ONCE) != 0) {
        // Keep running
      }

      // Close and free the loop
      uv_loop_close(ctx_->loop);
      free(ctx_->loop);
      ctx_->loop = nullptr;
      return;
    }

#ifdef __linux__
    // Open a pidfd to prevent PID reuse
    ctx_->pidfd = pidfd_open(ctx_->process.pid, 0);

    // Start wall clock timeout timer if timeout is specified
    if (ctx_->timeoutMs > 0) {
      uint64_t wallTimeoutMs = ctx_->timeoutMs;
      if (wallTimeoutMs <= (UINT64_MAX / 2)) {
        wallTimeoutMs *= 2;
      }
      uv_timer_init(ctx_->loop, &ctx_->timeoutTimer);
      ctx_->timeoutTimer.data = ctx_.get();
      uv_timer_start(&ctx_->timeoutTimer, OnTimeoutTimerFired, wallTimeoutMs,
                     0);
      ctx_->timeoutTimerActive = true;
    }

    // Start memory polling timer
    uv_timer_init(ctx_->loop, &ctx_->memoryTimer);
    ctx_->memoryTimer.data = ctx_.get();
    uv_timer_start(&ctx_->memoryTimer, OnMemoryTimerTick, 0,
                   MEMORY_SAMPLE_INTERVAL_MS);
    ctx_->memoryTimerActive = true;

    // Use prlimit() to set resource limits on the child process
    //
    // Why prlimit() instead of setrlimit()?
    // - setrlimit() only affects the calling process (this parent process)
    // - prlimit() can set limits on ANY process by PID
    // - We spawn the child first, then immediately set its limits from the
    // parent
    // - This is cleaner than fork+setrlimit+exec pattern
    //
    if (ctx_->memoryLimitBytes > 0) {
      struct rlimit rlim;
      rlim.rlim_cur = ctx_->memoryLimitBytes;
      rlim.rlim_max = ctx_->memoryLimitBytes;
      prlimit(ctx_->process.pid, RLIMIT_AS, &rlim, nullptr);
    }

    if (ctx_->timeoutMs > 0) {
      struct rlimit rlim;
      // RLIMIT_CPU is in seconds, convert from milliseconds (round up)
      rlim.rlim_cur = (ctx_->timeoutMs + 999) / 1000;
      rlim.rlim_max = rlim.rlim_cur;
      prlimit(ctx_->process.pid, RLIMIT_CPU, &rlim, nullptr);
    }
#endif

#ifdef _WIN32
    // Create job object for limit enforcement on Windows
    if (ctx_->memoryLimitBytes > 0 || ctx_->timeoutMs > 0) {
      ctx_->jobObject = CreateJobObjectW(nullptr, nullptr);
      if (ctx_->jobObject) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobLimits = {};
        jobLimits.BasicLimitInformation.LimitFlags = 0;

        if (ctx_->memoryLimitBytes > 0) {
          jobLimits.BasicLimitInformation.LimitFlags |=
              JOB_OBJECT_LIMIT_PROCESS_MEMORY;
          jobLimits.ProcessMemoryLimit = ctx_->memoryLimitBytes;
        }

        if (ctx_->timeoutMs > 0) {
          jobLimits.BasicLimitInformation.LimitFlags |=
              JOB_OBJECT_LIMIT_JOB_TIME;
          // Convert ms to 100-nanosecond intervals
          jobLimits.BasicLimitInformation.PerJobUserTimeLimit.QuadPart =
              static_cast<LONGLONG>(ctx_->timeoutMs) * 10000LL;
        }

        // Terminate process on limit violation
        jobLimits.BasicLimitInformation.LimitFlags |=
            JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;

        SetInformationJobObject(ctx_->jobObject,
                                JobObjectExtendedLimitInformation, &jobLimits,
                                sizeof(jobLimits));

        // Assign process to job
        HANDLE hProcess = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                                      FALSE, ctx_->process.pid);
        if (hProcess) {
          AssignProcessToJobObject(ctx_->jobObject, hProcess);
          CloseHandle(hProcess);
        }

        // Enforce total CPU time (user + kernel). Job time limit only enforces
        // user time, so we poll job accounting and terminate when total exceeds
        // the configured CPU-time limit.
        if (ctx_->timeoutMs > 0) {
          uv_timer_init(ctx_->loop, &ctx_->timeoutTimer);
          ctx_->timeoutTimer.data = ctx_.get();
          uv_timer_start(&ctx_->timeoutTimer, OnWindowsCpuTimerTick, 0, 100);
          ctx_->timeoutTimerActive = true;
        }
      }
    }
#endif

    uv_read_start(reinterpret_cast<uv_stream_t *>(&ctx_->stdoutPipe),
                  AllocBuffer, OnStdoutRead);
    uv_read_start(reinterpret_cast<uv_stream_t *>(&ctx_->stderrPipe),
                  AllocBuffer, OnStderrRead);

    // Set up async handle for real-time stdin writes from main thread
    ctx_->stdinState = stdinState_;
    uv_async_init(ctx_->loop, &ctx_->stdinAsync, OnStdinAsync);
    ctx_->stdinAsync.data = ctx_.get();
    ctx_->stdinAsyncActive = true;

    // Update stdinState to point to our async handle so main thread can signal
    {
      std::lock_guard<std::mutex> lock(stdinState_->mutex);
      stdinState_->stdinAsync = &ctx_->stdinAsync;
    }

    // Process any stdin data that was buffered before spawn
    std::string stdinData;
    bool shouldCloseStdin = false;
    {
      std::lock_guard<std::mutex> lock(stdinState_->mutex);
      stdinData = std::move(stdinState_->buffer);
      stdinState_->buffer.clear();
      shouldCloseStdin = stdinState_->closed;
    }

    // Write any buffered stdin data
    if (!stdinData.empty()) {
      auto *buf = new char[stdinData.size()];
      std::memcpy(buf, stdinData.data(), stdinData.size());

      auto *writeReq = new uv_write_t;
      writeReq->data = buf;

      uv_buf_t uvBuf =
          uv_buf_init(buf, static_cast<unsigned int>(stdinData.size()));
      uv_write(writeReq, reinterpret_cast<uv_stream_t *>(&ctx_->stdinPipe),
               &uvBuf, 1, OnStdinWrite);
    }

    // Close stdin if it was closed before spawn
    if (shouldCloseStdin) {
      ctx_->stdinClosed = true;
      uv_close(reinterpret_cast<uv_handle_t *>(&ctx_->stdinPipe),
               OnHandleClose);
    }

    // Fire spawn callback to notify main thread that process is ready
    if (ctx_->spawnCallback) {
      ctx_->spawnCallback.NonBlockingCall(
          [](Napi::Env env, Napi::Function jsCallback) {
            jsCallback.Call({});
          });
      // Release immediately after calling since it's only used once
      ctx_->spawnCallback.Release();
    }

    // Update totalHandles: process, stdinAsync, stdin, stdout, stderr (5 total)
    // Count handles: process, stdinAsync, stdin, stdout, stderr, timeoutTimer,
    // memoryTimer
    ctx_->totalHandles = 7;

    uv_run(ctx_->loop, UV_RUN_DEFAULT);

    // Run the loop to process any pending close callbacks
    // Keep running until all handles are closed
    while (uv_loop_close(ctx_->loop) == UV_EBUSY) {
      uv_run(ctx_->loop, UV_RUN_ONCE);
    }

    free(ctx_->loop);
    ctx_->loop = nullptr;
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object result = Napi::Object::New(env);

    result.Set("exitCode", Napi::Number::New(env, ctx_->result.exitCode));
    result.Set("termSignal", Napi::Number::New(env, ctx_->result.termSignal));
    result.Set("elapsedMs", Napi::Number::New(env, ctx_->result.elapsedMs));
    result.Set("maxMemoryBytes",
               Napi::Number::New(env, ctx_->result.maxMemoryBytes));
    result.Set("timedOut", Napi::Boolean::New(env, ctx_->result.timedOut));
    result.Set("memoryLimitExceeded",
               Napi::Boolean::New(env, ctx_->result.memoryLimitExceeded));
    result.Set("spawnError", Napi::Boolean::New(env, ctx_->result.spawnError));

    Callback().Call({env.Null(), result});
  }

  void OnError(const Napi::Error &e) override {
    Callback().Call({e.Value(), Env().Null()});
  }
};

class ProcessHandle : public Napi::ObjectWrap<ProcessHandle> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func =
        DefineClass(env, "ProcessHandle",
                    {InstanceMethod("writeStdin", &ProcessHandle::WriteStdin),
                     InstanceMethod("endStdin", &ProcessHandle::EndStdin),
                     InstanceMethod("kill", &ProcessHandle::Kill)});

    Napi::FunctionReference *constructor = new Napi::FunctionReference();
    *constructor = Napi::Persistent(func);
    env.SetInstanceData(constructor);

    exports.Set("ProcessHandle", func);
    return exports;
  }

  ProcessHandle(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<ProcessHandle>(info) {}

  void SetStdinState(std::shared_ptr<StdinState> state) { stdinState_ = state; }

  Napi::Value WriteStdin(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
      Napi::TypeError::New(env, "String expected").ThrowAsJavaScriptException();
      return env.Undefined();
    }

    if (!stdinState_ || !stdinState_->workerActive.load()) {
      // Worker is gone, silently ignore
      return env.Undefined();
    }

    std::string data = info[0].As<Napi::String>().Utf8Value();

    // Thread-safe buffer write and signal async handle
    {
      std::lock_guard<std::mutex> lock(stdinState_->mutex);
      stdinState_->buffer.append(data);
      if (stdinState_->stdinAsync) {
        uv_async_send(stdinState_->stdinAsync);
      }
    }

    return env.Undefined();
  }

  Napi::Value EndStdin(const Napi::CallbackInfo &info) {
    if (stdinState_ && stdinState_->workerActive.load()) {
      std::lock_guard<std::mutex> lock(stdinState_->mutex);
      stdinState_->closed = true;
      if (stdinState_->stdinAsync) {
        uv_async_send(stdinState_->stdinAsync);
      }
    }
    return info.Env().Undefined();
  }

  Napi::Value Kill(const Napi::CallbackInfo &info) {
    if (stdinState_ && stdinState_->workerActive.load()) {
      std::lock_guard<std::mutex> lock(stdinState_->mutex);
      stdinState_->killRequested = true;
      if (stdinState_->stdinAsync) {
        uv_async_send(stdinState_->stdinAsync);
      }
    }
    return info.Env().Undefined();
  }

private:
  std::shared_ptr<StdinState> stdinState_;
};

Napi::Value SpawnProcess(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 8) {
    Napi::TypeError::New(env, "Expected 8 arguments: command, cwd, timeout, "
                              "memoryLimit, stdoutCallback, stderrCallback, "
                              "spawnCallback, completionCallback")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (!info[0].IsArray()) {
    Napi::TypeError::New(env, "Argument 0 (command) must be an array")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (!info[1].IsString()) {
    Napi::TypeError::New(env, "Argument 1 (cwd) must be a string")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (!info[2].IsNumber()) {
    Napi::TypeError::New(env, "Argument 2 (timeout) must be a number")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (!info[3].IsNumber()) {
    Napi::TypeError::New(env, "Argument 3 (memoryLimit) must be a number")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (!info[4].IsFunction()) {
    Napi::TypeError::New(env, "Argument 4 (stdoutCallback) must be a function")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (!info[5].IsFunction()) {
    Napi::TypeError::New(env, "Argument 5 (stderrCallback) must be a function")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (!info[6].IsFunction()) {
    Napi::TypeError::New(env, "Argument 6 (spawnCallback) must be a function")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (!info[7].IsFunction()) {
    Napi::TypeError::New(env,
                         "Argument 7 (completionCallback) must be a function")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Array commandArray = info[0].As<Napi::Array>();
  std::vector<std::string> command;
  for (uint32_t i = 0; i < commandArray.Length(); ++i) {
    Napi::Value val = commandArray[i];
    if (!val.IsString()) {
      Napi::TypeError::New(env, "Command array must contain only strings")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    command.push_back(val.As<Napi::String>().Utf8Value());
  }

  if (command.empty()) {
    Napi::TypeError::New(env, "Command array must not be empty")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::string cwd = info[1].As<Napi::String>().Utf8Value();
  uint64_t timeoutMs = info[2].As<Napi::Number>().Int64Value();
  uint64_t memoryLimitMb = info[3].As<Napi::Number>().Int64Value();
  Napi::Function stdoutCallback = info[4].As<Napi::Function>();
  Napi::Function stderrCallback = info[5].As<Napi::Function>();
  Napi::Function spawnCallback = info[6].As<Napi::Function>();
  Napi::Function completionCallback = info[7].As<Napi::Function>();

  // Create thread-safe functions for stdout and stderr
  Napi::ThreadSafeFunction stdoutTsfn =
      Napi::ThreadSafeFunction::New(env, stdoutCallback, "StdoutCallback",
                                    0, // unlimited queue
                                    1  // initial thread count
      );

  Napi::ThreadSafeFunction stderrTsfn =
      Napi::ThreadSafeFunction::New(env, stderrCallback, "StderrCallback",
                                    0, // unlimited queue
                                    1  // initial thread count
      );

  Napi::ThreadSafeFunction spawnTsfn =
      Napi::ThreadSafeFunction::New(env, spawnCallback, "SpawnCallback",
                                    0, // unlimited queue
                                    1  // initial thread count
      );

  // Create shared stdin state for thread-safe communication
  auto stdinState = std::make_shared<StdinState>();

  auto *worker = new JudgeWorker(completionCallback, command, cwd, timeoutMs,
                                 memoryLimitMb, stdoutTsfn, stderrTsfn,
                                 spawnTsfn, stdinState);

  // Create and return a ProcessHandle
  Napi::FunctionReference *constructor =
      env.GetInstanceData<Napi::FunctionReference>();
  Napi::Object handleObj = constructor->New({});
  ProcessHandle *handle = Napi::ObjectWrap<ProcessHandle>::Unwrap(handleObj);
  handle->SetStdinState(stdinState);

  worker->Queue();

  return handleObj;
}

Napi::Object InitJudge(Napi::Env env, Napi::Object exports) {
  ProcessHandle::Init(env, exports);
  exports.Set("spawnProcess", Napi::Function::New(env, SpawnProcess));
  return exports;
}

NODE_API_MODULE(judge, InitJudge)
