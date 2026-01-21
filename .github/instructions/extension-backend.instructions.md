---
applyTo: "src/extension/**/*.ts"
---

## Architecture

- **BaseViewProvider**: Abstract base for webview providers. Handles webview setup, CSP nonce generation, message validation via Valibot, and workspaceState access keyed by file path.
- **JudgeViewProvider** / **StressViewProvider**: File-scoped controllers extending BaseViewProvider. Hiding the webview does not tear down state or stop processes; teardown belongs in `onDispose()`.
- **PanelViewProvider**: Tree data provider for the status bar popup view. Shows Competitive Companion status, running judge testcases (by file), and running stress sessions.

## File Persistence Lifecycle

Both Judge and Stress implement the same file-switching pattern:

1. `loadCurrentFileData()` is the entry point when the webview becomes visible
2. `_ensureActiveEditorListener()` subscribes to editor changes
3. `_handleActiveEditorChange()` filters non-file schemes and calls `_switchToFile()`
4. `_switchToFile(file)` loads persisted data from workspaceState, creates in-memory state, and rehydrates the webview
5. `_switchToNoFile()` handles cases where no valid file is open
6. `_rehydrateWebviewFromState()` sends current in-memory state to the webview

When switching files, stop any running processes for the previous file before switching to the new one.

## TextHandler

Use `TextHandler` from `src/extension/utils/vscode.ts` for all streamed output. It:

- Keeps full data internally for comparisons (answer checking)
- Truncates display output (max characters/lines)
- Normalizes CRLF to LF
- Ensures trailing newline on final writes

Write modes:

- `"batch"`: Batched updates, throttled for performance
- `"force"`: Immediate update, bypasses throttling
- `"final"`: Final write, applies truncation rules and trailing newline

Always call `.reset()` before a fresh run.

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

## Debug Workflow

Debug support uses **attach mode**:

1. Generate a fresh port via `findAvailablePort()`
2. Resolve `${debugPort}` in both `debugCommand` and launch config
3. Start debug-wrapped process via `Runnable`
4. Call `vscode.debug.startDebugging()` with fully-resolved config

Track debug sessions via `onDidStartDebugSession` / `onDidTerminateDebugSession`. Tag configs with `fastolympiccodingTestcaseId` to identify which testcase is being debugged.

## Competitive Companion

`competitiveCompanion.ts` implements an HTTP server receiving problem data from the browser extension. Problems are queued in `ProblemQueue` and processed sequentially. Users select target files via QuickPick for batch problems.

## Logging

Use `getLogger(component)` from `src/extension/utils/logging.ts`. Component names: `"runtime"`, `"judge"`, `"stress"`, `"competitive-companion"`.

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
