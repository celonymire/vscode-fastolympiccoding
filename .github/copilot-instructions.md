# Fast Olympic Coding – Copilot Instructions

This repository contains a VS Code extension that provides two webview-based tools for competitive programming: **Judge** and **Stress**.

- Extension backend code lives under `src/extension/**` and uses the VS Code API. `JudgeViewProvider` and `StressViewProvider` extend `BaseViewProvider`, which handles webview setup, CSP nonce generation, workspaceState storage, and message dispatch.
- Webview frontend code lives under `src/webview/**` and is built with Svelte 5 using runes for reactive state management. It talks to the extension only through typed messages defined in `src/shared/*-messages.ts`.
- Shared enums, message contracts, and Valibot schemas live under `src/shared/**` and define the protocol between extension and webviews (including the `Status` lifecycle in `enums.ts` and testcase structures in `schemas.ts`).

Build and tooling:

- Use `npm install` to install dependencies.
- Use `npm run watch` during development and `npm run prod` for production builds. Rspack bundles the extension and webviews into `dist/`. Styles are co-located within Svelte components.
- Run `npm run lint` and `npm run format` to apply ESLint (TypeScript + Svelte) and Prettier rules.

Design and implementation guidelines:

- All extension ↔ webview communication must use the discriminated unions and Valibot schemas in `src/shared/*-messages.ts`. Append to enums instead of reordering to keep numeric values and stored data stable.
- Use `compile()` and `Runnable` from `src/extension/utils/runtime.ts` for running code, and `resolveVariables` / `resolveCommand` from `src/extension/utils/vscode.ts` for safe, cross-platform commands.
- Use `TextHandler` for streamed output; always call `.reset()` for a fresh run and `.write(data, last)` for updates.
- Debugging support is implemented as **attach-mode** from Judge: the extension starts a debug-wrapped process via `Runnable` (so it can pipe testcase stdin), then triggers VS Code debugging by configuration name via `vscode.debug.startDebugging(...)`.
- Per-language debug configuration lives in `fastolympiccoding.runSettings` alongside compile/run commands: `debugCommand` (starts debug server/wrapper) and `debugAttachConfig` (name of a `launch.json` configuration to attach with).
- Use Svelte 5 runes for webview state: `$state()` for reactive variables, `$derived()` for computed values, `$effect()` for side effects, and `$props()` for component props.
- Keep changes minimal and consistent with existing patterns. Prefer reusing the Judge/Stress provider and webview patterns over introducing new architectures.

Additional path-specific details are defined in `.github/instructions/*.instructions.md`, which Copilot uses when working in matching files.

Always use context7 when I need code generation, setup or configuration steps, or
library/API documentation. This means you should automatically use the Context7 MCP
tools to resolve library id and get library docs without me having to explicitly ask.
