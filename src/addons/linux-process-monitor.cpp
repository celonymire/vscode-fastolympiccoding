#include <napi.h>

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <string>
#include <vector>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <sys/time.h>
#include <poll.h>
#include <sys/syscall.h>
#include <sys/eventfd.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <chrono>
#include <algorithm>

// Linux implementation using kernel-enforced resource limits for process monitoring
// Combined with pidfd_open + poll for efficient waiting and wait4 for stats
//
// Exports:
//   spawn(...) -> { pid: number, result: Promise<AddonResult> }
//

// pidfd_open syscall wrapper (available since Linux 5.3)
static int pidfd_open(pid_t pid, unsigned int flags) {
  return syscall(SYS_pidfd_open, pid, flags);
}

namespace {

// AsyncWorker for waiting on process completion
// Helper to get Peak Resident Set Size (VmHWM) in bytes from /proc/[pid]/status
static long GetPeakRSS(pid_t pid) {
  std::string path = "/proc/" + std::to_string(pid) + "/status";
  FILE* f = fopen(path.c_str(), "r");
  if (!f) return 0;
  
  char line[256];
  long hwm = 0;
  while (fgets(line, sizeof(line), f)) {
    if (strncmp(line, "VmHWM:", 6) == 0) {
      // Format: "VmHWM:    1234 kB"
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

// AsyncWorker for waiting on process completion
// Shared state for synchronization between worker and JS thread
struct SharedStopState {
    int stopEventFd = -1;
    std::mutex mutex;
    bool closed = false;
    
    SharedStopState() {
        stopEventFd = eventfd(0, EFD_NONBLOCK);
    }
    
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
        if (closed || stopEventFd < 0) return false;
        
        uint64_t val = 1;
        ssize_t ret = write(stopEventFd, &val, sizeof(val));
        return (ret == sizeof(val));
    }
};

// AsyncWorker for waiting on process completion
class WaitForProcessWorker : public Napi::AsyncWorker {
public:
  WaitForProcessWorker(Napi::Env &env, pid_t pid, uint32_t timeoutMs, uint64_t memoryLimitBytes,
                       std::shared_ptr<SharedStopState> sharedState)
      : Napi::AsyncWorker(env), pid_(pid), timeoutMs_(timeoutMs),
        memoryLimitBytes_(memoryLimitBytes), deferred_(env), elapsedMs_(0.0), peakMemoryBytes_(0),
        exitCode_(0), termSignal_(0), timedOut_(false), memoryLimitExceeded_(false), stopped_(false), errorMsg_(""),
        sharedState_(sharedState) {
  }
  
  ~WaitForProcessWorker() {
      // no-op, shared state destructor handles fd
  }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

protected:
  void Execute() override {
    // Note: Resource limits (RLIMIT_CPU) are set in the child process
    // prior to exec(). RLIMIT_AS is NOT set because we enforce RSS via polling.

    int status = 0;
    struct rusage rusage;
    
    // Open pidfd for efficient waiting (requires Linux 5.3+)
    int pidfd = pidfd_open(pid_, 0);
    bool shouldWait = true;

    if (pidfd < 0) {
      if (errno == ESRCH) {
        // Process is already a zombie or reaped, skip waiting and collect stats below
        shouldWait = false;
      } else {
        errorMsg_ = "pidfd_open failed (requires Linux 5.3+): ";
        errorMsg_ += std::strerror(errno);
        return;
      }
    }
    
    if (shouldWait) {
      // Set up poll with both pidfd (process exit) and stopEventFd (external stop)
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
        
        // 50ms poll interval for memory checking
        int intervalMs = 50; 
        
        // Use fixed interval polling to avoid complex timeout math and busy loops.
        // We check for timeout manually after poll returns.
        pollTimeout = intervalMs;

        // Wait for process exit, stop signal, or timeout/interval
        int pollResult = poll(pfds, 2, pollTimeout);
        
        if (pollResult == -1) {
          if (errno == EINTR) continue;
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
        
        // Timeout or Interval Wakeup - CHECK MEMORY/TIMEOUT
        
        // Check Memory
        if (memoryLimitBytes_ > 0) {
           long peakRSS = GetPeakRSS(pid_);
           if (peakRSS > (long)memoryLimitBytes_) {
               memoryLimitExceeded_ = true;
               kill(pid_, SIGKILL);
               close(pidfd);
               break;
           }
        }
        
        // Check Wall Clock Timeout
        if (timeoutMs_ > 0) {
             auto now = std::chrono::steady_clock::now();
             auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - startTime).count();
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
    uint64_t cpuUs = (rusage.ru_utime.tv_sec + rusage.ru_stime.tv_sec) * 1000000ULL +
                     (rusage.ru_utime.tv_usec + rusage.ru_stime.tv_usec);
    elapsedMs_ = std::round(static_cast<double>(cpuUs) / 1000.0);

    // Get peak memory (in kilobytes on Linux, convert to bytes)
    peakMemoryBytes_ = static_cast<uint64_t>(rusage.ru_maxrss) * 1024ULL;

    // Post-mortem Memory Check: Catch spikes that happened between poll intervals
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
        
        // Check for timeout: if CPU time is close to the limit, it was likely timeout
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
            // we might suspect it. But without RLIMIT_AS, random SIGKILLs are rarer.
            // For now, leave flags as is (false).
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
    result.Set("peakMemoryBytes", Napi::Number::New(env, static_cast<double>(peakMemoryBytes_)));
    
    if (termSignal_ > 0) {
      result.Set("exitCode", env.Null());
    } else {
      result.Set("exitCode", Napi::Number::New(env, exitCode_));
    }

    result.Set("timedOut", Napi::Boolean::New(env, timedOut_));
    result.Set("memoryLimitExceeded", Napi::Boolean::New(env, memoryLimitExceeded_));
    result.Set("stopped", Napi::Boolean::New(env, stopped_));
    
    deferred_.Resolve(result);
  }

  void OnError(const Napi::Error &e) override {
    deferred_.Reject(e.Value());
  }

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
    Napi::TypeError::New(env, "Expected 9 arguments").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string command = ToString(info[0]);
  Napi::Array argsArray = info[1].As<Napi::Array>();
  std::string cwd = ToString(info[2]);
  uint32_t timeoutMs = info[3].As<Napi::Number>().Uint32Value();
  double memoryLimitMB = info[4].As<Napi::Number>().DoubleValue();
  uint64_t memoryLimitBytes = static_cast<uint64_t>(memoryLimitMB * 1024.0 * 1024.0);
  
  std::string pipeNameIn = ToString(info[5]);
  std::string pipeNameOut = ToString(info[6]);
  std::string pipeNameErr = ToString(info[7]);
  
  Napi::Function onSpawn = info[8].As<Napi::Function>();

  // Pre-convert JS values to C++ strings/vectors in the parent process.
  // DO NOT access 'info', 'argsArray' in the child process after fork().
  std::vector<std::string> args = ToArgv(argsArray);

  pid_t pid = fork();

  if (pid < 0) {
    Napi::Error::New(env, "fork failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (pid == 0) {
    // Child process
    
    // Connect to Unix Domain Sockets for stdio
    auto connectSocket = [](const std::string& path) -> int {
        int sock = socket(AF_UNIX, SOCK_STREAM, 0);
        if (sock < 0) return -1;
        
        struct sockaddr_un addr;
        memset(&addr, 0, sizeof(addr));
        addr.sun_family = AF_UNIX;
        strncpy(addr.sun_path, path.c_str(), sizeof(addr.sun_path) - 1);
        
        if (connect(sock, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
            close(sock);
            return -1;
        }
        return sock;
    };

    // Stdin: Read from socket (from parent)
    int sockIn = connectSocket(pipeNameIn);
    // Stdout: Write to socket (to parent)
    int sockOut = connectSocket(pipeNameOut);
    // Stderr: Write to socket (to parent)
    int sockErr = connectSocket(pipeNameErr);

    if (sockIn < 0 || sockOut < 0 || sockErr < 0) {
        perror("Failed to connect to stdio sockets");
        _exit(1);
    }
    
    // Redirect stdio
    if (dup2(sockIn, STDIN_FILENO) < 0 ||
        dup2(sockOut, STDOUT_FILENO) < 0 ||
        dup2(sockErr, STDERR_FILENO) < 0) {
      perror("dup2 failed");
      _exit(1);
    }

    // Close original socket FDs
    close(sockIn);
    close(sockOut);
    close(sockErr);

    // Set resource limits
    if (timeoutMs > 0) {
      struct rlimit cpuLimit;
      rlim_t seconds = (timeoutMs + 999) / 1000;
      if (seconds == 0) seconds = 1;
      cpuLimit.rlim_cur = seconds;
      cpuLimit.rlim_max = seconds;
      prlimit(0, RLIMIT_CPU, &cpuLimit, nullptr);
    }


    // Change directory
    if (!cwd.empty()) {
      chdir(cwd.c_str());
    }

    // Prepare argv
    std::vector<char*> argv;
    argv.push_back(const_cast<char*>(command.c_str()));
    for (auto& arg : args) {
      argv.push_back(const_cast<char*>(arg.c_str()));
    }
    argv.push_back(nullptr);

    // Execute
    // Use execvp to inherit environment
    execvp(command.c_str(), argv.data());
    
    // If exec fails
    perror("exec failed");
    _exit(1);
  }

  // Parent process
  // Notify JS that the process has spawned
  onSpawn.Call({});
  
  auto sharedState = std::make_shared<SharedStopState>();

  // Start monitoring immediataely
  auto worker = new WaitForProcessWorker(env, pid, timeoutMs, memoryLimitBytes, sharedState);
  auto promise = worker->GetPromise();
  worker->Queue();

  Napi::Object result = Napi::Object::New(env);
  result.Set("pid", Napi::Number::New(env, pid));
  result.Set("result", promise);
  
  // Expose cancel function
  // We capture sharedState by value (shared_ptr copy) in the lambda
  result.Set("cancel", Napi::Function::New(env, [sharedState](const Napi::CallbackInfo& info) {
      sharedState->SignalStop();
  }, "cancel"));
  
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("spawn",
              Napi::Function::New(env, SpawnProcess, "spawn"));
  return exports;
}

} // namespace

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
