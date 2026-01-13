#include <Windows.h>
#include <cmath>
#include <cstdint>
#include <napi.h>
#include <psapi.h>
#include <string>
#include <vector>

#pragma comment(lib, "psapi.lib")

// Windows implementation using Job Objects for resource limit enforcement
// Job Objects allow the OS to enforce time and memory limits directly
// Returns: { elapsedMs: number, cpuMs: number, peakMemoryBytes: number,
// exitCode: number, timedOut: boolean, memoryLimitExceeded: boolean, stopped:
// boolean } Shared state for synchronization between worker and JS thread
struct SharedStopState {
  HANDLE hStopEvent = NULL;
  std::mutex mutex;
  bool closed = false;

  SharedStopState() {
    hStopEvent = CreateEvent(NULL, TRUE, FALSE,
                             NULL); // Manual reset, initially nonsignaled
  }

  ~SharedStopState() {
    if (hStopEvent != NULL) {
      CloseHandle(hStopEvent);
      hStopEvent = NULL;
    }
  }

  // Called by worker when it's done
  void Close() {
    std::lock_guard<std::mutex> lock(mutex);
    closed = true;
  }

  // Called by JS 'cancel' function
  bool SignalStop() {
    std::lock_guard<std::mutex> lock(mutex);
    if (closed || hStopEvent == NULL)
      return false;

    return SetEvent(hStopEvent);
  }
};

// Helper to get human-readable error message from system error code
std::string GetErrorMessage(DWORD errorCode) {
  if (errorCode == 0) {
    return "";
  }

  LPSTR messageBuffer = nullptr;
  size_t size = FormatMessageA(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
          FORMAT_MESSAGE_IGNORE_INSERTS,
      NULL, errorCode, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
      (LPSTR)&messageBuffer, 0, NULL);

  std::string message(messageBuffer, size);

  // Free the buffer allocated by FormatMessage
  LocalFree(messageBuffer);

  // Remove trailing newline/CR if present
  while (!message.empty() &&
         (message.back() == '\r' || message.back() == '\n')) {
    message.pop_back();
  }

  return message + " (Error Code: " + std::to_string(errorCode) + ")";
}

class WaitForProcessWorker : public Napi::AsyncWorker {
public:
  WaitForProcessWorker(Napi::Env &env, HANDLE hProcess, DWORD pid,
                       DWORD timeoutMs, uint64_t memoryLimitBytes,
                       std::shared_ptr<SharedStopState> sharedState)
      : Napi::AsyncWorker(env), hProcess_(hProcess), pid_(pid),
        timeoutMs_(timeoutMs), memoryLimitBytes_(memoryLimitBytes),
        deferred_(env), elapsedMs_(0.0), peakMemoryBytes_(0), exitCode_(0),
        timedOut_(false), memoryLimitExceeded_(false), stopped_(false),
        errorMsg_(""), sharedState_(sharedState) {}

