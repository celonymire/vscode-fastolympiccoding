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

The `handleMessage` method dispatches based on `msg.type`. Top-level message types include:

- `LOADED`: Loads the current file data
- `NEXT`: Moves to the next testcase
- `SAVE`: Saves testcase data
- `VIEW`: Opens full stdio in a new editor
- `COPY`: Copies stdio content to clipboard
- `STDIN`: Updates stdin
- `TL`: Updates time limit
- `ML`: Updates memory limit
- `REQUEST_TRIMMED_DATA`: Fetches truncated data for display
- `REQUEST_FULL_DATA`: Fetches full data for editing
- `NEW_INTERACTOR_SECRET`: Generates a new interactor secret
- `ACTION`: Calls `this._action(msg)` which dispatches based on the `action` field

Actions handled by `_action`:

- `RUN`: Execute single testcase
- `STOP`: Cancel running testcase
- `DELETE`: Remove testcase
- `ACCEPT`: Copy stdout to acceptedStdout
- `DECLINE`: Clear acceptedStdout
- `TOGGLE_VISIBILITY`: Toggle testcase details visibility
- `TOGGLE_SKIP`: Toggle skip flag
- `COMPARE`: Open diff view
- `DEBUG`: Run in debug mode
- `OPEN_INTERACTOR`: Open interactor file
- `TOGGLE_INTERACTIVE`: Toggle interactive mode

## Background Task Tracking

`_contexts` map holds contexts for all files (not just active). Methods:

- `getAllBackgroundTasks()`: Returns Map of file → running testcase UUIDs
- `getBackgroundTasksForFile(file)`: Returns an array of running testcase UUIDs for a specific file
- `stopBackgroundTasksForFile(file)`: Stop all running testcases for a file
- `stopAllBackgroundTasks()`: Stops all background tasks across all files
- `onDidChangeBackgroundTasks`: Event for PanelViewProvider to refresh

## Key Methods

- `_getExecutionContext(uuid, extraVariables?)`: Validates settings, resolves variables, returns context for execution
- `_prepareRunningState(testcase, file)`: Resets TextHandlers, sets RUNNING status
- `_launchTestcase(ctx, bypassLimits, debugMode)`: Spawns process, wires stdio
- `_launchInteractiveTestcase(ctx, bypassLimits, debugMode)`: Handles two-process interactive flow
- `addTestcaseToFile(file, testcase, timeLimit?, memoryLimit?)`: Adds testcase from external source (Competitive Companion)
- `exportTestcasesForFile(file)`: Serializes and exports testcases for a given file
- `appendImportedTestcasesForFile(file, rawData)`: Parses, imports, and appends testcases to a file
