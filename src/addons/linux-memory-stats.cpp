#include <napi.h>

#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

// Linux-only procfs implementation.
//
// Exports:
//   getLinuxMemoryStats(pid: number) -> { rss: number, peakRss: number }
//
// Semantics:
// - rss: current resident set size in bytes (from /proc/<pid>/status: VmRSS)
// - peakRss: peak resident set size in bytes (from /proc/<pid>/status: VmHWM)
// - Both values are best-effort for a running process.
// - Throws JS exceptions on invalid input or if /proc/<pid>/status cannot be
// read.

namespace {

constexpr const char *kVmRssPrefix = "VmRSS:";
constexpr const char *kVmHwmPrefix = "VmHWM:";

// Parses a line like:
//   "VmRSS:	   12345 kB"
// into bytes. Returns true on success.
bool ParseKbLineToBytes(const char *line, const char *prefix,
                        uint64_t &outBytes) {
  const size_t prefixLen = std::strlen(prefix);
  if (std::strncmp(line, prefix, prefixLen) != 0) {
    return false;
  }

  // Move to after prefix
  const char *p = line + prefixLen;

  // Skip whitespace
  while (*p == ' ' || *p == '\t') {
    ++p;
  }

  // Parse integer value in kB.
  errno = 0;
  char *end = nullptr;
  unsigned long long kb = std::strtoull(p, &end, 10);
  if (errno != 0 || end == p) {
    return false;
  }

  // Convert kB -> bytes (Linux /proc reports kB here).
  outBytes = static_cast<uint64_t>(kb) * 1024ULL;
  return true;
}

bool ReadProcStatus(uint32_t pid, uint64_t &rssBytes, uint64_t &peakRssBytes,
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

  // Read line by line; /proc/<pid>/status lines are short.
  char buf[512];
  bool foundRss = false;
  bool foundPeak = false;

  while (std::fgets(buf, sizeof(buf), f) != nullptr) {
    if (!foundRss) {
      uint64_t v = 0;
      if (ParseKbLineToBytes(buf, kVmRssPrefix, v)) {
        rssBytes = v;
        foundRss = true;
      }
    }

    if (!foundPeak) {
      uint64_t v = 0;
      if (ParseKbLineToBytes(buf, kVmHwmPrefix, v)) {
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
    err = "Failed to find VmRSS/VmHWM in /proc/<pid>/status (process may have "
          "exited)";
    return false;
  }

  // If VmHWM is missing (unlikely on modern Linux), fall back to current RSS.
  if (!foundPeak) {
    peakRssBytes = rssBytes;
  }

  // If VmRSS is missing but VmHWM exists, treat rss as peak (best-effort).
  if (!foundRss) {
    rssBytes = peakRssBytes;
  }

  return true;
}

Napi::Value GetLinuxMemoryStats(const Napi::CallbackInfo &info) {
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

  // Linux PIDs are positive. (PID 0 does not have /proc/<pid>/status.)
  if (pid < 1 || pid > 4194304) {
    Napi::RangeError::New(env, "PID is out of range")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  uint64_t rssBytes = 0;
  uint64_t peakRssBytes = 0;
  std::string err;
  if (!ReadProcStatus(pid, rssBytes, peakRssBytes, err)) {
    Napi::Error::New(env, err).ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Object result = Napi::Object::New(env);
  // Use JS Number. (Bytes typically fit safely for realistic RSS sizes.)
  result.Set("rss", Napi::Number::New(env, static_cast<double>(rssBytes)));
  result.Set("peakRss",
             Napi::Number::New(env, static_cast<double>(peakRssBytes)));
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(
      "getLinuxMemoryStats",
      Napi::Function::New(env, GetLinuxMemoryStats, "getLinuxMemoryStats"));
  return exports;
}

} // namespace

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
