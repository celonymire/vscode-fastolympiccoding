---
applyTo: "**/JudgeViewProvider.ts"
---

## Overview

`JudgeViewProvider` manages testcase execution for the Judge view. It maintains per-file contexts with testcase state, handles both standard and interactive testcase modes.

## Key Data Structures

```typescript
interface RuntimeContext {
  state: State[]; // Array of testcase states
  timeLimit: number; // ms, 0 = no limit
  memoryLimit: number; // MB, 0 = no limit
}

interface State {
  stdin: TextHandler;
  stderr: TextHandler;
  stdout: TextHandler;
  acceptedStdout: TextHandler;
  interactorSecret: TextHandler; // For interactive mode
  process?: Runnable;
  interactorProcess?: Runnable; // For interactive mode
  interactorSecretResolver?: () => void; // Resolves when secret received
  donePromise: Promise<void> | null;
  cancellationSource?: vscode.CancellationTokenSource;
}
```

## Testcase Lifecycle

1. **COMPILING**: Set via `_postMessage` when compilation starts
2. **RUNNING**: Set after successful compilation, process spawned
3. **Terminal states**: AC, WA, RE, TL, ML, CE (via `mapTestcaseTermination()`)

## Interactive Testcase Flow

Interactive testcases run two processes:

1. **Interactor process**: Mediates between user solution and test logic
2. **Main process**: The user's solution

The interactor communicates a "secret" via a separate stdio field. The flow:

1. Start interactor with stdin from testcase
2. Wait for `interactorSecretResolver` (resolved when secret received from webview)
3. Start main process with interactor's output as input
4. Interactor reads main process output, main reads interactor output

Status determination uses `severityNumberToInteractiveStatus()` to combine both process terminations.

## Action Handling

The `handleMessage` method dispatches to action handlers based on `action` field:

- `RUN`: Execute single testcase
- `STOP`: Cancel running testcase
- `DELETE`: Remove testcase
- `ACCEPT`: Copy stdout to acceptedStdout
- `DECLINE`: Clear acceptedStdout
- `TOGGLE_VISIBILITY`: Toggle testcase details visibility
- `TOGGLE_SKIP`: Toggle skip flag
- `COMPARE`: Open diff view
- `DEBUG`: Run in debug mode
- `REQUEST_DATA`: Fetch full data for editing
- `OPEN_INTERACTOR`: Open interactor file

## Background Task Tracking

`_contexts` map holds contexts for all files (not just active). Methods:

- `getAllBackgroundTasks()`: Returns Map of file → running testcase UUIDs
- `stopBackgroundTasksForFile(file)`: Stop all running testcases for a file
- `onDidChangeBackgroundTasks`: Event for PanelViewProvider to refresh

## Key Methods

- `_getExecutionContext(uuid, extraVariables?)`: Validates settings, resolves variables, returns context for execution
- `_prepareRunningState(testcase, file)`: Resets TextHandlers, sets RUNNING status
- `_launchTestcase(ctx, bypassLimits, debugMode)`: Spawns process, wires stdio
- `_launchInteractiveTestcase(ctx, bypassLimits, debugMode)`: Handles two-process interactive flow
- `addTestcaseToFile(file, testcase, timeLimit?, memoryLimit?)`: Adds testcase from external source (Competitive Companion)
