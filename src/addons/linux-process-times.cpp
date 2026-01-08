#include <napi.h>

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <unistd.h>

// Linux-only procfs implementation for process timing.
//
// Exports:
//   getLinuxProcessTimes(pid: number) -> { elapsedMs: number, cpuMs: number }
//
// Semantics:
// - elapsedMs: wall-clock time since process start in milliseconds
// - cpuMs: total CPU time (user + system) in milliseconds
// - Both values are best-effort for a running process.
// - Throws JS exceptions on invalid input or if /proc/<pid>/stat cannot be
// read.

namespace {

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

  // /proc/<pid>/stat format (fields separated by spaces):
  // pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt
  // majflt cmajflt utime stime cutime cstime priority nice num_threads
  // itrealvalue starttime ...
  //
  // We need:
  // - field 14: utime (CPU time in user mode, in clock ticks)
  // - field 15: stime (CPU time in kernel mode, in clock ticks)
  // - field 22: starttime (time the process started after system boot, in clock
  // ticks)

  int pidRead;
  char comm[256];
  char state;
  // Read first 3 fields: pid (comm) state
  int matched = std::fscanf(f, "%d %255s %c", &pidRead, comm, &state);
  if (matched != 3) {
    std::fclose(f);
    err = "Failed to parse /proc/<pid>/stat (header)";
    return false;
  }

  // Skip fields 4-13 (ppid through cmajflt)
  unsigned long long dummy;
  for (int i = 0; i < 10; ++i) {
    if (std::fscanf(f, "%llu", &dummy) != 1) {
      std::fclose(f);
      err = "Failed to parse /proc/<pid>/stat (skip fields)";
      return false;
    }
  }

  // Read fields 14-15: utime, stime
  unsigned long long utime, stime;
  if (std::fscanf(f, "%llu %llu", &utime, &stime) != 2) {
    std::fclose(f);
    err = "Failed to parse /proc/<pid>/stat (utime/stime)";
    return false;
  }

  // Skip fields 16-21
  for (int i = 0; i < 6; ++i) {
    if (std::fscanf(f, "%llu", &dummy) != 1) {
      std::fclose(f);
      err = "Failed to parse /proc/<pid>/stat (skip to starttime)";
      return false;
    }
  }

  // Read field 22: starttime
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

// Read system uptime from /proc/uptime (in seconds)
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

Napi::Value GetLinuxProcessTimes(const Napi::CallbackInfo &info) {
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

  uint32_t pid = info[0].As<Napi::Number>().Uint32Value();

  // Linux PIDs are positive.
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

  // Get clock ticks per second (typically 100 on Linux)
  long clockTicksPerSecond = sysconf(_SC_CLK_TCK);
  if (clockTicksPerSecond <= 0) {
    Napi::Error::New(env, "Failed to get _SC_CLK_TCK")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Calculate process start time in seconds since boot
  double processStartSeconds =
      static_cast<double>(startTimeJiffies) / clockTicksPerSecond;

  // Calculate elapsed wall-clock time since process start
  double elapsedSeconds = systemUptimeSeconds - processStartSeconds;
  double elapsedMs = elapsedSeconds * 1000.0;

  // Calculate total CPU time (user + system) in milliseconds
  double cpuSeconds = static_cast<double>(utimeJiffies + stimeJiffies) /
                      clockTicksPerSecond;
  double cpuMs = cpuSeconds * 1000.0;

  Napi::Object result = Napi::Object::New(env);
  result.Set("elapsedMs", Napi::Number::New(env, elapsedMs));
  result.Set("cpuMs", Napi::Number::New(env, cpuMs));
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getLinuxProcessTimes",
              Napi::Function::New(env, GetLinuxProcessTimes,
                                  "getLinuxProcessTimes"));
  return exports;
}

} // namespace

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
