#include <Windows.h>
#include <napi.h>
#include <psapi.h>

#pragma comment(lib, "psapi.lib")

Napi::Value GetWin32MemoryStats(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  // Check that we have a PID argument
  if (info.Length() < 1) {
    napi_throw_type_error(env, nullptr, "PID argument is required");
    return env.Null();
  }

  auto pid = info[0].As<Napi::Number>().Uint32Value();
  auto handle =
      OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);

  if (handle == NULL) {
    napi_throw_error(env, nullptr, "Failed to open process with given PID");
    return env.Null();
  }

  PROCESS_MEMORY_COUNTERS pmc;
  Napi::Object result = Napi::Object::New(env);
  if (GetProcessMemoryInfo(handle, &pmc, sizeof(pmc))) {
    // Return current and peak resident set size (in bytes)
    result.Set("rss", Napi::Number::New(env, (double)pmc.WorkingSetSize));
    result.Set("peakRss",
               Napi::Number::New(env, (double)pmc.PeakWorkingSetSize));
  } else {
    CloseHandle(handle);
    napi_throw_error(env, nullptr, "Failed to get process memory info");
    return env.Null();
  }

  CloseHandle(handle);
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(
      "getWin32MemoryStats",
      Napi::Function::New(env, GetWin32MemoryStats, "getWin32MemoryStats"));
  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)