  ~WaitForProcessWorker() {
    if (hProcess_ != NULL) {
      CloseHandle(hProcess_);
    }
    // Shared state handles the event handle
  }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

protected:
  void Execute() override {
    // We already have a duplicated handle from SpawnProcess
    HANDLE hProcess = hProcess_;

    if (hProcess == NULL) {
      errorMsg_ = "Invalid process handle";
      return;
    }

    HANDLE hStopEvent = sharedState_->hStopEvent;
    if (hStopEvent == NULL) {
      errorMsg_ = "Failed to create stop event (in shared state): " +
                  GetErrorMessage(GetLastError());
      return;
    }

    // Create a job object to manage resource limits
    HANDLE hJob = CreateJobObject(NULL, NULL);
    if (hJob == NULL) {
      errorMsg_ =
          "Failed to create job object: " + GetErrorMessage(GetLastError());
      return;
    }

    // Configure job limits
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobLimits = {0};
    jobLimits.BasicLimitInformation.LimitFlags = 0;

    // Set time limit if specified (in 100-nanosecond intervals)
    if (timeoutMs_ > 0) {
      ULONGLONG timeLimit100ns = static_cast<ULONGLONG>(timeoutMs_) * 10000ULL;
      jobLimits.BasicLimitInformation.PerProcessUserTimeLimit.QuadPart =
          timeLimit100ns;
      jobLimits.BasicLimitInformation.LimitFlags |=
          JOB_OBJECT_LIMIT_PROCESS_TIME;
    }

    // Set memory limit if specified
    if (memoryLimitBytes_ > 0) {
      jobLimits.ProcessMemoryLimit = memoryLimitBytes_;
      jobLimits.BasicLimitInformation.LimitFlags |=
          JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    }

    // Set the job limits
    if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation,
                                 &jobLimits, sizeof(jobLimits))) {
      DWORD err = GetLastError();
      CloseHandle(hJob);
      errorMsg_ = "Failed to set job object limits: " + GetErrorMessage(err);
      return;
    }

    // Assign the process to the job
    if (!AssignProcessToJobObject(hJob, hProcess)) {
      DWORD err = GetLastError();
      // It's possible the process already exited before we could assign it
      DWORD exitCode = 0;
      if (GetExitCodeProcess(hProcess, &exitCode) && exitCode != STILL_ACTIVE) {
        // Process is dead, so we can't assign it (and don't need to enforce
        // limits) We continue to collect stats (though job stats will be
        // empty/invalid, we fall back to process stats)
      } else {
        // Real failure
        CloseHandle(hJob);
        errorMsg_ =
            "Failed to assign process to job object: " + GetErrorMessage(err);
        return;
      }
    }

    // Get creation time before waiting
    FILETIME ftCreation, ftExit, ftKernel, ftUser;
    if (!GetProcessTimes(hProcess, &ftCreation, &ftExit, &ftKernel, &ftUser)) {
      DWORD err = GetLastError();
      CloseHandle(hJob);
      errorMsg_ =
          "Failed to get initial process times: " + GetErrorMessage(err);
      return;
    }

    // Wait loop for process to complete or be stopped externally
    // We poll to check for Total CPU Time (User + Kernel) and enforce Wall
    // Clock limit (2x CPU limit)

    DWORD startTime = GetTickCount();
    unsigned long long timeoutMsLong =
        static_cast<unsigned long long>(timeoutMs_);

    // We keep the OS-level User Time limit (set above in jobLimits) as a
    // backup.

    bool processExited = false;

    while (!processExited && !stopped_) {
      DWORD elapsedWall = GetTickCount() - startTime;

      // 1. Wall Clock Check (2x CPU Limit for leniency)
      if (timeoutMs_ > 0 && elapsedWall >= timeoutMs_ * 2) {
        timedOut_ = true;
        stopped_ = true;
        break;
      }

      // Calculate wait time for this slice
      DWORD slice = 10; // Poll every 10ms
      DWORD waitMillis = slice;

      if (timeoutMs_ > 0) {
        // Don't sleep past the hard wall limit
        DWORD remaining = (timeoutMs_ * 2) - elapsedWall;
        if (remaining < slice)
          waitMillis = remaining;
      } else {
        waitMillis = slice;
      }

      HANDLE waitHandles[2] = {hProcess, hStopEvent};
      DWORD waitResult =
          WaitForMultipleObjects(2, waitHandles, FALSE, waitMillis);

      if (waitResult == WAIT_OBJECT_0) {
        // Process handle signaled -> Process exited
        processExited = true;
        break;
      } else if (waitResult == WAIT_OBJECT_0 + 1) {
        // Stop event signaled -> External stop
        stopped_ = true;
        break;
      } else if (waitResult == WAIT_TIMEOUT) {
        // Slice finished, check CPU usage
        if (timeoutMs_ > 0) {
          JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
          if (QueryInformationJobObject(
                  hJob, JobObjectBasicAccountingInformation, &accounting,
                  sizeof(accounting), NULL)) {
            // TotalTime = User + Kernel
            ULONGLONG totalTime100ns = accounting.TotalUserTime.QuadPart +
                                       accounting.TotalKernelTime.QuadPart;
            // Convert 100ns units to ms: / 10000
            ULONGLONG totalTimeMs = totalTime100ns / 10000;

            if (totalTimeMs > timeoutMsLong) {
              timedOut_ = true;
              stopped_ = true;
              break;
            }
          }
        }
      } else {
        // Failed
        DWORD err = GetLastError();
        CloseHandle(hJob);
        errorMsg_ = "WaitForMultipleObjects failed: " + GetErrorMessage(err);
        return;
      }
    }

    // Mark shared state as closed so cancel() becomes no-op
    sharedState_->Close();

    // Handle external stop request or timeout
    if (stopped_ && !processExited) {
      // If we stopped manually or timed out, we must terminate the process
      TerminateProcess(hProcess, 1);
      // Wait for it to actually die so we can get accounting info
      WaitForSingleObject(hProcess, INFINITE);
    }

    // Get final timing info and peak memory
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION extendedInfo;
    bool hasExtendedInfo =
        QueryInformationJobObject(hJob, JobObjectExtendedLimitInformation,
                                  &extendedInfo, sizeof(extendedInfo), NULL);

    if (hasExtendedInfo) {
      peakMemoryBytes_ =
          static_cast<uint64_t>(extendedInfo.PeakProcessMemoryUsed);
    } else {
      // Fallback to process memory counters if job query fails
      PROCESS_MEMORY_COUNTERS pmc;
      if (GetProcessMemoryInfo(hProcess, &pmc, sizeof(pmc))) {
        peakMemoryBytes_ = static_cast<uint64_t>(pmc.PeakWorkingSetSize);
      }
    }

    FILETIME ftExitFinal, ftKernelFinal, ftUserFinal;
    if (!GetProcessTimes(hProcess, &ftCreation, &ftExitFinal, &ftKernelFinal,
                         &ftUserFinal)) {
      DWORD err = GetLastError();
      CloseHandle(hJob);
      errorMsg_ = "Failed to get final process times: " + GetErrorMessage(err);
      return;
    }

    // Get exit code
    DWORD exitCode = 0;
    if (!GetExitCodeProcess(hProcess, &exitCode)) {
      DWORD err = GetLastError();
      CloseHandle(hJob);
      errorMsg_ = "Failed to get exit code: " + GetErrorMessage(err);
      return;
    }
    exitCode_ = static_cast<int>(exitCode);

    // Check if process was killed due to exceeding limits
    // (STATUS_JOB_TERMINATED_AND_DID_NOT_EXIT)
    if (exitCode == 0xC0000044 || exitCode == 0x705) {
      // Calculate CPU time from final process times
      ULARGE_INTEGER userTime;
      userTime.LowPart = ftUserFinal.dwLowDateTime;
      userTime.HighPart = ftUserFinal.dwHighDateTime;
      ULONGLONG totalUserTime100ns = userTime.QuadPart;

      if (timeoutMs_ > 0) {
        ULONGLONG timeLimit100ns =
            static_cast<ULONGLONG>(timeoutMs_) * 10000ULL;
        // If we reached the time limit (or very close to it), it's a timeout
        if (totalUserTime100ns >= timeLimit100ns * 0.95) {
          timedOut_ = true;
        } else {
          memoryLimitExceeded_ = true;
        }
      } else {
        memoryLimitExceeded_ = true;
      }
    } else if (exitCode != 0 && memoryLimitBytes_ > 0) {
      // If it failed for other reasons (like V8 aborting on OOM)
      // check if we were close to or over the memory limit.
      if (peakMemoryBytes_ >= memoryLimitBytes_ * 0.9) {
        memoryLimitExceeded_ = true;
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
    double rawElapsedMs =
        static_cast<double>(kernelTime.QuadPart + userTime.QuadPart) / 10000.0;
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
    result.Set("peakMemoryBytes",
               Napi::Number::New(env, static_cast<double>(peakMemoryBytes_)));

    // Check if exit code indicates a crash:
    // 1. NTSTATUS/Exception codes (>= 0xC0000000)
    if ((static_cast<unsigned int>(exitCode_) >= 0xC0000000)) {
      result.Set("exitCode", env.Null());
    } else {
      result.Set("exitCode", Napi::Number::New(env, exitCode_));
    }

    result.Set("timedOut", Napi::Boolean::New(env, timedOut_));
    result.Set("memoryLimitExceeded",
               Napi::Boolean::New(env, memoryLimitExceeded_));
    result.Set("stopped", Napi::Boolean::New(env, stopped_));

    deferred_.Resolve(result);
  }

  void OnError(const Napi::Error &e) override { deferred_.Reject(e.Value()); }

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
  std::shared_ptr<SharedStopState> sharedState_;
};

