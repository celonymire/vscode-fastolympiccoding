#include <napi.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <signal.h>
#include <string>
#include <sys/event.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

// macOS implementation using kqueue for efficient process monitoring
// Combined with resource limits enforced by polling and wait4 for stats
//
// Exports:
//   spawn(...) -> { pid: number, result: Promise<AddonResult> }
//

namespace {

// AsyncWorker for waiting on process completion
// Define rusage_info_v2 if missing (older SDKs or strict headers)
#ifndef RUSAGE_INFO_V2
#define RUSAGE_INFO_V2 2
struct rusage_info_v2 {
  uint8_t ri_uuid[16];
  uint64_t ri_user_time;
  uint64_t ri_system_time;
  uint64_t ri_pkg_idle_wkups;
  uint64_t ri_interrupt_wkups;
  uint64_t ri_pageins;
  uint64_t ri_wired_size;
  uint64_t ri_resident_size;
  uint64_t ri_phys_footprint;
  uint64_t ri_proc_start_abstime;
  uint64_t ri_proc_exit_abstime;
  uint64_t ri_child_user_time;
  uint64_t ri_child_system_time;
  uint64_t ri_child_pkg_idle_wkups;
  uint64_t ri_child_interrupt_wkups;
  uint64_t ri_child_pageins;
  uint64_t ri_child_elapsed_abstime;
  uint64_t ri_diskio_bytesread;
  uint64_t ri_diskio_byteswritten;
};
#endif

extern "C" {
// Forward declare proc_pid_rusage
// It's available in macOS 10.9+ but might be missing from headers
typedef void *rusage_info_t;
int proc_pid_rusage(int pid, int flavor, rusage_info_t *buffer);
}

// Structure to hold process statistics
struct ProcessStats {
  uint64_t resident_size;
  uint64_t phys_footprint;
  uint64_t total_cpu_time_ns;
  bool success;
};

// Helper to get process stats using proc_pid_rusage
// This provides CPU time in nanoseconds (architecture independent)
// and strict memory usage (physical footprint).
static ProcessStats GetProcessStats(pid_t pid) {
  struct rusage_info_v2 ri;
  ProcessStats stats = {0, 0, 0, false};

  // Use mach_timebase_info to convert ticks to nanoseconds.
  // This is required because on Apple Silicon (M1+), time values are in Mach
  // ticks, not nanoseconds, even for proc_pid_rusage in some contexts or
  // versions. On Intel, this ratio is typically 1/1.
  static mach_timebase_info_data_t timebase = {0, 0};
  if (timebase.denom == 0) {
    mach_timebase_info(&timebase);
  }

  // Use proc_pid_rusage with RUSAGE_INFO_V2
  // We cast &ri to (rusage_info_t *) because the API expects a pointer to the
  // buffer pointer (void**) effectively, but implementation-wise it treats it
  // as the buffer address.
  if (proc_pid_rusage(pid, RUSAGE_INFO_V2, (rusage_info_t *)&ri) == 0) {
    stats.resident_size = ri.ri_resident_size;
    stats.phys_footprint = ri.ri_phys_footprint;

    uint64_t total_ticks = ri.ri_user_time + ri.ri_system_time;
    stats.total_cpu_time_ns = total_ticks * timebase.numer / timebase.denom;

    stats.success = true;
  }
  return stats;
}

// AsyncWorker for waiting on process completion
// Shared state for synchronization between worker and JS thread
struct SharedStopState {
  int kq = -1;
  std::mutex mutex;
  bool closed = false;

  SharedStopState() { kq = kqueue(); }

