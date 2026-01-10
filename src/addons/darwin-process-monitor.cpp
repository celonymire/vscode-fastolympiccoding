#include <napi.h>

#include <mach/mach.h>
#include <mach/mach_time.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/event.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <signal.h>
#include <unistd.h>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <string>
#include <vector>

// macOS implementation using kqueue for efficient process monitoring
// Combined with resource limits enforced by rlimit-wrapper and wait4 for stats
//
// Exports:
//   waitForProcess(pid: number, timeoutMs: number, memoryLimitBytes: number)
//     -> Promise<{ elapsedMs, peakMemoryBytes, exitCode, timedOut, memoryLimitExceeded, stopped }>
//
// The waitForProcess function uses:
//  - kqueue with EVFILT_PROC (NOTE_EXIT) for efficient exit notification
//  - kqueue with EVFILT_USER for stop signal notification
//  - kevent() for waiting (kernel notifies us, NO polling loops!)
//  - wait4 to collect rusage stats and exit status
//  - Signal analysis (SIGXCPU, SIGKILL) to detect limit violations
//
// Note: Resource limits (RLIMIT_CPU, RLIMIT_AS) must be set by the rlimit-wrapper
// binary before the target process is spawned. This addon only monitors the process.

namespace {

// AsyncWorker for waiting on process completion
class WaitForProcessWorker : public Napi::AsyncWorker {
public:
  WaitForProcessWorker(Napi::Env &env, pid_t pid, uint32_t timeoutMs, uint64_t memoryLimitBytes)
      : Napi::AsyncWorker(env), pid_(pid), timeoutMs_(timeoutMs),
        memoryLimitBytes_(memoryLimitBytes), deferred_(env), elapsedMs_(0.0), peakMemoryBytes_(0),
        exitCode_(0), timedOut_(false), memoryLimitExceeded_(false), stopped_(false), errorMsg_(""),
        kq_(-1) {}
  