// Helper to convert UTF-8 string to UTF-16 wstring for Windows APIs
std::wstring ToWString(const std::string &utf8) {
  if (utf8.empty())
    return L"";
  int size_needed =
      MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), (int)utf8.size(), NULL, 0);
  std::wstring wstrTo(size_needed, 0);
  MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), (int)utf8.size(), &wstrTo[0],
                      size_needed);
  return wstrTo;
}

// Helper to quote arguments for Windows command line
std::wstring QuoteArg(const std::wstring &arg) {
  // If empty, return pair of quotes
  if (arg.empty())
    return L"\"\"";

  // Check if quoting is necessary (contains space, tab, quote, or newline)
  if (arg.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
    return arg;
  }

  std::wstring quoted;
  quoted.push_back(L'"');

  for (size_t i = 0; i < arg.length(); ++i) {
    unsigned int backslashes = 0;
    while (i < arg.length() && arg[i] == L'\\') {
      ++i;
      ++backslashes;
    }

    if (i == arg.length()) {
      // Backslashes at end of string must be escaped if we add a closing quote
      quoted.append(backslashes * 2, L'\\');
    } else if (arg[i] == L'"') {
      // Backslashes before a quote must be escaped, plus the quote itself
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(L'"');
    } else {
      // Backslashes not followed by quote function as literals
      quoted.append(backslashes, L'\\');
      quoted.push_back(arg[i]);
    }
  }

  quoted.push_back(L'"');
  return quoted;
}

