#include <Windows.h>
#include <napi.h>
#include <psapi.h>
#include <cmath>

#pragma comment(lib, "psapi.lib")

// Windows implementation using Job Objects for resource limit enforcement
// Job Objects allow the OS to enforce time and memory limits directly
// Returns: { elapsedMs: number, cpuMs: number, peakMemoryBytes: number, exitCode: number, timedOut: boolean, memoryLimitExceeded: boolean, stopped: boolean }
class WaitForProcessWorker : public Napi::AsyncWorker {
public:
  WaitForProcessWorker(Napi::Env &env, HANDLE hProcess, DWORD pid, DWORD timeoutMs, uint64_t memoryLimitBytes)
      : Napi::AsyncWorker(env), hProcess_(hProcess), pid_(pid), timeoutMs_(timeoutMs), 
        memoryLimitBytes_(memoryLimitBytes), deferred_(env),
        elapsedMs_(0.0), peakMemoryBytes_(0), exitCode_(0),
        timedOut_(false), memoryLimitExceeded_(false), stopped_(false), errorMsg_("") {}

  ~WaitForProcessWorker() {
    if (hProcess_ != NULL) {
      CloseHandle(hProcess_);
    }
  }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  // Allow external stop request
  void Stop() {
    stopped_ = true;
  }

protected:
  void Execute() override {
    // We already have a duplicated handle from SpawnProcess
    HANDLE hProcess = hProcess_;

    if (hProcess == NULL) {
      errorMsg_ = "Invalid process handle";
      return;
    }

    // Create a job object to manage resource limits
    HANDLE hJob = CreateJobObject(NULL, NULL);
    if (hJob == NULL) {
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
      errorMsg_ = "Failed to set job object limits";
      return;
    }

    // Assign the process to the job
    if (!AssignProcessToJobObject(hJob, hProcess)) {
      CloseHandle(hJob);
      errorMsg_ = "Failed to assign process to job object";
      return;
    }

    // Get creation time before waiting
    FILETIME ftCreation, ftExit, ftKernel, ftUser;
    if (!GetProcessTimes(hProcess, &ftCreation, &ftExit, &ftKernel, &ftUser)) {
      CloseHandle(hJob);
      errorMsg_ = "Failed to get initial process times";
      return;
    }

    // Wait for process to complete or be stopped externally
    bool processExited = false;
    const DWORD pollIntervalMs = 100;

    while (!processExited && !stopped_) {
      DWORD waitResult = WaitForSingleObject(hProcess, pollIntervalMs);

      if (waitResult == WAIT_OBJECT_0) {
        processExited = true;
        break;
      } else if (waitResult == WAIT_TIMEOUT) {
        continue;
      } else {
        CloseHandle(hJob);
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
      errorMsg_ = "Failed to get final process times";
      return;
    }

    // Get exit code
    DWORD exitCode = 0;
    if (!GetExitCodeProcess(hProcess, &exitCode)) {
      CloseHandle(hJob);
      errorMsg_ = "Failed to get exit code";
      return;
    }
    exitCode_ = static_cast<int>(exitCode);

    // Check if process was killed due to exceeding limits
    if (exitCode == 0xC0000044 || exitCode == 0x705) {
      JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION accountingInfo;
      if (QueryInformationJobObject(hJob, JobObjectBasicAndIoAccountingInformation,
                                    &accountingInfo, sizeof(accountingInfo), NULL)) {
        ULONGLONG totalUserTime = accountingInfo.BasicInfo.TotalUserTime.QuadPart;
        if (timeoutMs_ > 0) {
          ULONGLONG timeLimit100ns = static_cast<ULONGLONG>(timeoutMs_) * 10000ULL;
          if (totalUserTime >= timeLimit100ns * 0.95) {
            timedOut_ = true;
          } else {
            memoryLimitExceeded_ = true;
          }
        } else {
          memoryLimitExceeded_ = true;
        }
      }
    }

    // Get peak memory from job accounting - use ExtendedLimitInformation for memory metrics
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION extendedInfo;
    if (QueryInformationJobObject(hJob, JobObjectExtendedLimitInformation,
                                  &extendedInfo, sizeof(extendedInfo), NULL)) {
      peakMemoryBytes_ = static_cast<uint64_t>(extendedInfo.PeakProcessMemoryUsed);
    } else {
      // Fallback to process memory counters if job query fails
      PROCESS_MEMORY_COUNTERS pmc;
      if (GetProcessMemoryInfo(hProcess, &pmc, sizeof(pmc))) {
        peakMemoryBytes_ = static_cast<uint64_t>(pmc.PeakWorkingSetSize);
      }
    }

    CloseHandle(hJob);
    // hProcess_ will be closed in destructor

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
    double rawElapsedMs = static_cast<double>(kernelTime.QuadPart + userTime.QuadPart) / 10000.0;
    elapsedMs_ = std::round(rawElapsedMs);
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
  HANDLE hProcess_;
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



// Helper to convert UTF-8 string to UTF-16 wstring for Windows APIs
std::wstring ToWString(const std::string& utf8) {
  if (utf8.empty()) return L"";
  int size_needed = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), (int)utf8.size(), NULL, 0);
  std::wstring wstrTo(size_needed, 0);
  MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), (int)utf8.size(), &wstrTo[0], size_needed);
  return wstrTo;
}

