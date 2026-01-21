#include <napi.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <string>
#include <sys/eventfd.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

// Linux process monitoring implementation using pidfd_open, poll, and wait4.
//
// Exports:
//   spawn(...) -> { pid: number, result: Promise<AddonResult> }
//

static int pidfd_open(pid_t pid, unsigned int flags) {
  return syscall(SYS_pidfd_open, pid, flags);
}

namespace {

// AsyncWorker for waiting on process completion

struct SharedStopState {
  int stopEventFd = -1;
  std::mutex mutex;
  bool closed = false;

  SharedStopState() { stopEventFd = eventfd(0, EFD_NONBLOCK); }

  ~SharedStopState() {
    if (stopEventFd >= 0) {
      close(stopEventFd);
      stopEventFd = -1;
    }
  }

  // Called by worker when it's done
  void Close() {
    std::lock_guard<std::mutex> lock(mutex);
    closed = true;
  }

  // Called by JS 'cancel' function
  bool SignalStop() {
    std::lock_guard<std::mutex> lock(mutex);
    if (closed || stopEventFd < 0)
      return false;

    uint64_t val = 1;
    ssize_t ret = write(stopEventFd, &val, sizeof(val));
    return (ret == sizeof(val));
  }
};

// AsyncWorker for waiting on process completion
class WaitForProcessWorker : public Napi::AsyncWorker {
public:
  WaitForProcessWorker(Napi::Env &env, pid_t pid, uint32_t timeoutMs,
                       uint64_t memoryLimitBytes,
                       std::shared_ptr<SharedStopState> sharedState)
      : Napi::AsyncWorker(env), pid_(pid), timeoutMs_(timeoutMs),
        memoryLimitBytes_(memoryLimitBytes), deferred_(env), elapsedMs_(0.0),
        peakMemoryBytes_(0), exitCode_(0), termSignal_(0), timedOut_(false),
        memoryLimitExceeded_(false), stopped_(false), errorMsg_(""),
        sharedState_(sharedState) {}

  ~WaitForProcessWorker() {

    // no-op, shared state destructor handles fd
  }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

protected:
  void Execute() override {
    int status = 0;
    struct rusage rusage;

    int pidfd = pidfd_open(pid_, 0);
    bool shouldWait = true;

    if (pidfd < 0) {
      if (errno == ESRCH) {
        // Process is already a zombie or reaped, skip waiting and collect stats
        // below
        shouldWait = false;
      } else {
        errorMsg_ = "pidfd_open failed (requires Linux 5.3+): ";
        errorMsg_ += std::strerror(errno);
        return;
      }
    }

    if (shouldWait) {
      // Set up poll with both pidfd (process exit) and stopEventFd (external
      // stop)
      struct pollfd pfds[2];
      pfds[0].fd = pidfd;
      pfds[0].events = POLLIN;
      pfds[1].fd = sharedState_->stopEventFd;
      pfds[1].events = POLLIN;

      // We loop to implement polling for memory limits
      auto startTime = std::chrono::steady_clock::now();

      while (true) {
        // Calculate remaining timeout if applicable
        int pollTimeout = -1;

        // 10ms poll interval for memory checking
        int intervalMs = 10;

        // Use fixed interval polling to avoid complex timeout math and busy
        // loops. We check for timeout manually after poll returns.
        pollTimeout = intervalMs;

        // Wait for process exit, stop signal, or timeout/interval
        int pollResult = poll(pfds, 2, pollTimeout);

        if (pollResult == -1) {
          if (errno == EINTR)
            continue;
          close(pidfd);
          errorMsg_ = "poll failed: ";
          errorMsg_ += std::strerror(errno);
          return;
        }

        // Check exit/stop FIRST
        if (pollResult > 0) {
          if (pfds[1].revents & POLLIN) {
            // External stop requested
            close(pidfd);
            stopped_ = true;
            kill(pid_, SIGKILL);
            break;
          }
          if (pfds[0].revents & POLLIN) {
            // Process exited
            close(pidfd);
            break;
          }
        }

        // Timeout or Interval Wakeup - CHECK MEMORY/CPU TIME/TIMEOUT

        // Check Memory
        long peakRSS = GetPeakRSS();

        // Update peak memory statistics
        if (peakRSS > (long)peakMemoryBytes_) {
          peakMemoryBytes_ = peakRSS;
        }

        if (memoryLimitBytes_ > 0) {
          if (peakRSS > (long)memoryLimitBytes_) {
            memoryLimitExceeded_ = true;
            kill(pid_, SIGKILL);
            close(pidfd);
            break;
          }
        }

        // Check CPU Time Limit
        if (timeoutMs_ > 0) {
          uint64_t currentCpuTimeMs = GetCurrentCpuTimeMs();
          if (currentCpuTimeMs > timeoutMs_) {
            timedOut_ = true;
            kill(pid_, SIGKILL);
            close(pidfd);
            break;
          }
        }

        // Check Wall Clock Timeout (fallback safety mechanism)
        if (timeoutMs_ > 0) {
          auto now = std::chrono::steady_clock::now();
          auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                             now - startTime)
                             .count();
          // 2x leniency for wall clock vs CPU time
          if (elapsed > (long)timeoutMs_ * 2) {
            timedOut_ = true;
            kill(pid_, SIGKILL);
            close(pidfd);
            break;
          }
        }
      }
    }

