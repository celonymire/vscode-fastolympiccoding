#include <napi.h>

#include <mach/mach.h>
#include <mach/mach_time.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <cstdint>
#include <string>

// macOS implementation for process timing using libproc and mach APIs.
//
// Exports:
//   getDarwinProcessTimes(pid: number) -> { elapsedMs: number, cpuMs: number }
//
// Semantics:
// - elapsedMs: wall-clock time since process start in milliseconds
// - cpuMs: total CPU time (user + system) in milliseconds
// - Both values are best-effort for a running process.
// - Throws JS exceptions on invalid input or if process info cannot be read.

namespace {

// Get current time in microseconds using mach_absolute_time
static uint64_t GetCurrentTimeMicroseconds() {
  static mach_timebase_info_data_t timebase_info;
  static bool initialized = false;
  
  if (!initialized) {
    mach_timebase_info(&timebase_info);
    initialized = true;
  }
  
  uint64_t abs_time = mach_absolute_time();
  // Convert to nanoseconds, then to microseconds
  uint64_t nanos = abs_time * timebase_info.numer / timebase_info.denom;
  return nanos / 1000;
}

// Get boot time in microseconds
static bool GetBootTimeMicroseconds(uint64_t &bootTimeMicros, std::string &err) {
  struct timeval boottime;
  size_t len = sizeof(boottime);
  int mib[2] = { CTL_KERN, KERN_BOOTTIME };
  
  if (sysctl(mib, 2, &boottime, &len, nullptr, 0) != 0) {
    err = "Failed to get boot time via sysctl";
    return false;
  }
  
  bootTimeMicros = static_cast<uint64_t>(boottime.tv_sec) * 1000000ULL + 
                   static_cast<uint64_t>(boottime.tv_usec);
  return true;
}

Napi::Value GetDarwinProcessTimes(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  // Validate args.
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

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getDarwinProcessTimes",
              Napi::Function::New(env, GetDarwinProcessTimes,
                                  "getDarwinProcessTimes"));
  return exports;
}

} // namespace

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
