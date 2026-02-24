---
applyTo: "**/StressViewProvider.ts"
---

## Overview

`StressViewProvider` manages stress testing with three components: Generator, Solution, and Judge (reference solution). It runs an iterative loop comparing outputs until a mismatch or limit is reached.

## Key Data Structures

```typescript
interface StressContext {
  state: State[]; // [Generator, Solution, Judge]
  combinedInteractiveStderr: string;
  combinedInteractiveStdout: string;
  stopFlag: boolean; // Stop after current iteration
  clearFlag: boolean; // Clear state on stop
  running: boolean;
  interactiveMode: boolean;
  interactiveSecretPromise: Promise<void> | null;
  interactorSecretResolver?: () => void;
  donePromise: Promise<void> | null;
}

interface State {
  state: StateId; // "Generator" | "Solution" | "Judge"
  stdin: TextHandler;
  stdout: TextHandler;
  stderr: TextHandler;
  status: Status;
  shown: boolean; // Visibility toggle
  process?: Runnable;
  // Event handlers for stdio streaming
  errorHandler;
  stdoutDataHandler;
  stdoutEndHandler;
  stderrDataHandler;
  stderrEndHandler;
  closeHandler;
}
```

## Run Loop Pattern (`_doRun`)

1. **Compile all three components in parallel** via `Promise.all([addCompileTask(...)])`:
   - Generator file (`generatorFile` from settings)
   - Solution (current file)
   - Judge file (`goodSolutionFile` from settings)

2. **If any compilation fails**, set CE status and stop

3. **Iterative execution loop**:

   ```
   while (!stopFlag) {
     Run Generator → capture stdout as testInput
     Run Solution with testInput → capture stdout
     Run Judge with testInput → capture stdout
     Compare Solution.stdout vs Judge.stdout
     If mismatch or failure → set WA/RE/TL/ML status, stop
     If stopFlag → exit loop
   }
   ```

4. **On stop**: If `clearFlag`, reset all TextHandlers and statuses

## Interactive Mode

In interactive mode:

- Generator produces a "secret" (like interactor in Judge)
- The **Judge** acts as the interactor (running `interactorFile`), communicating back and forth with the **Solution** (the user's solution).
- The **Generator** provides the initial secret to the Judge.
- Uses `interactiveSecretPromise` to wait for webview to receive the secret

## State Persistence

Persisted per-file data via `StressDataSchema` in `_saveState`:

- `interactiveMode`: boolean
- `states`: Array of `{ state: StateId, shown: boolean, stdin: string, stdout: string, stderr: string, status: Status }`

The stdio content, status, state, and visibility are all persisted for each component.

## Message Handling

- `LOADED`: Loads the current file data
- `RUN`: Start stress loop
- `STOP`: Set stopFlag, stop current iteration
- `VIEW`: Open full stdio in new editor
- `COPY`: Copies specific stdio content to the clipboard
- `ADD`: Copy Generator output to Judge testcases
- `OPEN`: Open the corresponding file (generator/judge file)
- `CLEAR`: Stop and clear all state
- `SAVE`: Persist interactiveMode setting
- `TOGGLE_VISIBILITY`: Toggle state details visibility
- `TOGGLE_INTERACTIVE`: Toggles the interactive mode state

## Background Task Tracking

- `getRunningStressSessions()`: Returns array of file paths with running stress
- `stopStressSession(file)`: Stop stress for a specific file
- `stopAll()`: Stops all stress sessions across all files in the workspace
- `onDidChangeBackgroundTasks`: Event for PanelViewProvider

## Key Methods

- `_createContext(file, persistedState)`: Initialize context with states
- `_createState(file, id)`: Create state with bound event handlers
- `run()`: Public entry point, calls `_doRun`
- `stop()`: Set stopFlag
- `_view()`: Open stdio in readonly editor
- `_add()`: Copy current testcase to JudgeViewProvider
- `_open()`: Open Generator/Judge file in editor
