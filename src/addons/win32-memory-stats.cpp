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

  // Validate the argument type before converting. N-API C++ wrapper's As<T>()
  // does not perform a JS-to-C++ conversion or produce a helpful JS exception
  // if the value is not already the expected JS type.
  if (!info[0].IsNumber()) {
    napi_throw_type_error(env, nullptr, "PID must be a number");
    return env.Null();
  }

  uint32_t pid = info[0].As<Napi::Number>().Uint32Value();
  auto handle =
      OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);

  if (handle == NULL) {
    Napi::Error::New(env, "Failed to open process with given PID")
        .ThrowAsJavaScriptException();
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
    Napi::Error::New(env, "Failed to get process memory info")
        .ThrowAsJavaScriptException();
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
