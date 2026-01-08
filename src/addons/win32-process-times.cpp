#include <Windows.h>
#include <napi.h>

#pragma comment(lib, "kernel32.lib")

// Convert FILETIME (100-nanosecond intervals since 1601-01-01) to milliseconds
static double FileTimeToMilliseconds(const FILETIME &ft) {
  ULARGE_INTEGER uli;
  uli.LowPart = ft.dwLowDateTime;
  uli.HighPart = ft.dwHighDateTime;
  // Convert 100-nanosecond intervals to milliseconds
  return static_cast<double>(uli.QuadPart) / 10000.0;
}

// Get the elapsed wall-clock time and CPU time for a process
// Returns: { elapsedMs: number, cpuMs: number }
// elapsedMs: wall-clock time since process start (in milliseconds)
// cpuMs: total CPU time (user + kernel) in milliseconds
Napi::Value GetWin32ProcessTimes(const Napi::CallbackInfo &info) {
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
  HANDLE hProcess =
      OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);

  if (hProcess == NULL) {
    Napi::Error::New(env, "Failed to open process with given PID")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  FILETIME ftCreation, ftExit, ftKernel, ftUser;
  if (!GetProcessTimes(hProcess, &ftCreation, &ftExit, &ftKernel, &ftUser)) {
    CloseHandle(hProcess);
    Napi::Error::New(env, "Failed to get process times")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  CloseHandle(hProcess);

  // Get current time
  FILETIME ftNow;
  GetSystemTimeAsFileTime(&ftNow);

  // Calculate elapsed wall-clock time
  double creationMs = FileTimeToMilliseconds(ftCreation);
  double nowMs = FileTimeToMilliseconds(ftNow);
  double elapsedMs = nowMs - creationMs;

  // Calculate total CPU time (user + kernel)
  double kernelMs = FileTimeToMilliseconds(ftKernel);
  double userMs = FileTimeToMilliseconds(ftUser);
  double cpuMs = kernelMs + userMs;

  Napi::Object result = Napi::Object::New(env);
  result.Set("elapsedMs", Napi::Number::New(env, elapsedMs));
  result.Set("cpuMs", Napi::Number::New(env, cpuMs));

  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getWin32ProcessTimes",
              Napi::Function::New(env, GetWin32ProcessTimes,
                                  "getWin32ProcessTimes"));
  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
