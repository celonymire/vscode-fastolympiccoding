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
#include <sys/socket.h>
#include <sys/un.h>
#include <chrono>
#include <algorithm>

// macOS implementation using kqueue for efficient process monitoring
// Combined with resource limits enforced by polling and wait4 for stats
//
// Exports:
//   spawn(...) -> { pid: number, result: Promise<AddonResult> }
//

namespace {

// AsyncWorker for waiting on process completion
// Structure to hold process statistics
struct ProcessStats {
  uint64_t resident_size;
  uint64_t phys_footprint;
  uint64_t total_cpu_time_ns;
  bool success;
};

// Helper to get process stats using PROC_PIDRUSAGE
// This provides CPU time in nanoseconds (architecture independent)
// and strict memory usage (physical footprint).
static ProcessStats GetProcessStats(pid_t pid) {
  struct rusage_info_v2 ri;
  ProcessStats stats = {0, 0, 0, false};
  
  // Try to get usage info. return value is bytes written.
  if (proc_pidinfo(pid, PROC_PIDRUSAGE, 0, &ri, sizeof(ri)) > 0) {
    stats.resident_size = ri.ri_resident_size;
    stats.phys_footprint = ri.ri_phys_footprint;
    stats.total_cpu_time_ns = ri.ri_user_time + ri.ri_system_time;
    stats.success = true;
  }
  return stats;
}

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
    // Note: Resource limits (RLIMIT_CPU) are set in the child process
    // prior to exec(). RLIMIT_AS is NOT set because we enforce RSS via polling.

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
    if (kevent(kq_, kevs, 2, nullptr, 0, nullptr) == -1) {
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
       auto startTime = std::chrono::steady_clock::now();
       
       while (true) {
         struct kevent event;
         int nev = -1;
         struct timespec timeout;
         struct timespec* timeoutPtr = nullptr;
         
         // 50ms poll interval
         long intervalMs = 50;
         long waitMs = intervalMs;
         
         if (timeoutMs_ > 0) {
              auto now = std::chrono::steady_clock::now();
              auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - startTime).count();
              long remaining = (long)timeoutMs_ - elapsed;
              if (remaining <= 0) {
                  waitMs = 0; // Check one last time
              } else {
                  waitMs = std::min(intervalMs, remaining);
              }
         }
         
         timeout.tv_sec = waitMs / 1000;
         timeout.tv_nsec = (waitMs % 1000) * 1000000;
         timeoutPtr = &timeout;

         // Wait
         nev = kevent(kq_, nullptr, 0, &event, 1, timeoutPtr);
        
         if (nev == -1) {
            if (errno != EINTR && errno != ESRCH) {
                 errorMsg_ = "kevent failed: ";
                 errorMsg_ += std::strerror(errno);
                 return;
            }
         }

         // Check events
         if (nev > 0) {
             if (event.filter == EVFILT_USER) {
                 // Stop signal
                 kill(pid_, SIGKILL);
                 break;
             }
             if (event.filter == EVFILT_PROC) {
                 // Process exited
                 break;
             }
         }
         
          // Timeout or Interval Wakeup
          if (nev == 0) {
              // Check Process Stats (CPU and Memory)
              if (memoryLimitBytes_ > 0 || timeoutMs_ > 0) {
                  ProcessStats stats = GetProcessStats(pid_);
                  if (stats.success) {
                      // Check Memory
                      if (memoryLimitBytes_ > 0) {
                          if (stats.resident_size > memoryLimitBytes_) {
                              memoryLimitExceeded_ = true;
                              kill(pid_, SIGKILL);
                              break;
                          }
                      }
                      
                      // Check CPU Time
                      if (timeoutMs_ > 0) {
                          uint64_t cpuLimitNs = (uint64_t)timeoutMs_ * 1000000ULL;
                          if (stats.total_cpu_time_ns > cpuLimitNs) {
                              timedOut_ = true;
                              kill(pid_, SIGKILL);
                              break;
                          }
                      }
                  }
              }
              
              // Check Wall Clock Timeout (Safety net)
              if (timeoutMs_ > 0) {
                  auto now = std::chrono::steady_clock::now();
                  auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - startTime).count();
                  // Use a multiplier (e.g. 3x) for wall clock safety net to allow for I/O waits etc.
                  if (elapsed > (long)timeoutMs_ * 3) {
                      timedOut_ = true;
                      kill(pid_, SIGKILL);
                      break;
                  }
              }
          }
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

    // Post-mortem Memory Check: Catch spikes that happened between poll intervals
    if (memoryLimitBytes_ > 0 && peakMemoryBytes_ > memoryLimitBytes_) {
        memoryLimitExceeded_ = true;
    }

    // Analyze exit status
    if (WIFSIGNALED(status)) {
      int signal = WTERMSIG(status);
      
      if (signal == SIGXCPU) {
        // Process was killed by SIGXCPU - CPU time limit exceeded
        timedOut_ = true;
        exitCode_ = 128 + signal;
      } else if (signal == SIGKILL) {
        // Process was killed by SIGKILL.
        // Could be our manual kill (timeout/memory/stop) or external OOM.
        
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

    // Stdin: Read from socket
    int sockIn = connectSocket(pipeNameIn);
    // Stdout: Write to socket
    int sockOut = connectSocket(pipeNameOut);
    // Stderr: Write to socket
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

    // Close sockets
    close(sockIn);
    close(sockOut);
    close(sockErr);

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

  // Start monitoring immediataely
  auto worker = new WaitForProcessWorker(env, pid, timeoutMs, memoryLimitBytes);
  auto promise = worker->GetPromise();
  worker->Queue();

  Napi::Object result = Napi::Object::New(env);
  result.Set("pid", Napi::Number::New(env, pid));
  result.Set("result", promise);
  
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("spawn",
              Napi::Function::New(env, SpawnProcess, "spawn"));
  return exports;
}

} // namespace

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
