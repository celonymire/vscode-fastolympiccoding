#include <Windows.h>
#include <napi.h>
#include <psapi.h>

#pragma comment(lib, "psapi.lib")

// Windows implementation using Job Objects for resource limit enforcement
// Job Objects allow the OS to enforce time and memory limits directly
// Returns: { elapsedMs: number, cpuMs: number, peakMemoryBytes: number, exitCode: number, timedOut: boolean, memoryLimitExceeded: boolean, stopped: boolean }
class WaitForProcessWorker : public Napi::AsyncWorker {
public:
  WaitForProcessWorker(Napi::Env &env, DWORD pid, DWORD timeoutMs, uint64_t memoryLimitBytes)
      : Napi::AsyncWorker(env), pid_(pid), timeoutMs_(timeoutMs), 
        memoryLimitBytes_(memoryLimitBytes), deferred_(env),
        elapsedMs_(0.0), peakMemoryBytes_(0), exitCode_(0),
        timedOut_(false), memoryLimitExceeded_(false), stopped_(false), errorMsg_("") {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // Allow external stop request
  void Stop() {
    stopped_ = true;
  }

protected:
  void Execute() override {
    HANDLE hProcess =
        OpenProcess(PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid_);

    if (hProcess == NULL) {
      errorMsg_ = "Failed to open process with given PID";
      return;
    }

    // Create a job object to manage resource limits
    HANDLE hJob = CreateJobObject(NULL, NULL);
    if (hJob == NULL) {
      CloseHandle(hProcess);
      errorMsg_ = "Failed to create job object";
      return;
    }

    // Configure job limits
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobLimits = {0};
    jobLimits.BasicLimitInformation.LimitFlags = 0;

    // Set time limit if specified (in 100-nanosecond intervals)
    if (timeoutMs_ > 0) {
      ULONGLONG timeLimit100ns = static_cast<ULONGLONG>(timeoutMs_) * 10000ULL;
      jobLimits.BasicLimitInformation.PerProcessUserTimeLimit.QuadPart = timeLimit100ns;
      jobLimits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_TIME;
    }

    // Set memory limit if specified
    if (memoryLimitBytes_ > 0) {
      jobLimits.ProcessMemoryLimit = memoryLimitBytes_;
      jobLimits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    }

    // Set the job limits
    if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, 
                                  &jobLimits, sizeof(jobLimits))) {
      CloseHandle(hJob);
      CloseHandle(hProcess);
      errorMsg_ = "Failed to set job object limits";
      return;
    }

    // Assign the process to the job
    if (!AssignProcessToJobObject(hJob, hProcess)) {
      CloseHandle(hJob);
      CloseHandle(hProcess);
      errorMsg_ = "Failed to assign process to job object";
      return;
    }

    // Get creation time before waiting
    FILETIME ftCreation, ftExit, ftKernel, ftUser;
    if (!GetProcessTimes(hProcess, &ftCreation, &ftExit, &ftKernel, &ftUser)) {
      CloseHandle(hJob);
      CloseHandle(hProcess);
      errorMsg_ = "Failed to get initial process times";
      return;
    }

    // Wait for process to complete or be stopped externally
    bool processExited = false;
    const DWORD pollIntervalMs = 50;

