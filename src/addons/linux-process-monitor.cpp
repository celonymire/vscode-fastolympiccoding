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

// Linux implementation using wait4 for accurate timing and memory stats
//
// Exports:
//   waitForProcess(pid: number, timeoutMs: number) -> Promise<{ elapsedMs, cpuMs, peakMemoryBytes, exitCode, timedOut }>
//   getLinuxProcessTimes(pid: number) -> { elapsedMs: number, cpuMs: number }
//
// The waitForProcess function uses wait4 to get rusage stats directly from the kernel

namespace {

// AsyncWorker for waiting on process completion
class WaitForProcessWorker : public Napi::AsyncWorker {
public:
  WaitForProcessWorker(Napi::Env &env, pid_t pid, uint32_t timeoutMs, uint64_t memoryLimitBytes)
      : Napi::AsyncWorker(env), pid_(pid), timeoutMs_(timeoutMs),
        memoryLimitBytes_(memoryLimitBytes), deferred_(env), elapsedMs_(0.0), cpuMs_(0.0), peakMemoryBytes_(0),
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

    int status = 0;
    struct rusage rusage;
    bool processExited = false;
    
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

    // Get end time
    struct timeval endTime;
    gettimeofday(&endTime, nullptr);

    // Calculate elapsed wall-clock time
    elapsedUs = (endTime.tv_sec - startTime.tv_sec) * 1000000ULL +
                (endTime.tv_usec - startTime.tv_usec);
    elapsedMs_ = static_cast<double>(elapsedUs) / 1000.0;

    // Calculate CPU time from rusage
    uint64_t cpuUs = (rusage.ru_utime.tv_sec + rusage.ru_stime.tv_sec) * 1000000ULL +
                     (rusage.ru_utime.tv_usec + rusage.ru_stime.tv_usec);
    cpuMs_ = static_cast<double>(cpuUs) / 1000.0;

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
    result.Set("cpuMs", Napi::Number::New(env, cpuMs_));
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
  double cpuMs_;
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

// Keep the synchronous version for compatibility
Napi::Value GetLinuxProcessTimes(const Napi::CallbackInfo &info) {
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

  uint64_t startTimeJiffies = 0;
  uint64_t utimeJiffies = 0;
  uint64_t stimeJiffies = 0;
  std::string err;
  if (!ReadProcStat(pid, startTimeJiffies, utimeJiffies, stimeJiffies, err)) {
    Napi::Error::New(env, err).ThrowAsJavaScriptException();
    return env.Null();
  }

  double systemUptimeSeconds = 0.0;
  if (!ReadSystemUptime(systemUptimeSeconds, err)) {
    Napi::Error::New(env, err).ThrowAsJavaScriptException();
    return env.Null();
  }

  long clockTicksPerSecond = sysconf(_SC_CLK_TCK);
  if (clockTicksPerSecond <= 0) {
    Napi::Error::New(env, "Failed to get _SC_CLK_TCK")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  double processStartSeconds =
      static_cast<double>(startTimeJiffies) / clockTicksPerSecond;
  double elapsedSeconds = systemUptimeSeconds - processStartSeconds;
  double elapsedMs = elapsedSeconds * 1000.0;

  double cpuSeconds = static_cast<double>(utimeJiffies + stimeJiffies) /
                      clockTicksPerSecond;
  double cpuMs = cpuSeconds * 1000.0;

  Napi::Object result = Napi::Object::New(env);
  result.Set("elapsedMs", Napi::Number::New(env, elapsedMs));
  result.Set("cpuMs", Napi::Number::New(env, cpuMs));
  return result;
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

Napi::Value GetLinuxMemoryStats(const Napi::CallbackInfo &info) {
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

  uint64_t rssBytes = 0;
  uint64_t peakRssBytes = 0;
  std::string err;
  if (!ReadProcStatusMemory(pid, rssBytes, peakRssBytes, err)) {
    Napi::Error::New(env, err).ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("rss", Napi::Number::New(env, static_cast<double>(rssBytes)));
  result.Set("peakRss",
             Napi::Number::New(env, static_cast<double>(peakRssBytes)));
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("waitForProcess",
              Napi::Function::New(env, WaitForProcess, "waitForProcess"));
  exports.Set("getLinuxProcessTimes",
              Napi::Function::New(env, GetLinuxProcessTimes,
                                  "getLinuxProcessTimes"));
  exports.Set("getLinuxMemoryStats",
              Napi::Function::New(env, GetLinuxMemoryStats,
                                  "getLinuxMemoryStats"));
  return exports;
}

} // namespace

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
