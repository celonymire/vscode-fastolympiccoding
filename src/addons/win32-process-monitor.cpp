#include <Windows.h>
#include <napi.h>
#include <psapi.h>

#pragma comment(lib, "psapi.lib")

// Synchronous wait for process completion and get timing/memory stats
// Enforces time and memory limits, killing the process if exceeded
// Returns: { elapsedMs: number, cpuMs: number, peakMemoryBytes: number, exitCode: number, timedOut: boolean, memoryLimitExceeded: boolean, stopped: boolean }
class WaitForProcessWorker : public Napi::AsyncWorker {
public:
  WaitForProcessWorker(Napi::Env &env, DWORD pid, DWORD timeoutMs, uint64_t memoryLimitBytes)
      : Napi::AsyncWorker(env), pid_(pid), timeoutMs_(timeoutMs), 
        memoryLimitBytes_(memoryLimitBytes), deferred_(env),
        elapsedMs_(0.0), cpuMs_(0.0), peakMemoryBytes_(0), exitCode_(0),
        timedOut_(false), memoryLimitExceeded_(false), stopped_(false), errorMsg_("") {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // Allow external stop request
  void Stop() {
    stopped_ = true;
  }

protected:
  void Execute() override {
    HANDLE hProcess =
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid_);

    if (hProcess == NULL) {
      errorMsg_ = "Failed to open process with given PID";
      return;
    }

    // Get creation time before waiting
    FILETIME ftCreation, ftExit, ftKernel, ftUser;
    if (!GetProcessTimes(hProcess, &ftCreation, &ftExit, &ftKernel, &ftUser)) {
      CloseHandle(hProcess);
      errorMsg_ = "Failed to get initial process times";
      return;
    }

    // Monitor process with time and memory limits
    const DWORD pollIntervalMs = 50; // Check every 50ms
    DWORD elapsedMs = 0;
    bool processExited = false;

    while (!processExited && !stopped_) {
      // Wait for process or timeout
      DWORD waitResult = WaitForSingleObject(hProcess, pollIntervalMs);

      if (waitResult == WAIT_OBJECT_0) {
        // Process exited normally
        processExited = true;
        break;
      } else if (waitResult == WAIT_TIMEOUT) {
        // Process still running, check limits
        elapsedMs += pollIntervalMs;

        // Check time limit
        if (timeoutMs_ > 0 && elapsedMs >= timeoutMs_) {
          timedOut_ = true;
          TerminateProcess(hProcess, 1);
          WaitForSingleObject(hProcess, INFINITE);
          processExited = true;
          break;
        }

        // Check memory limit
        if (memoryLimitBytes_ > 0) {
          PROCESS_MEMORY_COUNTERS pmc;
          if (GetProcessMemoryInfo(hProcess, &pmc, sizeof(pmc))) {
            if (pmc.WorkingSetSize > memoryLimitBytes_) {
              memoryLimitExceeded_ = true;
              TerminateProcess(hProcess, 1);
              WaitForSingleObject(hProcess, INFINITE);
              processExited = true;
              break;
            }
          }
        }
      } else {
        CloseHandle(hProcess);
        errorMsg_ = "Failed to wait for process";
        return;
      }
    }

    // Handle external stop request
    if (stopped_ && !processExited) {
      TerminateProcess(hProcess, 1);
      WaitForSingleObject(hProcess, INFINITE);
    }

    // Get final timing info
    FILETIME ftExitFinal, ftKernelFinal, ftUserFinal;
    if (!GetProcessTimes(hProcess, &ftCreation, &ftExitFinal, &ftKernelFinal,
                         &ftUserFinal)) {
      CloseHandle(hProcess);
      errorMsg_ = "Failed to get final process times";
      return;
    }

    // Get exit code
    DWORD exitCode = 0;
    if (!GetExitCodeProcess(hProcess, &exitCode)) {
      CloseHandle(hProcess);
      errorMsg_ = "Failed to get exit code";
      return;
    }
    exitCode_ = static_cast<int>(exitCode);

    // Get peak memory
    PROCESS_MEMORY_COUNTERS pmc;
    if (GetProcessMemoryInfo(hProcess, &pmc, sizeof(pmc))) {
      peakMemoryBytes_ = static_cast<uint64_t>(pmc.PeakWorkingSetSize);
    }

    CloseHandle(hProcess);

    // Calculate elapsed time
    ULARGE_INTEGER creationTime, exitTime;
    creationTime.LowPart = ftCreation.dwLowDateTime;
    creationTime.HighPart = ftCreation.dwHighDateTime;
    exitTime.LowPart = ftExitFinal.dwLowDateTime;
    exitTime.HighPart = ftExitFinal.dwHighDateTime;
    elapsedMs_ = static_cast<double>(exitTime.QuadPart - creationTime.QuadPart) / 10000.0;

    // Calculate CPU time
    ULARGE_INTEGER kernelTime, userTime;
    kernelTime.LowPart = ftKernelFinal.dwLowDateTime;
    kernelTime.HighPart = ftKernelFinal.dwHighDateTime;
    userTime.LowPart = ftUserFinal.dwLowDateTime;
    userTime.HighPart = ftUserFinal.dwHighDateTime;
    cpuMs_ = static_cast<double>(kernelTime.QuadPart + userTime.QuadPart) / 10000.0;
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object result = Napi::Object::New(env);
    
    if (!errorMsg_.empty()) {
      deferred_.Reject(Napi::Error::New(env, errorMsg_).Value());
      return;
    }
    
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
  DWORD pid_;
  DWORD timeoutMs_;
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

  uint32_t pid = info[0].As<Napi::Number>().Uint32Value();
  uint32_t timeoutMs = info[1].As<Napi::Number>().Uint32Value();
  double memoryLimitMB = info[2].As<Napi::Number>().DoubleValue();
  uint64_t memoryLimitBytes = static_cast<uint64_t>(memoryLimitMB * 1024.0 * 1024.0);

  auto worker = new WaitForProcessWorker(env, pid, timeoutMs, memoryLimitBytes);
  worker->Queue();
  return worker->GetPromise();
}

// Keep the synchronous version for compatibility
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
  ULARGE_INTEGER creationTime, nowTime;
  creationTime.LowPart = ftCreation.dwLowDateTime;
  creationTime.HighPart = ftCreation.dwHighDateTime;
  nowTime.LowPart = ftNow.dwLowDateTime;
  nowTime.HighPart = ftNow.dwHighDateTime;
  double elapsedMs = static_cast<double>(nowTime.QuadPart - creationTime.QuadPart) / 10000.0;

  // Calculate total CPU time (user + kernel)
  ULARGE_INTEGER kernelTime, userTime;
  kernelTime.LowPart = ftKernel.dwLowDateTime;
  kernelTime.HighPart = ftKernel.dwHighDateTime;
  userTime.LowPart = ftUser.dwLowDateTime;
  userTime.HighPart = ftUser.dwHighDateTime;
  double cpuMs = static_cast<double>(kernelTime.QuadPart + userTime.QuadPart) / 10000.0;

  Napi::Object result = Napi::Object::New(env);
  result.Set("elapsedMs", Napi::Number::New(env, elapsedMs));
  result.Set("cpuMs", Napi::Number::New(env, cpuMs));

  return result;
}

Napi::Value GetWin32MemoryStats(const Napi::CallbackInfo &info) {
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
  HANDLE handle =
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
  exports.Set("waitForProcess",
              Napi::Function::New(env, WaitForProcess, "waitForProcess"));
  exports.Set("getWin32ProcessTimes",
              Napi::Function::New(env, GetWin32ProcessTimes,
                                  "getWin32ProcessTimes"));
  exports.Set("getWin32MemoryStats",
              Napi::Function::New(env, GetWin32MemoryStats,
                                  "getWin32MemoryStats"));
  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
