# Fast Olympic Coding – AI Agent Instructions

Purpose: Enable an AI coding agent to quickly extend, debug, and maintain this VSCode extension. Keep edits minimal, fast, and consistent with existing patterns.

## Architecture Snapshot
- Single VSCode extension with two webview views: `Judge` and `Stress` (registered in `package.json` under `views` and implemented in `src/extension/providers/`).
- Build outputs go to `dist/` via `esbuild.mjs` (Node CJS for extension code, ES modules for webviews). Source TypeScript in `src/extension/**` (extension backend) and `src/webview/**` (Preact frontend). Shared message/type contracts in `src/shared/**`.
- `BaseViewProvider` encapsulates common webview setup, storage access (`workspaceState` keyed by active file path), CSP nonce generation, and message posting.
- Runtime interaction pattern: Provider classes (e.g. `JudgeViewProvider`, `StressViewProvider`) manage state maps, transform persisted storage to in‑memory `TextHandler` objects, then push incremental updates to the webview via typed message enums.

## Data & Messaging Conventions
- All extension ⇄ webview communication uses discriminated unions defined in `src/shared/*-messages.ts`. Never ad‑hoc strings; extend enums + interfaces there first.
- Status lifecycle (`Status` enum in `src/shared/types.ts`): COMPILING → RUNNING → (AC|WA|RE|TL|CE|NA|EDITING). AC requires accepted output; WA mismatched; TL uses AbortSignal timeout flag; RE non‑zero exit or signal.
- Testcases persist per file using `workspaceState` with key = view id (`judge` / `stress`) then inner key = absolute file path. When state is “default” (no testcases + timeLimit 0) delete storage to avoid clutter.
- `TextHandler` enforces display truncation (+ debounced batched writes) and preserves logical spaces/newlines; always use its `.write(data, last)` & `.reset()` rather than manual concatenation.

## Execution & Performance
- Compilation caching: `compile()` in `runtime.ts` uses md5 hash + full command string (`lastCompiled` map) to skip recompiles; preserve this logic when changing build triggers.
- `Runnable` wraps a child process with timing + timeout (`AbortSignal.timeout`) and collects elapsed, exitCode, signal, and timeout flag; reuse instead of spawning manually.
- Stress loop (`StressViewProvider.run`): sequential generator → pipe output to solution & good solution; break early on mismatch or failure; respects `stressTestcaseTimeLimit` and global `stressTimeLimit`. Maintain early‑exit semantics for speed.

## Variable Resolution & Commands
- Dynamic `${...}` variables resolved via `resolveVariables` / `resolveCommand` in `vscode.ts`. Includes custom vars: `${exeExtname}`, `${path:...}` normalizer, and `${fileDirnameBasename}`. Always resolve before spawning external processes.
- Adding new settings that inject paths or commands should integrate with these helpers for platform safety.

## Build / Dev Workflow
- Install deps then run: `npm run watch` (parallel esbuild + Tailwind + type checking) during development; `npm run prod` for publishing (minified + no sourcemaps). `main` entry = `./dist/extension.js`.
- Do not import `vscode` in webview code; extension side only. Webview script sources are loaded via `BaseViewProvider` with CSP nonce; keep new assets under `dist/` or referenced via `webview.asWebviewUri`.

## Adding Features
1. Define shared contract (types / messages) under `src/shared/` (new enum member + interface + union). Maintain numeric enum ordering at end to avoid breaking existing webview expectations.
2. Extend Provider class: mutate internal state maps/arrays; call `_postMessage` with new message type; persist via `writeStorage()` only after full state mutation.
3. Webview side: handle new message in switch; never rely on message ordering except initial `INITIAL_STATE` or `SHOW` gating visibility.
4. For new processes use `compile()` + `Runnable`; avoid duplicated spawn logic.

## Common Pitfalls
- Forgetting to reset `TextHandler` before reusing leads to stale truncated output; always call `.reset()` when starting a fresh run.
- Skipping variable resolution causes platform path issues (Windows exe extension). Use `resolveCommand` for every run/compile path.
- Changing enum numeric values breaks persisted `Status` data; only append new values.
- Writing directly to `workspaceState` without pruning default data causes unbounded growth; follow existing “default means delete” approach.

## Example Extensions
- Add a new view: create `<NewView>ViewProvider` extending `BaseViewProvider`, register in `index.ts` with `registerWebviewViewProvider`, add view & activation events in `package.json`, add shared `newview-messages.ts`.
- Add a new testcase action: append to `Action` enum, interface in `judge-messages.ts`, implement in `_action` switch, then webview UI button dispatching `ProviderMessageType.ACTION`.

## Style & Dependency Notes
- Prefer minimal external deps; follow existing patterns (Preact + signals only). Avoid adding heavy state libs—reuse `TextHandler` + signals.
- Keep patches surgical: avoid broad refactors that reformat unchanged files.

## When Unsure
Briefly inspect analogous patterns in `JudgeViewProvider` / `StressViewProvider` before introducing novel state flows.

---
Feedback: Clarify any unclear lifecycle or add missing workflow details (tests, CI specifics) if required.
