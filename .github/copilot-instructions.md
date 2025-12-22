# Fast Olympic Coding – Copilot Instructions

This repository contains a VS Code extension that provides two webview-based tools for competitive programming: **Judge** and **Stress**.

- Extension backend code lives under `src/extension/**` and uses the VS Code API. `JudgeViewProvider` and `StressViewProvider` extend `BaseViewProvider`, which handles webview setup, CSP nonce generation, workspaceState storage, and message dispatch.
- Webview frontend code lives under `src/webview/**` and is built with Svelte 5 using runes for reactive state management. It talks to the extension only through typed messages defined in `src/shared/*-messages.ts`.
- Shared enums, message contracts, and Valibot schemas live under `src/shared/**` and define the protocol between extension and webviews (including the `Status` lifecycle in `enums.ts` and testcase structures in `schemas.ts`).

Build and tooling:

- Use `npm install` to install dependencies.
- Use `npm run watch` during development and `npm run prod` for production builds. Rspack bundles the extension and webviews into `dist/`. Styles are co-located within Svelte components.
- Run `npm run lint` and `npm run format` to apply ESLint (TypeScript + Svelte) and Prettier rules.

Native addon (Windows-only):

- The repo includes an optional Windows-only native addon (`win32-memory-stats`) that provides efficient process memory stats for memory-limit features.
- It is built with `node-gyp` (`binding.gyp`), copied into `dist/` by Rspack, and loaded lazily from `src/extension/utils/runtime.ts` with a graceful fallback when unavailable.

Design and implementation guidelines:

- All extension ↔ webview communication must use the discriminated unions and Valibot schemas in `src/shared/*-messages.ts`. Append to string literal arrays instead of reordering to keep string values and stored data stable.
- Shared enums are defined as `const` string literal tuples (e.g., `StatusValues = ["CE", "RE", ...] as const`) validated via `v.picklist(...)`. Append new values at the end; do not rename or reorder existing values.
- Use `compile()` and `Runnable` from `src/extension/utils/runtime.ts` for running code, and `resolveVariables` / `resolveCommand` from `src/extension/utils/vscode.ts` for safe, cross-platform commands.
- Use `TextHandler` for streamed output; always call `.reset()` for a fresh run and `.write(data, last)` for updates.
- **Logging:** Always use `getLogger(component)` from `src/extension/utils/logging.ts` for diagnostics. Never use `console.*` methods. Log metadata (file paths, command args, error reasons) but avoid logging large payloads or stdin/stdout content.
- **Workspace state persistence:** `BaseViewProvider.writeStorage(file, data)` is async and must be awaited. Pass `undefined` as data to delete the key from storage (cleanup pattern). State validation happens on read; malformed data falls back to defaults.
- **Process lifecycle:** Use explicit stop flags (`_stopRequested[i]`, `_stopFlag`) instead of inferring stop intent from process signals. Use `mapCompilationTermination()` / `mapTestcaseTermination()` to convert `RunTermination` → `Status` with correct context (CE vs RE for non-zero exit).
- **Runnable lifecycle:** `Runnable.run()` resets internal state automatically. Always call `.on()` to attach listeners (fluent chaining pattern). Await `.done` to get `RunTermination` value. Call `.dispose()` for cleanup (removes all listeners via `removeAllListeners()`).
- **View persistence:** Judge and Stress are designed to preserve in-memory state (and any running `Runnable` processes) when their webviews are hidden/revealed. Lifecycle teardown belongs in `onDispose()`; hiding a view should not implicitly stop runs. Runs should stop/reset when the active editor switches to a different file (file-scoped state), using the same "webview focus may temporarily clear active editor" guard as Judge.
- Debugging support is implemented as **attach-mode** from Judge: the extension starts a debug-wrapped process via `Runnable` (so it can pipe testcase stdin), then triggers VS Code debugging by configuration name via `vscode.debug.startDebugging(...)`.
- Per-language debug configuration lives in `fastolympiccoding.runSettings` alongside compile/run commands: `debugCommand` (starts debug server/wrapper) and `debugAttachConfig` (name of a `launch.json` configuration to attach with).
- Debugging uses a per-session dynamic port:
  - The extension generates a fresh `${debugPort}` for every debug run via `findAvailablePort()` and injects it into both `debugCommand` and the selected `launch.json` configuration.
  - VS Code does not resolve `${debugPort}` by itself; the extension resolves variables and passes a fully-resolved config to `vscode.debug.startDebugging(...)`.
  - The debug attach flow waits for the process to spawn, then uses a short delay before attaching (there is no reliable cross-platform way to detect when a debug server is ready).
  - `${debugPort}` is optional (hardcoded ports still work) but reintroduce port-conflict failures on rapid re-runs.
- Use Svelte 5 runes for webview state: `$state()` for reactive variables, `$derived()` for computed values, `$effect()` for side effects, and `$props()` for component props.
- Keep changes minimal and consistent with existing patterns. Prefer reusing the Judge/Stress provider and webview patterns over introducing new architectures.

Additional path-specific details are defined in `.github/instructions/*.instructions.md`, which Copilot uses when working in matching files.

Always use context7 when I need code generation, setup or configuration steps, or
library/API documentation. This means you should automatically use the Context7 MCP
tools to resolve library id and get library docs without me having to explicitly ask.