// Arguments:
// 0: command (string)
// 1: args (array of strings)
// 2: cwd (string) or empty
// 3: timeoutMs (number)
// 4: memoryLimitBytes (number)
// 5: pipeNameIn (string)
// 6: pipeNameOut (string)
// 7: pipeNameErr (string)
// 8: onSpawn (function)
// Returns: { pid: number, result: Promise<AddonResult> }
//
Napi::Value SpawnProcess(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 9) {
    Napi::TypeError::New(env, "Expected 9 arguments")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string command = info[0].As<Napi::String>().Utf8Value();
  Napi::Array argsArray = info[1].As<Napi::Array>();
  std::string cwd = info[2].As<Napi::String>().Utf8Value();
  uint32_t timeoutMs = info[3].As<Napi::Number>().Uint32Value();
  double memoryLimitMB = info[4].As<Napi::Number>().DoubleValue();
  std::string pipeNameIn = info[5].As<Napi::String>().Utf8Value();
  std::string pipeNameOut = info[6].As<Napi::String>().Utf8Value();
  std::string pipeNameErr = info[7].As<Napi::String>().Utf8Value();
  Napi::Function onSpawn = info[8].As<Napi::Function>();

  uint64_t memoryLimitBytes =
      static_cast<uint64_t>(memoryLimitMB * 1024.0 * 1024.0);

  // Prepare command line (Windows expects a single string)
  std::wstring wCommand = ToWString(command);
  std::wstring cmdLine =
      QuoteArg(wCommand); // Quote the command path too just in case
  for (uint32_t i = 0; i < argsArray.Length(); i++) {
    std::string arg = argsArray.Get(i).As<Napi::String>().Utf8Value();
    cmdLine += L" " + QuoteArg(ToWString(arg));
  }

  // Connect to the Named Pipes
  // CAUTION: The server side (Node.js) must be listening already.
  // We use CreateFile to open the client end of the pipe.

  SECURITY_ATTRIBUTES sa;
  sa.nLength = sizeof(SECURITY_ATTRIBUTES);
  sa.bInheritHandle = TRUE;
  sa.lpSecurityDescriptor = NULL;

  auto openPipe = [&](const std::string &name, DWORD access) -> HANDLE {
    std::wstring wName = ToWString(name);
    HANDLE hPipe = CreateFileW(wName.c_str(), access,
                               0, // No sharing
                               &sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    return hPipe;
  };

  // stdout/stderr are WRITTEN to by child (GENERIC_WRITE)
  // stdin is READ by child (GENERIC_READ)

  HANDLE hStdin = openPipe(pipeNameIn, GENERIC_READ);
  HANDLE hStdout = openPipe(pipeNameOut, GENERIC_WRITE);
  HANDLE hStderr = openPipe(pipeNameErr, GENERIC_WRITE);

  if (hStdin == INVALID_HANDLE_VALUE || hStdout == INVALID_HANDLE_VALUE ||
      hStderr == INVALID_HANDLE_VALUE) {
    DWORD err = GetLastError();
    if (hStdin != INVALID_HANDLE_VALUE)
      CloseHandle(hStdin);
    if (hStdout != INVALID_HANDLE_VALUE)
      CloseHandle(hStdout);
    if (hStderr != INVALID_HANDLE_VALUE)
      CloseHandle(hStderr);
    Napi::Error::New(env, "Failed to connect to named pipes: " +
                              GetErrorMessage(err))
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  STARTUPINFOW siStartInfo;
  PROCESS_INFORMATION piProcInfo;
  ZeroMemory(&siStartInfo, sizeof(siStartInfo));
  siStartInfo.cb = sizeof(siStartInfo);
  siStartInfo.hStdError = hStderr;
  siStartInfo.hStdOutput = hStdout;
  siStartInfo.hStdInput = hStdin;
  siStartInfo.dwFlags |= STARTF_USESTDHANDLES;

  ZeroMemory(&piProcInfo, sizeof(piProcInfo));

  std::wstring wCwd = ToWString(cwd);
  LPCWSTR lpCwd = wCwd.empty() ? NULL : wCwd.c_str();

  BOOL success = CreateProcessW(NULL, &cmdLine[0], NULL, NULL, TRUE,
                                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT |
                                    CREATE_NO_WINDOW,
                                NULL, lpCwd, &siStartInfo, &piProcInfo);

  CloseHandle(hStdin);
  CloseHandle(hStdout);
  CloseHandle(hStderr);

  if (!success) {
    DWORD err = GetLastError();
    Napi::Error::New(env, "CreateProcessW failed: " + GetErrorMessage(err))
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // NOTE: We do NOT create the Job Object here.
  // We defer that to the WaitForProcessWorker so it can manage the Job lifetime
  // and query it for statistics (Peak Memory, etc).
  // Although this introduces a small window where the process runs without
  // limits, it avoids double-assignment errors and complexity sharing the
  // handle.

  ResumeThread(piProcInfo.hThread);
  CloseHandle(piProcInfo.hThread);

  DWORD pid = piProcInfo.dwProcessId;
  // Duplicate process handle for the background worker thread
  HANDLE hProcessDup = NULL;
  DuplicateHandle(GetCurrentProcess(), piProcInfo.hProcess, GetCurrentProcess(),
                  &hProcessDup, 0, FALSE, DUPLICATE_SAME_ACCESS);
  CloseHandle(piProcInfo.hProcess);

  // Notify JS
  onSpawn.Call({});

  auto sharedState = std::make_shared<SharedStopState>();

  // Start monitoring
  auto worker = new WaitForProcessWorker(env, hProcessDup, pid, timeoutMs,
                                         memoryLimitBytes, sharedState);
  auto promise = worker->GetPromise();
  worker->Queue();

  Napi::Object result = Napi::Object::New(env);
  result.Set("pid", Napi::Number::New(env, pid));
  result.Set("result", promise);

  // Expose cancel function
  // We capture sharedState by value (shared_ptr copy) in the lambda
  result.Set("cancel", Napi::Function::New(
                           env,
                           [sharedState](const Napi::CallbackInfo &info) {
                             sharedState->SignalStop();
                           },
                           "cancel"));

  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("spawn", Napi::Function::New(env, SpawnProcess, "spawn"));
  return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