    // Mark shared state as closed so cancel() becomes no-op
    sharedState_->Close();

    // Collect exit status and resource usage
    std::memset(&rusage, 0, sizeof(rusage));
    if (wait4(pid_, &status, 0, &rusage) == -1) {
      // Proceed with zeroed rusage
    }

    // Calculate elapsed CPU time from rusage (user + system)
    uint64_t cpuUs =
        (rusage.ru_utime.tv_sec + rusage.ru_stime.tv_sec) * 1000000ULL +
        (rusage.ru_utime.tv_usec + rusage.ru_stime.tv_usec);
    elapsedMs_ = std::round(static_cast<double>(cpuUs) / 1000.0);

    // Post-mortem CPU Time Check: Catch CPU time that exceeded limit between
    // poll intervals or if process ended naturally just before detection
    if (timeoutMs_ > 0 && elapsedMs_ > timeoutMs_) {
      timedOut_ = true;
    }

    // Post-mortem Memory Check: Catch spikes that happened between poll
    // intervals
    if (memoryLimitBytes_ > 0 && peakMemoryBytes_ > memoryLimitBytes_) {
      memoryLimitExceeded_ = true;
    }

    // Analyze exit status
    if (WIFSIGNALED(status)) {
      int signal = WTERMSIG(status);
      termSignal_ = signal;

      if (signal == SIGXCPU) {
        // Process was killed by SIGXCPU - CPU time limit exceeded
        timedOut_ = true;
        exitCode_ = 128 + signal;
      } else if (signal == SIGKILL) {
        // Process was killed by SIGKILL.
        // Could be our manual kill (timeout/memory/stop) or external OOM.

        // Check for timeout: if CPU time is close to the limit, it was likely
        // timeout
        if (timeoutMs_ > 0) {
          rlim_t limitSeconds = (timeoutMs_ + 999) / 1000;
          double cpuSeconds = elapsedMs_ / 1000.0;
          // If CPU time is within 90% of limit, consider it a timeout
          if (cpuSeconds >= limitSeconds * 0.9) {
            timedOut_ = true;
          }
        }

        // If we already flagged it, good.
        // If not, and we didn't stop it, and it wasn't a timeout...
        if (!timedOut_ && !memoryLimitExceeded_ && !stopped_) {
          // It was an external SIGKILL (e.g. system OOM killer).
          // We can't be sure it was THIS limit, but if peak memory is high
          // we might suspect it. But without RLIMIT_AS, random SIGKILLs are
          // rarer. For now, leave flags as is (false).
        }

        exitCode_ = 128 + signal;
      } else {
        // Other signal
        exitCode_ = 128 + signal;
      }
    } else if (WIFEXITED(status)) {
      exitCode_ = WEXITSTATUS(status);
    } else {
      exitCode_ = -1;
    }
  }