// 0: command (string)
// 1: args (array of strings)
// 2: cwd (string) or empty
// 3: timeoutMs (number)
// 4: memoryLimitBytes (number)
// 5: onSpawn (function)
// Returns: { pid: number, stdio: [stdinFd, stdoutFd, stderrFd], result: Promise<AddonResult> }
//
Napi::Value SpawnProcess(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 6) {
    Napi::TypeError::New(env, "Expected 6 arguments").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string command = info[0].As<Napi::String>().Utf8Value();
  Napi::Array argsArray = info[1].As<Napi::Array>();
  std::string cwd = info[2].As<Napi::String>().Utf8Value();
  uint32_t timeoutMs = info[3].As<Napi::Number>().Uint32Value();
  double memoryLimitMB = info[4].As<Napi::Number>().DoubleValue();
  uint64_t memoryLimitBytes = static_cast<uint64_t>(memoryLimitMB * 1024.0 * 1024.0);
  Napi::Function onSpawn = info[5].As<Napi::Function>();

  // Prepare command line (Windows expects a single string)
  std::wstring wCommand = ToWString(command);
  std::wstring cmdLine = L"\"" + wCommand + L"\"";
  for (uint32_t i = 0; i < argsArray.Length(); i++) {
    std::string arg = argsArray.Get(i).As<Napi::String>().Utf8Value();
    cmdLine += L" " + ToWString(arg);
  }

  // Create pipes for stdio
  HANDLE hChildStdInRead = NULL, hChildStdInWrite = NULL;
  HANDLE hChildStdOutRead = NULL, hChildStdOutWrite = NULL;
  HANDLE hChildStdErrRead = NULL, hChildStdErrWrite = NULL;

  SECURITY_ATTRIBUTES saAttr;
  saAttr.nLength = sizeof(SECURITY_ATTRIBUTES);
  saAttr.bInheritHandle = TRUE;
  saAttr.lpSecurityDescriptor = NULL;

  if (!CreatePipe(&hChildStdOutRead, &hChildStdOutWrite, &saAttr, 0) ||
      !SetHandleInformation(hChildStdOutRead, HANDLE_FLAG_INHERIT, 0) ||
      !CreatePipe(&hChildStdErrRead, &hChildStdErrWrite, &saAttr, 0) ||
      !SetHandleInformation(hChildStdErrRead, HANDLE_FLAG_INHERIT, 0) ||
      !CreatePipe(&hChildStdInRead, &hChildStdInWrite, &saAttr, 0) ||
      !SetHandleInformation(hChildStdInWrite, HANDLE_FLAG_INHERIT, 0)) {
    Napi::Error::New(env, "Failed to create pipes").ThrowAsJavaScriptException();
    return env.Null();
  }

  STARTUPINFOW siStartInfo;
  PROCESS_INFORMATION piProcInfo;
  ZeroMemory(&siStartInfo, sizeof(siStartInfo));
  siStartInfo.cb = sizeof(siStartInfo);
  siStartInfo.hStdError = hChildStdErrWrite;
  siStartInfo.hStdOutput = hChildStdOutWrite;
  siStartInfo.hStdInput = hChildStdInRead;
  siStartInfo.dwFlags |= STARTF_USESTDHANDLES;

  ZeroMemory(&piProcInfo, sizeof(piProcInfo));

  std::wstring wCwd = ToWString(cwd);
  LPCWSTR lpCwd = wCwd.empty() ? NULL : wCwd.c_str();

  BOOL success = CreateProcessW(
    NULL, 
    &cmdLine[0], 
    NULL, 
    NULL, 
    TRUE, 
    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, 
    NULL, 
    lpCwd, 
    &siStartInfo, 
    &piProcInfo
  );

  if (!success) {
    CloseHandle(hChildStdInRead); CloseHandle(hChildStdInWrite);
    CloseHandle(hChildStdOutRead); CloseHandle(hChildStdOutWrite);
    CloseHandle(hChildStdErrRead); CloseHandle(hChildStdErrWrite);
    Napi::Error::New(env, "CreateProcessW failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  // Create Job Object for resource limits
  HANDLE hJob = CreateJobObject(NULL, NULL);
  if (hJob) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobLimits = {0};
    if (timeoutMs > 0) {
      jobLimits.BasicLimitInformation.PerProcessUserTimeLimit.QuadPart = static_cast<LONGLONG>(timeoutMs) * 10000;
      jobLimits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_TIME;
    }
    if (memoryLimitBytes > 0) {
      jobLimits.ProcessMemoryLimit = (SIZE_T)memoryLimitBytes;
      jobLimits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    }
    SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, &jobLimits, sizeof(jobLimits));
    AssignProcessToJobObject(hJob, piProcInfo.hProcess);
    CloseHandle(hJob); // handle closed but job stays until process exits
  }

  ResumeThread(piProcInfo.hThread);
  CloseHandle(piProcInfo.hThread);
  
  DWORD pid = piProcInfo.dwProcessId;
  // Duplicate process handle for the background worker thread
  HANDLE hProcessDup = NULL;
  DuplicateHandle(GetCurrentProcess(), piProcInfo.hProcess, GetCurrentProcess(), &hProcessDup,
                  0, FALSE, DUPLICATE_SAME_ACCESS);
  CloseHandle(piProcInfo.hProcess);

  // Close child-side pipe ends
  CloseHandle(hChildStdInRead);
  CloseHandle(hChildStdOutWrite);
  CloseHandle(hChildStdErrWrite);

  // Notify JS
  onSpawn.Call({});

  // Start monitoring
  auto worker = new WaitForProcessWorker(env, hProcessDup, pid, timeoutMs, memoryLimitBytes);
  auto promise = worker->GetPromise();
  worker->Queue();

  Napi::Object result = Napi::Object::New(env);
  result.Set("pid", Napi::Number::New(env, pid));
  result.Set("result", promise);

  Napi::Array stdio = Napi::Array::New(env, 3);
  stdio.Set(uint32_t(0), Napi::Number::New(env, (double)HandleToLong(hChildStdInWrite)));
  stdio.Set(uint32_t(1), Napi::Number::New(env, (double)HandleToLong(hChildStdOutRead)));
  stdio.Set(uint32_t(2), Napi::Number::New(env, (double)HandleToLong(hChildStdErrRead)));
  result.Set("stdio", stdio);

  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("spawn",
              Napi::Function::New(env, SpawnProcess, "spawn"));
  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