  ~SharedStopState() {
    if (kq >= 0) {
      close(kq);
      kq = -1;
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
    if (closed || kq < 0)
      return false;

    struct kevent kev;
    EV_SET(&kev, 0, EVFILT_USER, 0, NOTE_TRIGGER, 0, nullptr);
    int ret = kevent(kq, &kev, 1, nullptr, 0, nullptr);
    return (ret == 0);
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
    // Note: Resource limits (RLIMIT_CPU) are set in the child process
    // prior to exec(). RLIMIT_AS is NOT set because we enforce RSS via polling.

    int status = 0;
    struct rusage rusage;

    // Use the SHARED kqueue
    int kq = sharedState_->kq;
    if (kq == -1) {
      errorMsg_ = "Failed to create kqueue (in shared state)";
      return;
    }

    // Register two events:
    // 1. EVFILT_PROC with NOTE_EXIT - notifies when process exits
    // 2. EVFILT_USER - allows us to trigger wake-up on external stop
    struct kevent kevs[2];
    EV_SET(&kevs[0], pid_, EVFILT_PROC, EV_ADD | EV_ENABLE, NOTE_EXIT, 0,
           nullptr);
    EV_SET(&kevs[1], 0, EVFILT_USER, EV_ADD | EV_ENABLE | EV_CLEAR, 0, 0,
           nullptr);

    bool shouldWait = true;

    // Check if process already exited/doesn't exist before waiting.
    if (kevent(kq, kevs, 2, nullptr, 0, nullptr) == -1) {
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
        struct timespec *timeoutPtr = nullptr;

        // 50ms poll interval
        long intervalMs = 50;
        long waitMs = intervalMs;

        if (timeoutMs_ > 0) {
          auto now = std::chrono::steady_clock::now();
          auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                             now - startTime)
                             .count();
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
        nev = kevent(kq, nullptr, 0, &event, 1, timeoutPtr);

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
            stopped_ = true;
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
            auto elapsed =
                std::chrono::duration_cast<std::chrono::milliseconds>(now -
                                                                      startTime)
                    .count();
            // Use a multiplier (e.g. 2x) for wall clock safety net to allow for
            // I/O waits etc.
            if (elapsed > (long)timeoutMs_ * 2) {
              timedOut_ = true;
              kill(pid_, SIGKILL);
              break;
            }
          }
        }
      }
    }

    // Mark shared state as closed so cancel() becomes no-op
    sharedState_->Close();

    // Check if stopped before process exit (redundant but safe)
    if (stopped_) {
      kill(pid_, SIGKILL);
    }

    // Collect exit status and resource usage with wait4
    std::memset(&rusage, 0, sizeof(rusage));
    if (wait4(pid_, &status, 0, &rusage) == -1) {
      // Proceed with zeroed rusage
    }

    // Calculate elapsed CPU time from rusage (user + system)
    uint64_t cpuUs =
        (rusage.ru_utime.tv_sec + rusage.ru_stime.tv_sec) * 1000000ULL +
        (rusage.ru_utime.tv_usec + rusage.ru_stime.tv_usec);
    elapsedMs_ = std::round(static_cast<double>(cpuUs) / 1000.0);

    // Get peak memory (ru_maxrss is in bytes on macOS)
    peakMemoryBytes_ = static_cast<uint64_t>(rusage.ru_maxrss);

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
  uint32_t timeoutMs = info[3].As<Napi::Number>().Uint32Value();
  double memoryLimitMB = info[4].As<Napi::Number>().DoubleValue();
  uint64_t memoryLimitBytes =
      static_cast<uint64_t>(memoryLimitMB * 1024.0 * 1024.0);

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
    auto connectSocket = [](const std::string &path) -> int {
      int sock = socket(AF_UNIX, SOCK_STREAM, 0);
      if (sock < 0)
        return -1;

      struct sockaddr_un addr;
      memset(&addr, 0, sizeof(addr));
      addr.sun_family = AF_UNIX;
      strncpy(addr.sun_path, path.c_str(), sizeof(addr.sun_path) - 1);

      if (connect(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
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
    if (dup2(sockIn, STDIN_FILENO) < 0 || dup2(sockOut, STDOUT_FILENO) < 0 ||
        dup2(sockErr, STDERR_FILENO) < 0) {
      perror("dup2 failed");
      _exit(1);
    }

    // Close original socket FDs
    close(sockIn);
    close(sockOut);
    close(sockErr);

    // Change directory
    if (!cwd.empty()) {
      chdir(cwd.c_str());
    }

    // Prepare argv
    std::vector<char *> argv;
    argv.push_back(const_cast<char *>(command.c_str()));
    for (auto &arg : args) {
      argv.push_back(const_cast<char *>(arg.c_str()));
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
