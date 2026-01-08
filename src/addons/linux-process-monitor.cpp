#include <napi.h>

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <sys/time.h>
#include <poll.h>
#include <sys/syscall.h>

// Linux implementation using pidfd_open + poll for efficient process monitoring
// and wait4 for accurate timing and memory stats
//
// Exports:
//   waitForProcess(pid: number, timeoutMs: number) -> Promise<{ elapsedMs, cpuMs, peakMemoryBytes, exitCode, timedOut }>
//   getLinuxProcessStats(pid: number) -> { elapsedMs: number, rss: number, peakRss: number }
//
// The waitForProcess function uses:
//  - pidfd_open + poll for efficient waiting (kernel notification instead of polling)
//  - wait4 to get rusage stats directly from the kernel

// pidfd_open syscall wrapper (available since Linux 5.3)
static int pidfd_open(pid_t pid, unsigned int flags) {
  return syscall(SYS_pidfd_open, pid, flags);
}

namespace {

// AsyncWorker for waiting on process completion
class WaitForProcessWorker : public Napi::AsyncWorker {
public:
  WaitForProcessWorker(Napi::Env &env, pid_t pid, uint32_t timeoutMs, uint64_t memoryLimitBytes)
      : Napi::AsyncWorker(env), pid_(pid), timeoutMs_(timeoutMs),
        memoryLimitBytes_(memoryLimitBytes), deferred_(env), elapsedMs_(0.0), peakMemoryBytes_(0),
        exitCode_(0), timedOut_(false), memoryLimitExceeded_(false), stopped_(false), errorMsg_("") {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // Allow external stop request
  void Stop() {
    stopped_ = true;
  }

protected:
  void Execute() override {
    struct timeval startTime;
    gettimeofday(&startTime, nullptr);

    // Try to open pidfd for efficient waiting (requires Linux 5.3+)
    int pidfd = pidfd_open(pid_, 0);
    bool usePidfd = (pidfd >= 0);

    int status = 0;
    struct rusage rusage;
    bool processExited = false;
    
    if (usePidfd) {
      // Use pidfd + poll for efficient waiting (no polling overhead)
      struct pollfd pfd;
      pfd.fd = pidfd;
      pfd.events = POLLIN;
      
      while (!processExited && !stopped_) {
        // Calculate remaining timeout
        int pollTimeout = -1; // Infinite by default
        if (timeoutMs_ > 0) {
          struct timeval now;
          gettimeofday(&now, nullptr);
          uint64_t elapsedUs = (now.tv_sec - startTime.tv_sec) * 1000000ULL +
                               (now.tv_usec - startTime.tv_usec);
          uint64_t timeoutUs = static_cast<uint64_t>(timeoutMs_) * 1000;
          
          if (elapsedUs >= timeoutUs) {
            // Time limit exceeded
            timedOut_ = true;
            close(pidfd);
            kill(pid_, SIGKILL);
            wait4(pid_, &status, 0, &rusage);
            processExited = true;
            break;
          }
          
          pollTimeout = (timeoutUs - elapsedUs) / 1000; // Convert to milliseconds
          if (pollTimeout > 100) {
            pollTimeout = 100; // Check memory limit every 100ms
          }
        } else {
          pollTimeout = 100; // Check memory/stop every 100ms even without timeout
        }
        
        int pollResult = poll(&pfd, 1, pollTimeout);
        
        if (pollResult > 0 && (pfd.revents & POLLIN)) {
          // Process exited
          close(pidfd);
          pid_t result = wait4(pid_, &status, WNOHANG, &rusage);
          if (result == pid_) {
            processExited = true;
            break;
          }
        } else if (pollResult == -1) {
          if (errno != EINTR) {
            close(pidfd);
            errorMsg_ = "poll failed: ";
            errorMsg_ += std::strerror(errno);
            return;
          }
          // EINTR is okay, just continue
        }
        
        // Check memory limit if specified
        if (memoryLimitBytes_ > 0) {
          char path[64];
          snprintf(path, sizeof(path), "/proc/%d/status", pid_);
          FILE *f = fopen(path, "r");
          if (f) {
            char line[256];
            while (fgets(line, sizeof(line), f)) {
              if (strncmp(line, "VmRSS:", 6) == 0) {
                unsigned long long rssKB = 0;
                if (sscanf(line + 6, "%llu", &rssKB) == 1) {
                  uint64_t rssBytes = rssKB * 1024ULL;
                  if (rssBytes > memoryLimitBytes_) {
                    memoryLimitExceeded_ = true;
                    fclose(f);
                    close(pidfd);
                    kill(pid_, SIGKILL);
                    wait4(pid_, &status, 0, &rusage);
                    processExited = true;
                    break;
                  }
                }
                break;
              }
            }
            fclose(f);
            
            if (memoryLimitExceeded_) {
              break;
            }
          }
        }
      }
      
      // Handle external stop request
      if (stopped_ && !processExited) {
        close(pidfd);
        kill(pid_, SIGKILL);
        wait4(pid_, &status, 0, &rusage);
      }
    } else {
      // Fallback to manual polling with wait4 if pidfd_open not available
      const uint64_t pollIntervalUs = 50000; // 50ms poll interval
      uint64_t elapsedUs = 0;
      
      while (!processExited && !stopped_) {
        pid_t result = wait4(pid_, &status, WNOHANG, &rusage);
        
        if (result == -1) {
          errorMsg_ = "wait4 failed: ";
          errorMsg_ += std::strerror(errno);
          return;
        }
        
        if (result == pid_) {
          // Process exited normally
          processExited = true;
          break;
        }
        
        // Process still running, check limits
        struct timeval now;
        gettimeofday(&now, nullptr);
        elapsedUs = (now.tv_sec - startTime.tv_sec) * 1000000ULL +
                    (now.tv_usec - startTime.tv_usec);
        
        // Check time limit
        if (timeoutMs_ > 0 && elapsedUs >= static_cast<uint64_t>(timeoutMs_) * 1000) {
          timedOut_ = true;
          kill(pid_, SIGKILL);
          wait4(pid_, &status, 0, &rusage);
          processExited = true;
          break;
        }
        
        // Check memory limit
        if (memoryLimitBytes_ > 0) {
          // Read current memory from /proc/<pid>/status
          char path[64];
          snprintf(path, sizeof(path), "/proc/%d/status", pid_);
          FILE *f = fopen(path, "r");
          if (f) {
            char line[256];
            while (fgets(line, sizeof(line), f)) {
              if (strncmp(line, "VmRSS:", 6) == 0) {
                unsigned long long rssKB = 0;
                if (sscanf(line + 6, "%llu", &rssKB) == 1) {
                  uint64_t rssBytes = rssKB * 1024ULL;
                  if (rssBytes > memoryLimitBytes_) {
                    memoryLimitExceeded_ = true;
                    fclose(f);
                    kill(pid_, SIGKILL);
                    wait4(pid_, &status, 0, &rusage);
                    processExited = true;
                    break;
                  }
                }
                break;
              }
            }
            fclose(f);
            
            if (memoryLimitExceeded_) {
              break;
            }
          }
        }
        
        // Sleep before next poll
        usleep(pollIntervalUs);
      }
      
      // Handle external stop request
      if (stopped_ && !processExited) {
        kill(pid_, SIGKILL);
        wait4(pid_, &status, 0, &rusage);
      }
    }

    // Get end time
    struct timeval endTime;
    gettimeofday(&endTime, nullptr);

    // Calculate elapsed CPU time from rusage (user + system)
    uint64_t cpuUs = (rusage.ru_utime.tv_sec + rusage.ru_stime.tv_sec) * 1000000ULL +
                     (rusage.ru_utime.tv_usec + rusage.ru_stime.tv_usec);
    elapsedMs_ = static_cast<double>(cpuUs) / 1000.0;

    // Get peak memory (in kilobytes on Linux, convert to bytes)
    peakMemoryBytes_ = static_cast<uint64_t>(rusage.ru_maxrss) * 1024ULL;

    // Get exit code
    if (WIFEXITED(status)) {
      exitCode_ = WEXITSTATUS(status);
    } else if (WIFSIGNALED(status)) {
      exitCode_ = 128 + WTERMSIG(status);
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
};

Napi::Value WaitForProcess(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 3) {
    Napi::TypeError::New(env, "PID, timeout, and memoryLimit arguments are required")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  if (!info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "PID, timeout, and memoryLimit must be numbers")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  int32_t pid = info[0].As<Napi::Number>().Int32Value();
  uint32_t timeoutMs = info[1].As<Napi::Number>().Uint32Value();
  double memoryLimitMB = info[2].As<Napi::Number>().DoubleValue();
  uint64_t memoryLimitBytes = static_cast<uint64_t>(memoryLimitMB * 1024.0 * 1024.0);

  if (pid < 1) {
    Napi::RangeError::New(env, "PID must be positive")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  auto worker = new WaitForProcessWorker(env, pid, timeoutMs, memoryLimitBytes);
  worker->Queue();
  return worker->GetPromise();
}

// Read /proc/<pid>/stat to get process start time (in clock ticks since boot)
// and CPU times (utime, stime in clock ticks)
bool ReadProcStat(uint32_t pid, uint64_t &startTimeJiffies, uint64_t &utimeJiffies,
                  uint64_t &stimeJiffies, std::string &err) {
  char path[64];
  std::snprintf(path, sizeof(path), "/proc/%u/stat", pid);

  std::FILE *f = std::fopen(path, "r");
  if (!f) {
    err = "Failed to open ";
    err += path;
    err += ": ";
    err += std::strerror(errno);
    return false;
  }

  int pidRead;
  char comm[256];
  char state;
  int matched = std::fscanf(f, "%d %255s %c", &pidRead, comm, &state);
  if (matched != 3) {
    std::fclose(f);
    err = "Failed to parse /proc/<pid>/stat (header)";
    return false;
  }

  unsigned long long dummy;
  for (int i = 0; i < 10; ++i) {
    if (std::fscanf(f, "%llu", &dummy) != 1) {
      std::fclose(f);
      err = "Failed to parse /proc/<pid>/stat (skip fields)";
      return false;
    }
  }

  unsigned long long utime, stime;
  if (std::fscanf(f, "%llu %llu", &utime, &stime) != 2) {
    std::fclose(f);
    err = "Failed to parse /proc/<pid>/stat (utime/stime)";
    return false;
  }

  for (int i = 0; i < 6; ++i) {
    if (std::fscanf(f, "%llu", &dummy) != 1) {
      std::fclose(f);
      err = "Failed to parse /proc/<pid>/stat (skip to starttime)";
      return false;
    }
  }

  unsigned long long starttime;
  if (std::fscanf(f, "%llu", &starttime) != 1) {
    std::fclose(f);
    err = "Failed to parse /proc/<pid>/stat (starttime)";
    return false;
  }

  std::fclose(f);

  utimeJiffies = utime;
  stimeJiffies = stime;
  startTimeJiffies = starttime;
  return true;
}

bool ReadSystemUptime(double &uptimeSeconds, std::string &err) {
  std::FILE *f = std::fopen("/proc/uptime", "r");
  if (!f) {
    err = "Failed to open /proc/uptime: ";
    err += std::strerror(errno);
    return false;
  }

  double uptime, idletime;
  if (std::fscanf(f, "%lf %lf", &uptime, &idletime) != 2) {
    std::fclose(f);
    err = "Failed to parse /proc/uptime";
    return false;
  }

  std::fclose(f);
  uptimeSeconds = uptime;
  return true;
}

// Helper to parse memory lines from /proc/<pid>/status
bool ParseKbLineToBytes(const char *line, const char *prefix,
                        uint64_t &outBytes) {
  const size_t prefixLen = std::strlen(prefix);
  if (std::strncmp(line, prefix, prefixLen) != 0) {
    return false;
  }

  const char *p = line + prefixLen;
  while (*p == ' ' || *p == '\t') {
    ++p;
  }

  errno = 0;
  char *end = nullptr;
  unsigned long long kb = std::strtoull(p, &end, 10);
  if (errno != 0 || end == p) {
    return false;
  }

  outBytes = static_cast<uint64_t>(kb) * 1024ULL;
  return true;
}

bool ReadProcStatusMemory(uint32_t pid, uint64_t &rssBytes, uint64_t &peakRssBytes,
                    std::string &err) {
  rssBytes = 0;
  peakRssBytes = 0;

  char path[64];
  std::snprintf(path, sizeof(path), "/proc/%u/status", pid);

  std::FILE *f = std::fopen(path, "r");
  if (!f) {
    err = "Failed to open ";
    err += path;
    err += ": ";
    err += std::strerror(errno);
    return false;
  }

  char buf[512];
  bool foundRss = false;
  bool foundPeak = false;

  while (std::fgets(buf, sizeof(buf), f) != nullptr) {
    if (!foundRss) {
      uint64_t v = 0;
      if (ParseKbLineToBytes(buf, "VmRSS:", v)) {
        rssBytes = v;
        foundRss = true;
      }
    }

    if (!foundPeak) {
      uint64_t v = 0;
      if (ParseKbLineToBytes(buf, "VmHWM:", v)) {
        peakRssBytes = v;
        foundPeak = true;
      }
    }

    if (foundRss && foundPeak) {
      break;
    }
  }

  std::fclose(f);

  if (!foundRss && !foundPeak) {
    err = "Failed to find VmRSS/VmHWM in /proc/<pid>/status (process may have exited)";
    return false;
  }

  if (!foundPeak) {
    peakRssBytes = rssBytes;
  }

  if (!foundRss) {
    rssBytes = peakRssBytes;
  }

  return true;
}

// Combined function to get process stats (elapsed CPU time and memory)
Napi::Value GetLinuxProcessStats(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1) {
    Napi::TypeError::New(env, "PID argument is required")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  if (!info[0].IsNumber()) {
    Napi::TypeError::New(env, "PID must be a number")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  uint32_t pid = info[0].As<Napi::Number>().Uint32Value();

  if (pid < 1 || pid > 4194304) {
    Napi::RangeError::New(env, "PID is out of range")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Get CPU times from /proc/<pid>/stat
  uint64_t startTimeJiffies = 0;
  uint64_t utimeJiffies = 0;
  uint64_t stimeJiffies = 0;
  std::string err;
  if (!ReadProcStat(pid, startTimeJiffies, utimeJiffies, stimeJiffies, err)) {
    Napi::Error::New(env, err).ThrowAsJavaScriptException();
    return env.Null();
  }

  long clockTicksPerSecond = sysconf(_SC_CLK_TCK);
  if (clockTicksPerSecond <= 0) {
    Napi::Error::New(env, "Failed to get _SC_CLK_TCK")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Calculate elapsed CPU time (user + system)
  double cpuSeconds = static_cast<double>(utimeJiffies + stimeJiffies) /
                      clockTicksPerSecond;
  double elapsedMs = cpuSeconds * 1000.0;

  // Get memory stats from /proc/<pid>/status
  uint64_t rssBytes = 0;
  uint64_t peakRssBytes = 0;
  if (!ReadProcStatusMemory(pid, rssBytes, peakRssBytes, err)) {
    Napi::Error::New(env, err).ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("elapsedMs", Napi::Number::New(env, elapsedMs));
  result.Set("rss", Napi::Number::New(env, static_cast<double>(rssBytes)));
  result.Set("peakRss",
             Napi::Number::New(env, static_cast<double>(peakRssBytes)));
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("waitForProcess",
              Napi::Function::New(env, WaitForProcess, "waitForProcess"));
  exports.Set("getLinuxProcessStats",
              Napi::Function::New(env, GetLinuxProcessStats,
                                  "getLinuxProcessStats"));
  return exports;
}

} // namespace

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