    while (!processExited && !stopped_) {
      DWORD waitResult = WaitForSingleObject(hProcess, pollIntervalMs);

      if (waitResult == WAIT_OBJECT_0) {
        // Process exited
        processExited = true;
        break;
      } else if (waitResult == WAIT_TIMEOUT) {
        // Check if job limits were exceeded
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accountingInfo;
        if (QueryInformationJobObject(hJob, JobObjectBasicAccountingInformation,
                                      &accountingInfo, sizeof(accountingInfo), NULL)) {
          // Check if time limit was exceeded (job will terminate process automatically)
          if (accountingInfo.TotalTerminatedProcesses > 0) {
            // Process was terminated by job object
            timedOut_ = true;
            processExited = true;
            break;
          }
        }
      } else {
        CloseHandle(hJob);
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
      CloseHandle(hJob);
      CloseHandle(hProcess);
      errorMsg_ = "Failed to get final process times";
      return;
    }

    // Get exit code
    DWORD exitCode = 0;
    if (!GetExitCodeProcess(hProcess, &exitCode)) {
      CloseHandle(hJob);
      CloseHandle(hProcess);
      errorMsg_ = "Failed to get exit code";
      return;
    }
    exitCode_ = static_cast<int>(exitCode);

    // Check if process was killed due to exceeding limits
    // ERROR_NOT_ENOUGH_QUOTA (0x705) or STATUS_QUOTA_EXCEEDED (0xC0000044) indicates limit exceeded
    if (exitCode == 0xC0000044 || exitCode == 0x705) {
      // Could be memory or time limit - check job accounting info
      JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION accountingInfo;
      if (QueryInformationJobObject(hJob, JobObjectBasicAndIoAccountingInformation,
                                    &accountingInfo, sizeof(accountingInfo), NULL)) {
        // If total user time is near the limit, it was likely a time limit
        ULONGLONG totalUserTime = accountingInfo.BasicInfo.TotalUserTime.QuadPart;
        if (timeoutMs_ > 0) {
          ULONGLONG timeLimit100ns = static_cast<ULONGLONG>(timeoutMs_) * 10000ULL;
          if (totalUserTime >= timeLimit100ns * 0.95) { // Within 5% of limit
            timedOut_ = true;
          } else {
            memoryLimitExceeded_ = true;
          }
        } else {
          memoryLimitExceeded_ = true;
        }
      }
    }

    // Get peak memory from job accounting
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accountingInfo;
    if (QueryInformationJobObject(hJob, JobObjectBasicAccountingInformation,
                                  &accountingInfo, sizeof(accountingInfo), NULL)) {
      peakMemoryBytes_ = static_cast<uint64_t>(accountingInfo.PeakProcessMemoryUsed);
    } else {
      // Fallback to process memory counters
      PROCESS_MEMORY_COUNTERS pmc;
      if (GetProcessMemoryInfo(hProcess, &pmc, sizeof(pmc))) {
        peakMemoryBytes_ = static_cast<uint64_t>(pmc.PeakWorkingSetSize);
      }
    }

    CloseHandle(hJob);
    CloseHandle(hProcess);

    // Calculate elapsed time
    ULARGE_INTEGER creationTime, exitTime;
    creationTime.LowPart = ftCreation.dwLowDateTime;
    creationTime.HighPart = ftCreation.dwHighDateTime;
    exitTime.LowPart = ftExitFinal.dwLowDateTime;
    exitTime.HighPart = ftExitFinal.dwHighDateTime;

    // Calculate elapsed CPU time (user + kernel)
    ULARGE_INTEGER kernelTime, userTime;
    kernelTime.LowPart = ftKernelFinal.dwLowDateTime;
    kernelTime.HighPart = ftKernelFinal.dwHighDateTime;
    userTime.LowPart = ftUserFinal.dwLowDateTime;
    userTime.HighPart = ftUserFinal.dwHighDateTime;
    elapsedMs_ = static_cast<double>(kernelTime.QuadPart + userTime.QuadPart) / 10000.0;
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object result = Napi::Object::New(env);
    
    if (!errorMsg_.empty()) {
      deferred_.Reject(Napi::Error::New(env, errorMsg_).Value());
      return;
    }
    
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
  DWORD pid_;
  DWORD timeoutMs_;
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

  uint32_t pid = info[0].As<Napi::Number>().Uint32Value();
  uint32_t timeoutMs = info[1].As<Napi::Number>().Uint32Value();
  double memoryLimitMB = info[2].As<Napi::Number>().DoubleValue();
  uint64_t memoryLimitBytes = static_cast<uint64_t>(memoryLimitMB * 1024.0 * 1024.0);

  auto worker = new WaitForProcessWorker(env, pid, timeoutMs, memoryLimitBytes);
  worker->Queue();
  return worker->GetPromise();
}

// Combined function to get process stats (elapsed CPU time and memory)
Napi::Value GetWin32ProcessStats(const Napi::CallbackInfo &info) {
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
      OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);

  if (hProcess == NULL) {
    Napi::Error::New(env, "Failed to open process with given PID")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Get process times
  FILETIME ftCreation, ftExit, ftKernel, ftUser;
  if (!GetProcessTimes(hProcess, &ftCreation, &ftExit, &ftKernel, &ftUser)) {
    CloseHandle(hProcess);
    Napi::Error::New(env, "Failed to get process times")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Calculate elapsed CPU time (user + kernel)
  ULARGE_INTEGER kernelTime, userTime;
  kernelTime.LowPart = ftKernel.dwLowDateTime;
  kernelTime.HighPart = ftKernel.dwHighDateTime;
  userTime.LowPart = ftUser.dwLowDateTime;
  userTime.HighPart = ftUser.dwHighDateTime;
  double elapsedMs = static_cast<double>(kernelTime.QuadPart + userTime.QuadPart) / 10000.0;

  // Get memory stats
  PROCESS_MEMORY_COUNTERS pmc;
  if (!GetProcessMemoryInfo(hProcess, &pmc, sizeof(pmc))) {
    CloseHandle(hProcess);
    Napi::Error::New(env, "Failed to get process memory info")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  CloseHandle(hProcess);

  Napi::Object result = Napi::Object::New(env);
  result.Set("elapsedMs", Napi::Number::New(env, elapsedMs));
  result.Set("rss", Napi::Number::New(env, (double)pmc.WorkingSetSize));
  result.Set("peakRss", Napi::Number::New(env, (double)pmc.PeakWorkingSetSize));

  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("waitForProcess",
              Napi::Function::New(env, WaitForProcess, "waitForProcess"));
  exports.Set("getWin32ProcessStats",
              Napi::Function::New(env, GetWin32ProcessStats,
                                  "getWin32ProcessStats"));
  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