  void OnOK() override {
    Napi::Env env = Env();

    if (!errorMsg_.empty()) {
      deferred_.Reject(Napi::Error::New(env, errorMsg_).Value());
      return;
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("elapsedMs", Napi::Number::New(env, elapsedMs_));
    result.Set("peakMemoryBytes",
               Napi::Number::New(env, static_cast<double>(peakMemoryBytes_)));

    if (termSignal_ > 0) {
      result.Set("exitCode", env.Null());
    } else {
      result.Set("exitCode", Napi::Number::New(env, exitCode_));
    }

    result.Set("timedOut", Napi::Boolean::New(env, timedOut_));
    result.Set("memoryLimitExceeded",
               Napi::Boolean::New(env, memoryLimitExceeded_));
    result.Set("stopped", Napi::Boolean::New(env, stopped_));

    deferred_.Resolve(result);
  }

  void OnError(const Napi::Error &e) override { deferred_.Reject(e.Value()); }

private:
  pid_t pid_;
  uint32_t timeoutMs_;
  uint64_t memoryLimitBytes_;
  Napi::Promise::Deferred deferred_;
  double elapsedMs_;
  uint64_t peakMemoryBytes_;
  int exitCode_;
  int termSignal_;
  bool timedOut_;
  bool memoryLimitExceeded_;
  bool stopped_;
  std::string errorMsg_;
  std::shared_ptr<SharedStopState> sharedState_;

  long GetPeakRSS() {
    std::string path = "/proc/" + std::to_string(pid_) + "/status";
    FILE *f = fopen(path.c_str(), "r");
    if (!f)
      return 0;

    char line[256];
    long hwm = 0;
    while (fgets(line, sizeof(line), f)) {
      if (strncmp(line, "VmHWM:", 6) == 0) {
        long kb;
        if (sscanf(line + 6, "%ld", &kb) == 1) {
          hwm = kb * 1024;
        }
        break;
      }
    }
    fclose(f);
    return hwm;
  }

  uint64_t GetCurrentCpuTimeMs() {
    std::string path = "/proc/" + std::to_string(pid_) + "/stat";
    FILE *f = fopen(path.c_str(), "r");
    if (!f)
      return 0;

    // Read the stat file - format: pid (comm) state ...
    // Fields 14 and 15 are utime and stime (in clock ticks)
    unsigned long utime = 0, stime = 0;
    if (fscanf(f, "%*d %*s %*c %*d %*d %*d %*d %*d %*u %*u %*u %*u %*u %lu %lu",
               &utime, &stime) == 2) {
      fclose(f);
      // Convert clock ticks to milliseconds
      // sysconf(_SC_CLK_TCK) is typically 100 ticks per second
      long ticksPerSecond = sysconf(_SC_CLK_TCK);
      uint64_t totalTicks = utime + stime;
      return (totalTicks * 1000) / ticksPerSecond;
    }
    fclose(f);
    return 0;
  }
};

// Helper to convert Napi::Value to std::string
std::string ToString(Napi::Value value) {
  if (value.IsString()) {
    return value.As<Napi::String>().Utf8Value();
  }
  return "";
}

// Helper to convert Napi::Array of strings to std::vector<std::string>
std::vector<std::string> ToArgv(Napi::Array args) {
  std::vector<std::string> argv;
  for (uint32_t i = 0; i < args.Length(); i++) {
    argv.push_back(ToString(args[i]));
  }
  return argv;
}

// Spawns a process with native resource limits
// Arguments:
// 0: command (string)
// 1: args (array of strings)
// 2: cwd (string) or empty
// 3: timeoutMs (number)
// 4: memoryLimitBytes (number)
// 5: pipeNameIn (string)
// 6: pipeNameOut (string)
// 7: pipeNameErr (string)
// 8: onSpawn (function)
// Returns: { pid: number, result: Promise<AddonResult> }
//
Napi::Value SpawnProcess(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 9) {
    Napi::TypeError::New(env, "Expected 9 arguments")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string command = ToString(info[0]);
  Napi::Array argsArray = info[1].As<Napi::Array>();
  std::string cwd = ToString(info[2]);
  volatile uint32_t timeoutMs = info[3].As<Napi::Number>().Uint32Value();
  double memoryLimitMB = info[4].As<Napi::Number>().DoubleValue();
  volatile uint64_t memoryLimitBytes =
      static_cast<uint64_t>(memoryLimitMB * 1024.0 * 1024.0);

  std::string pipeNameIn = ToString(info[5]);
  std::string pipeNameOut = ToString(info[6]);
  std::string pipeNameErr = ToString(info[7]);

  Napi::Function onSpawn = info[8].As<Napi::Function>();

  // Pre-convert JS values to C++ strings/vectors in the parent process.
  // DO NOT access 'info', 'argsArray' in the child process after fork().
  std::vector<std::string> args = ToArgv(argsArray);

  std::vector<char *> argv;
  argv.push_back(const_cast<char *>(command.c_str()));
  for (auto &arg : args) {
    argv.push_back(const_cast<char *>(arg.c_str()));
  }
  argv.push_back(nullptr);

  // Create a pipe to communicate errors from child to parent
  int err_pipe[2];
  if (pipe2(err_pipe, O_CLOEXEC) == -1) {
    Napi::Error::New(env, "pipe2 failed: " + std::string(std::strerror(errno)))
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  pid_t pid = vfork();

  if (pid < 0) {
    close(err_pipe[0]);
    close(err_pipe[1]);
    Napi::Error::New(env, "vfork failed: " + std::string(std::strerror(errno)))
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  if (pid == 0) {
    // Child process (Caution: shares memory with parent until exec)

    // Connect to Unix Domain Sockets for stdio
    auto connectSocket = [](const char *path) -> int {
      int sock = socket(AF_UNIX, SOCK_STREAM, 0);
      if (sock < 0)
        return -1;

      struct sockaddr_un addr;
      memset(&addr, 0, sizeof(addr));
      addr.sun_family = AF_UNIX;
      strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);

      if (connect(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(sock);
        return -1;
      }
      return sock;
    };

    // Stdin: Read from socket (from parent)
    int sockIn = connectSocket(pipeNameIn.c_str());
    // Stdout: Write to socket (to parent)
    int sockOut = connectSocket(pipeNameOut.c_str());
    // Stderr: Write to socket (to parent)
    int sockErr = connectSocket(pipeNameErr.c_str());

    if (sockIn < 0 || sockOut < 0 || sockErr < 0) {
      // Avoid printf/perror in vfork child if possible, or keep it minimal
      _exit(1);
    }

    // Redirect stdio
    if (dup2(sockIn, STDIN_FILENO) < 0 || dup2(sockOut, STDOUT_FILENO) < 0 ||
        dup2(sockErr, STDERR_FILENO) < 0) {
      _exit(1);
    }

    // Close original socket FDs
    close(sockIn);
    close(sockOut);
    close(sockErr);

    // Resource limits are now handled in the monitoring loop
    // (removed prlimit for CPU time as it only works with second precision)

    // Change directory
    if (!cwd.empty()) {
      chdir(cwd.c_str());
    }

    // Execute
    execvp(command.c_str(), argv.data());

    // If exec fails, communicate errno to parent
    int err = errno;
    write(err_pipe[1], &err, sizeof(err));
    _exit(1);
  }

  // Parent process
  close(err_pipe[1]); // Close write end in parent

  // Check if child reported an error
  int childErr = 0;
  ssize_t count = read(err_pipe[0], &childErr, sizeof(childErr));
  close(err_pipe[0]);

  if (count > 0) {
    // Child reported an error
    // We should wait for the child to reap it (it exited with 1)
    int status;
    waitpid(pid, &status, 0);
    Napi::Error::New(env, std::strerror(childErr)).ThrowAsJavaScriptException();
    return env.Null();
  }
  // Notify JS that the process has spawned
  onSpawn.Call({});

  auto sharedState = std::make_shared<SharedStopState>();

  // Start monitoring immediataely
  auto worker = new WaitForProcessWorker(env, pid, timeoutMs, memoryLimitBytes,
                                         sharedState);
  auto promise = worker->GetPromise();
  worker->Queue();

  Napi::Object result = Napi::Object::New(env);
  result.Set("pid", Napi::Number::New(env, pid));
  result.Set("result", promise);

  // Expose cancel function
  // We capture sharedState by value (shared_ptr copy) in the lambda
  result.Set("cancel", Napi::Function::New(
                           env,
                           [sharedState](const Napi::CallbackInfo &info) {
                             sharedState->SignalStop();
                           },
                           "cancel"));

  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("spawn", Napi::Function::New(env, SpawnProcess, "spawn"));
  return exports;
}

} // namespace

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