  ~WaitForProcessWorker() {
    if (kq_ >= 0) {
      close(kq_);
    }
  }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // Allow external stop request
  void Stop() {
    stopped_ = true;
    // Trigger the user event to wake up kevent()
    if (kq_ >= 0) {
      struct kevent kev;
      EV_SET(&kev, 0, EVFILT_USER, 0, NOTE_TRIGGER, 0, nullptr);
      kevent(kq_, &kev, 1, nullptr, 0, nullptr);
    }
  }

protected:
  void Execute() override {
    int status = 0;
    struct rusage rusage;
    
    // Create kqueue for efficient process monitoring
    kq_ = kqueue();
    if (kq_ == -1) {
      errorMsg_ = "Failed to create kqueue: ";
      errorMsg_ += std::strerror(errno);
      return;
    }
    
    // Register two events:
    // 1. EVFILT_PROC with NOTE_EXIT - notifies when process exits
    // 2. EVFILT_USER - allows us to trigger wake-up on external stop
    struct kevent kevs[2];
    EV_SET(&kevs[0], pid_, EVFILT_PROC, EV_ADD | EV_ENABLE, NOTE_EXIT, 0, nullptr);
    EV_SET(&kevs[1], 0, EVFILT_USER, EV_ADD | EV_ENABLE | EV_CLEAR, 0, 0, nullptr);
    
    bool shouldWait = true;

    // Check if process already exited/doesn't exist before waiting.
    // On macOS, EVFILT_PROC registration fails with ESRCH if the process is 
    // already a zombie or has finished exiting. We must handle this to avoid
    // returning a false error for fast-running processes (like /bin/true).
    if (kevent(kq_, kevs, 2, nullptr, 0, nullptr) == -1) {
        // If process is gone (ESRCH), that's fine, we'll collect exit code with wait4 below
        if (errno == ESRCH) {
            shouldWait = false;
        } else {
            errorMsg_ = "Failed to register events with kqueue: ";
            errorMsg_ += std::strerror(errno);
            return;
        }
    }
    
    // Wait for either process exit, stop signal, or timeout
    if (shouldWait) {
        struct kevent event;
        int nev = -1;
        
        // Use timespec for wall clock timeout
        struct timespec timeout;
        struct timespec* timeoutPtr = nullptr;
        if (timeoutMs_ > 0) {
            timeout.tv_sec = timeoutMs_ / 1000;
            timeout.tv_nsec = (timeoutMs_ % 1000) * 1000000;
            timeoutPtr = &timeout;
            // printf("Waiting with timeout: %dms (%lds %ldns)\n", timeoutMs_, timeout.tv_sec, timeout.tv_nsec);
        }

        // Wait
        nev = kevent(kq_, nullptr, 0, &event, 1, timeoutPtr);
        // printf("kevent wait returned: %d\n", nev);
        
        if (nev == -1) {
            if (errno != EINTR && errno != ESRCH) {
                 errorMsg_ = "kevent failed: ";
                 errorMsg_ += std::strerror(errno);
                 return;
            }
        } else if (nev == 0) {
            // Timeout
            // printf("Timeout occurred (nev=0)\n");
            timedOut_ = true;
            kill(pid_, SIGKILL);
        }
    }

    // Check if stopped before process exit
    if (stopped_) {
      kill(pid_, SIGKILL);
    }
    
    // Collect exit status and resource usage with wait4
    std::memset(&rusage, 0, sizeof(rusage));
    if (wait4(pid_, &status, 0, &rusage) == -1) {
      // Proceed with zeroed rusage
    }

    // Calculate elapsed CPU time from rusage (user + system)
    uint64_t cpuUs = (rusage.ru_utime.tv_sec + rusage.ru_stime.tv_sec) * 1000000ULL +
                     (rusage.ru_utime.tv_usec + rusage.ru_stime.tv_usec);
    elapsedMs_ = std::round(static_cast<double>(cpuUs) / 1000.0);

    // Get peak memory (ru_maxrss is in bytes on macOS)
    peakMemoryBytes_ = static_cast<uint64_t>(rusage.ru_maxrss);

    // Analyze exit status to determine if limits were exceeded
    if (WIFSIGNALED(status)) {
      int signal = WTERMSIG(status);
      
      if (signal == SIGXCPU) {
        // Process was killed by SIGXCPU - CPU time limit exceeded
        timedOut_ = true;
        exitCode_ = 128 + signal;
      } else if (signal == SIGKILL) {
        // Process was killed by SIGKILL - could be:
        // 1. Memory limit (RLIMIT_AS causes SIGKILL)
        // 2. SIGXCPU was upgraded to SIGKILL (if RLIMIT_CPU hard limit reached)
        // 3. External stop request
        
        // Check for timeout: if CPU time is close to the limit, it was likely timeout
        if (timeoutMs_ > 0) {
          rlim_t limitSeconds = (timeoutMs_ + 999) / 1000;
          double cpuSeconds = elapsedMs_ / 1000.0;
          // If CPU time is within 90% of limit, consider it a timeout
          if (cpuSeconds >= limitSeconds * 0.9) {
            timedOut_ = true;
          }
        }
        
        // Check for memory limit: if peak memory is close to the limit
        if (!timedOut_ && memoryLimitBytes_ > 0) {
          // RLIMIT_AS uses 1.5x the memory limit
          rlim_t memLimit = static_cast<rlim_t>(memoryLimitBytes_ * 1.5);
          // If peak memory is within 90% of the virtual address space limit
          if (peakMemoryBytes_ >= memLimit * 0.6) { // 0.6 = 0.9 / 1.5
            memoryLimitExceeded_ = true;
          }
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
    result.Set("exitCode", Napi::Number::New(env, exitCode_));
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
  bool timedOut_;
  bool memoryLimitExceeded_;
  bool stopped_;
  std::string errorMsg_;
  int kq_;
};




// External declaration for environ
extern char **environ;

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
// 5: onSpawn (function)
// Returns: { pid: number, stdio: [stdinFd, stdoutFd, stderrFd], result: Promise<AddonResult> }
//
Napi::Value SpawnProcess(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 6) {
    Napi::TypeError::New(env, "Expected 6 arguments").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string command = ToString(info[0]);
  Napi::Array argsArray = info[1].As<Napi::Array>();
  std::string cwd = ToString(info[2]);
  uint32_t timeoutMs = info[3].As<Napi::Number>().Uint32Value();
  double memoryLimitMB = info[4].As<Napi::Number>().DoubleValue();
  uint64_t memoryLimitBytes = static_cast<uint64_t>(memoryLimitMB * 1024.0 * 1024.0);
  Napi::Function onSpawn = info[5].As<Napi::Function>();

  // Pre-convert JS values to C++ strings/vectors in the parent process.
  // DO NOT access 'info', 'argsArray' in the child process after fork().
  std::vector<std::string> args = ToArgv(argsArray);

  // Create pipes for stdio
  int stdinPipe[2], stdoutPipe[2], stderrPipe[2];

  if (pipe(stdinPipe) < 0 || pipe(stdoutPipe) < 0 || pipe(stderrPipe) < 0) {
    Napi::Error::New(env, "Failed to create pipes").ThrowAsJavaScriptException();
    return env.Null();
  }

  pid_t pid = fork();

  if (pid < 0) {
    // Fork failed
    close(stdinPipe[0]); close(stdinPipe[1]);
    close(stdoutPipe[0]); close(stdoutPipe[1]);
    close(stderrPipe[0]); close(stderrPipe[1]);
    Napi::Error::New(env, "fork failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  if (pid == 0) {
    // Child process
    
    // Redirect stdio
    if (dup2(stdinPipe[0], STDIN_FILENO) < 0 ||
        dup2(stdoutPipe[1], STDOUT_FILENO) < 0 ||
        dup2(stderrPipe[1], STDERR_FILENO) < 0) {
      perror("dup2 failed");
      _exit(1);
    }

    // Close all pipe FDs
    close(stdinPipe[0]); close(stdinPipe[1]);
    close(stdoutPipe[0]); close(stdoutPipe[1]);
    close(stderrPipe[0]); close(stderrPipe[1]);

    // Set resource limits
    if (timeoutMs > 0) {
      struct rlimit cpuLimit;
      rlim_t seconds = (timeoutMs + 999) / 1000;
      if (seconds == 0) seconds = 1;
      cpuLimit.rlim_cur = seconds;
      cpuLimit.rlim_max = seconds;
      setrlimit(RLIMIT_CPU, &cpuLimit);
    }

    if (memoryLimitBytes > 0) {
      struct rlimit memLimit;
      rlim_t limit = static_cast<rlim_t>(memoryLimitBytes);
      memLimit.rlim_cur = limit;
      memLimit.rlim_max = limit;
      setrlimit(RLIMIT_AS, &memLimit);
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
    execvp(command.c_str(), argv.data());
    
    // If exec fails
    perror("exec failed");
    _exit(1);
  }

  // Parent process
  // Notify JS that the process has spawned
  onSpawn.Call({});

  // Close child-side pipe ends
  close(stdinPipe[0]);
  close(stdoutPipe[1]);
  close(stderrPipe[1]);

  // Start monitoring immediataely
  auto worker = new WaitForProcessWorker(env, pid, timeoutMs, memoryLimitBytes);
  auto promise = worker->GetPromise();
  worker->Queue();

  Napi::Object result = Napi::Object::New(env);
  result.Set("pid", Napi::Number::New(env, pid));
  result.Set("result", promise);
  
  Napi::Array stdio = Napi::Array::New(env, 3);
  stdio.Set(uint32_t(0), Napi::Number::New(env, stdinPipe[1])); // Parent writes to index 1
  stdio.Set(uint32_t(1), Napi::Number::New(env, stdoutPipe[0])); // Parent reads from index 0
  stdio.Set(uint32_t(2), Napi::Number::New(env, stderrPipe[0])); // Parent reads from index 0
  result.Set("stdio", stdio);

  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("spawn",
              Napi::Function::New(env, SpawnProcess, "spawn"));
  return exports;
}

} // namespace

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
