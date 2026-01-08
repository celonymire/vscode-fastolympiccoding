#include <napi.h>

#include <mach/mach.h>
#include <mach/mach_time.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <cstdint>
#include <string>

// macOS implementation for process timing and memory using libproc, mach APIs, and wait4.
//
// Exports:
//   waitForProcess(pid: number, timeoutMs: number) -> Promise<{ elapsedMs, cpuMs, peakMemoryBytes, exitCode, timedOut }>
//   getDarwinProcessTimes(pid: number) -> { elapsedMs: number, cpuMs: number }
//   getDarwinMemoryStats(pid: number) -> { rss: number, peakRss: number }
//
// Uses wait4 to get rusage stats directly from the kernel for accurate timing and memory.

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
      
      // Check memory limit using proc_pidinfo
      if (memoryLimitBytes_ > 0) {
        struct proc_taskinfo taskinfo;
        int ret = proc_pidinfo(pid_, PROC_PIDTASKINFO, 0, &taskinfo, sizeof(taskinfo));
        if (ret == sizeof(taskinfo)) {
          uint64_t currentRss = taskinfo.pti_resident_size;
          if (currentRss > memoryLimitBytes_) {
            memoryLimitExceeded_ = true;
            kill(pid_, SIGKILL);
            wait4(pid_, &status, 0, &rusage);
            processExited = true;
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

    // Get peak memory (ru_maxrss is in bytes on macOS)
    peakMemoryBytes_ = static_cast<uint64_t>(rusage.ru_maxrss);

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
    result.Set("timedOut", Napi::Boolean::New(env, timedOut_));
    
    deferred_.Resolve(result);
  }

  void OnError(const Napi::Error &e) override {
    deferred_.Reject(e.Value());
  }

private:
  pid_t pid_;
  uint32_t timeoutMs_;
  Napi::Promise::Deferred deferred_;
  double elapsedMs_;
  double cpuMs_;
  uint64_t peakMemoryBytes_;
  int exitCode_;
  bool timedOut_;
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

// Synchronous function to get current process times
Napi::Value GetDarwinProcessTimes(const Napi::CallbackInfo &info) {
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

  int32_t pid = info[0].As<Napi::Number>().Int32Value();

  if (pid < 1) {
    Napi::RangeError::New(env, "PID must be positive")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Get process info using proc_pidinfo
  struct proc_taskinfo taskinfo;
  int ret = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &taskinfo, sizeof(taskinfo));
  
  if (ret != sizeof(taskinfo)) {
    Napi::Error::New(env, "Failed to get process info (process may have exited)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Get basic process info for start time
  struct proc_bsdinfo bsdinfo;
  ret = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsdinfo, sizeof(bsdinfo));
  
  if (ret != sizeof(bsdinfo)) {
    Napi::Error::New(env, "Failed to get process BSD info")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Get current time
  struct timeval now;
  gettimeofday(&now, nullptr);
  uint64_t nowMicros = static_cast<uint64_t>(now.tv_sec) * 1000000ULL + 
                       static_cast<uint64_t>(now.tv_usec);

  // Calculate process start time in microseconds
  uint64_t startMicros = static_cast<uint64_t>(bsdinfo.pbi_start_tvsec) * 1000000ULL + 
                         static_cast<uint64_t>(bsdinfo.pbi_start_tvusec);

  // Calculate elapsed wall-clock time
  uint64_t elapsedMicros = nowMicros - startMicros;
  double elapsedMs = static_cast<double>(elapsedMicros) / 1000.0;

  // Calculate total CPU time (user + system)
  // taskinfo times are in nanoseconds
  uint64_t userTimeNanos = taskinfo.pti_total_user;
  uint64_t systemTimeNanos = taskinfo.pti_total_system;
  uint64_t cpuNanos = userTimeNanos + systemTimeNanos;
  double cpuMs = static_cast<double>(cpuNanos) / 1000000.0;

  Napi::Object result = Napi::Object::New(env);
  result.Set("elapsedMs", Napi::Number::New(env, elapsedMs));
  result.Set("cpuMs", Napi::Number::New(env, cpuMs));
  return result;
}

// Synchronous function to get current memory stats
Napi::Value GetDarwinMemoryStats(const Napi::CallbackInfo &info) {
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

  int32_t pid = info[0].As<Napi::Number>().Int32Value();

  if (pid < 1) {
    Napi::RangeError::New(env, "PID must be positive")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Get process task info which includes memory stats
  struct proc_taskinfo taskinfo;
  int ret = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &taskinfo, sizeof(taskinfo));
  
  if (ret != sizeof(taskinfo)) {
    Napi::Error::New(env, "Failed to get process info (process may have exited)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // pti_resident_size: current resident memory in bytes
  // Note: macOS doesn't provide a direct "peak RSS" in proc_pidinfo like Linux/Windows
  // We would need to track it ourselves or use different APIs
  // For now, return current RSS as both values
  uint64_t rssBytes = taskinfo.pti_resident_size;

  Napi::Object result = Napi::Object::New(env);
  result.Set("rss", Napi::Number::New(env, static_cast<double>(rssBytes)));
  result.Set("peakRss", Napi::Number::New(env, static_cast<double>(rssBytes)));
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("waitForProcess",
              Napi::Function::New(env, WaitForProcess, "waitForProcess"));
  exports.Set("getDarwinProcessTimes",
              Napi::Function::New(env, GetDarwinProcessTimes,
                                  "getDarwinProcessTimes"));
  exports.Set("getDarwinMemoryStats",
              Napi::Function::New(env, GetDarwinMemoryStats,
                                  "getDarwinMemoryStats"));
  return exports;
}

} // namespace

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
