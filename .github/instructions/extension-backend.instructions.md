---
applyTo: "src/extension/**/*.ts,src/extension/**/*.tsx"
---

This repository is a VS Code extension called "Fast Olympic Coding." The `src/extension/**` tree contains the extension backend code (Node.js, VS Code API) that powers the Judge and Stress views.

When changing files under `src/extension/**`:

- Treat `JudgeViewProvider` and `StressViewProvider` as the main controllers for their respective webviews. They extend `BaseViewProvider`, which encapsulates webview setup, CSP nonce generation, message posting, and workspaceState access keyed by active file path.
- All extension ⇄ webview communication must go through the discriminated unions and enums in `src/shared/*-messages.ts`. Do not introduce ad-hoc string message types; instead, extend the shared enums and message unions.
- The `Status` enum in `src/shared/types.ts` represents the lifecycle: COMPILING → RUNNING → (AC | WA | RE | TL | CE | NA | EDITING). Preserve existing numeric values and append new states only at the end.
- Persisted testcases and limits are stored in `workspaceState`, with a top-level key per view ("judge" / "stress") and an inner key per absolute file path. Treat the "default" state (no testcases and timeLimit = 0) as "no data" and delete storage entries rather than persisting defaults indefinitely.
- Use `TextHandler` (from the extension utilities) for all streamed output shown in the webviews. Always call `.reset()` before a fresh run and `.write(data, last)` to update output so truncation, batching, and whitespace handling remain correct.
- For compilation and execution, use the helpers in `src/extension/utils/runtime.ts`. Specifically, use `compile()` (which caches builds by md5 of the full command) and `Runnable` (which wraps child processes with timing, timeout via `AbortSignal.timeout`, and exit/timeout information) instead of spawning processes manually.
- In the Stress view logic, keep the sequential generator pattern that feeds testcases to the solution and reference solution, and ensure the loop respects both per-test (`stressTestcaseTimeLimit`) and global (`stressTimeLimit`) limits while exiting early on the first mismatch or failure for speed.
- Always resolve command variables via `resolveVariables` / `resolveCommand` from `src/extension/utils/vscode.ts` before spawning external processes. Use built-in variables like `${exeExtname}`, `${path:...}`, and `${fileDirnameBasename}` for cross-platform-safe paths.
- Keep patches minimal, prefer existing patterns, and avoid introducing heavy new dependencies in the extension backend unless strictly necessary.

When extending functionality from the extension side:

- Follow the shared feature workflow: update contracts in `src/shared/**`, extend the appropriate Provider (`JudgeViewProvider`, `StressViewProvider`, or a new view provider) to send/receive the new messages, then adjust the corresponding webview handlers.
- For a new view, mirror the existing pattern: create `<NewView>ViewProvider` extending `BaseViewProvider`, register it in `src/extension/index.ts`, add the view configuration and activation events in `package.json`, and define matching message contracts under `src/shared/`.
- For a new Judge action (for example, a new testcase operation), extend the `Action` enum and interfaces in `src/shared/judge-messages.ts`, handle the new case in the provider’s action switch, and wire a matching UI trigger in the Judge webview.
- When unsure about control flow, message patterns, or state persistence, inspect the existing implementations in `JudgeViewProvider` and `StressViewProvider` and stay consistent with those designs.
