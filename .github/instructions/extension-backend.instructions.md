---
applyTo: "src/extension/**/*.ts"
---

## Architecture

- **BaseViewProvider**: Abstract base for webview providers. Handles webview setup, CSP nonce generation, message validation via Valibot, and workspaceState access keyed by file path.
- **JudgeViewProvider** / **StressViewProvider**: File-scoped controllers extending BaseViewProvider. Hiding the webview does not tear down state or stop processes; teardown belongs in `onDispose()`.
- **PanelViewProvider**: Tree data provider for the status bar popup view. Shows Competitive Companion status, running judge testcases (by file), and running stress sessions.

## File Persistence Lifecycle

Both Judge and Stress implement the same file-switching pattern defined in `BaseViewProvider`:

1. `loadCurrentFileData()` is the entry point when the webview becomes visible
2. `_ensureActiveEditorListener()` subscribes to editor changes
3. `_handleActiveEditorChange()` filters non-file/untitled schemes and calls `_switchToFile()`
4. `_syncOrSwitchToTargetFile()` decides between rehydrating the current file or switching:
   - Same file with existing state → `_rehydrateWebviewFromState()`
   - Different file → `_switchToFile(file)`
   - No file → `_sendShowMessage(false)`
5. `_switchToFile(file)` loads persisted data from workspaceState, creates in-memory state, and rehydrates the webview
6. `_switchToNoFile()` handles cases where no valid file is open
7. `_rehydrateWebviewFromState()` sends current in-memory state to the webview

Subclasses must implement these abstract methods:

- `_switchToFile(file)` / `_switchToNoFile()` / `_rehydrateWebviewFromState()` / `_sendShowMessage(visible)`
- `_hasState()`: Override to control same-file rehydration (e.g., Judge checks `_runtime.state.length > 0`)

When switching files, processes are **not** stopped. Instead, they are moved to the background (e.g., via `_moveCurrentStateToBackground`) and trigger `_onDidChangeBackgroundTasks`. The `PanelViewProvider` monitors and displays these running background tasks.

## Run Settings

- **`runSettingsCommands.ts`**: Registers commands (`editRunSettings`, `resetRunSettings`) and provides default `languageTemplates` for various languages (C++/GCC, C++/Clang, Python, PyPy, Java, Go, Rust, JavaScript, etc.).
- **`vscode.ts`**: Provides `getFileRunSettings`, `initializeRunSettingsWatcher`, and `resolveVariables` to parse and resolve VS Code variables (like `${fileDirname}`) in commands.

### Hierarchical Run Settings Merging

`getFileRunSettings(file)` traverses from the file's directory up to the workspace root, loading and merging `runSettings.json` files along the way via `deepMerge()`. Closer-to-file settings override ancestor settings. The function also:

- Applies defaults from the `runSettings.schema.json` schema file
- Resolves VS Code variables via `resolveVariables()`
- Validates via `RunSettingsSchema` (Valibot)
- Caches loaded settings per directory; cache is invalidated by a `FileSystemWatcher`
- Returns `FileRunSettings` which includes the merged settings plus the resolved `languageSettings` for the file's extension

## Extended VS Code Utilities (`vscode.ts`)

- **`TextHandler`**: For all streamed output. Keeps full data internally, truncates display output, normalizes CRLF to LF, ensures trailing newline. Write modes: `"batch"`, `"force"`, `"final"`. Always call `.reset()` before a fresh run.
- **`ReadonlyStringProvider`**: Manages the custom `fastolympiccoding` URI scheme for displaying read-only text documents.
- **`openInNewEditor` / `openInTerminalTab`**: Helpers for displaying output. Terminal tabs support ANSI colors and native clickable file links.
- **`openOrCreateFile`**: Helper for file management.
- **`getFileWorkspace`**: Returns workspace folder or file directory. Used for run settings and CC target resolution.
- **`getAttachDebugConfiguration`**: Looks up a named debug configuration from workspace `launch.json`.
- **`showOpenRunSettingsErrorWindow` / `showAddLanguageSettingsError`**: Error UI helpers that offer quick-fix actions.

## UI/UX Features

- **Template Folding (`folding.ts`)**: `TemplateFoldingProvider` handles folding ranges for inserted template regions.
- **Changelog (`changelog.ts`)**: `showChangelog` handles semver comparison and displays the changelog on extension updates.
- **Status Bar (`statusBar.ts`)**: `createStatusBarItem` creates the main status bar entry point that triggers the `PanelViewProvider`.

## Template Dependency Resolution

`getTemplateContent` in `index.ts` handles reading template files and detecting cyclic dependencies via DFS before insertion.

## Runnable and runtime.ts

The `Runnable` class wraps process execution with:

- Native addon integration for strict time/memory enforcement
- Named pipe/socket IPC for stdio
- Termination tracking (`RunTermination` type)

Termination mapping helpers:

- `mapCompilationTermination()`: Maps to CE status on failure
- `mapTestcaseTermination()`: Maps to RE/TL/ML/AC based on exit conditions
- `severityNumberToInteractiveStatus()`: For interactive testcases with multiple processes

Use `compile()` for compilation (caches by file checksum and compile command).

### Debounced Saving

JudgeViewProvider uses a debounced save pattern:

- `requestSave()`: Schedules a bulk save after 200ms (resets timer on repeated calls)
- `forceSave()`: Immediately saves all state (used during `onDispose()`)
- `_saveAllState()`: Writes all contexts to workspaceState in a single bulk update

StressViewProvider saves state synchronously via `_saveState(file)` after each operation.

## Debug Workflow

Debug support uses **attach mode**:

1. Generate a fresh port via `findAvailablePort()`
2. Resolve `${debugPort}` in both `debugCommand` and launch config
3. Start debug-wrapped process via `Runnable`
4. Call `vscode.debug.startDebugging()` with fully-resolved config

Track debug sessions via `onDidStartDebugSession` / `onDidTerminateDebugSession`. Tag configs with `fastolympiccodingTestcaseUuid` to identify which testcase is being debugged.

## Competitive Companion

`competitiveCompanion.ts` implements an HTTP server receiving problem data from the browser extension. Problems are queued in `ProblemQueue` and processed sequentially. Users select target files via QuickPick for batch problems.

## Logging

Use `getLogger(component)` from `src/extension/utils/logging.ts`. Component names: `"runtime"`, `"judge"`, `"stress"`, `"competitive-companion"`, `"compilation"`, `"vscode"`.

Log levels (controlled via VS Code's "Developer: Set Log Level"):

- `trace`: High-frequency events (per-iteration)
- `debug`: Sampling/diagnostics
- `info`: Lifecycle events (process start/stop)
- `warn`: Recoverable issues (invalid input, missing config)
- `error`: Failures (process spawn, file I/O, schema validation)

Log diagnostic context not visible in UI (command args, cwd, exit codes, port allocations). Avoid logging full stdin/stdout/stderr or CC payloads.

## Extending Functionality

1. Update contracts in `src/shared/` (add to string literal arrays, create Valibot schema, add to union)
2. Extend the Provider to handle new messages
3. Persist state via `writeStorage()` only after all mutations complete
4. Implement webview handling in `App.svelte`
