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
- Solution and Judge run with Generator mediating
- Uses `interactiveSecretPromise` to wait for webview to receive the secret
- Solution runs as interactor between Generator and user solution

## State Persistence

Persisted per-file data:

- `interactiveMode`: boolean
- `states`: Array of `{ state: StateId, shown: boolean }`

The stdio content is NOT persisted (only visibility state).

## Message Handling

- `RUN`: Start stress loop
- `STOP`: Set stopFlag, stop current iteration
- `VIEW`: Open full stdio in new editor
- `ADD`: Copy Generator output to Judge testcases
- `OPEN`: Open the corresponding file (generator/judge file)
- `CLEAR`: Stop and clear all state
- `SAVE`: Persist interactiveMode setting
- `TOGGLE_VISIBILITY`: Toggle state details visibility

## Background Task Tracking

- `getRunningStressSessions()`: Returns array of file paths with running stress
- `stopStressSession(file)`: Stop stress for a specific file
- `onDidChangeBackgroundTasks`: Event for PanelViewProvider

## Key Methods

- `_createContext(file, persistedState)`: Initialize context with states
- `_createState(file, id)`: Create state with bound event handlers
- `run()`: Public entry point, calls `_doRun`
- `stop()`: Set stopFlag
- `_view()`: Open stdio in readonly editor
- `_add()`: Copy current testcase to JudgeViewProvider
- `_open()`: Open Generator/Judge file in editor
