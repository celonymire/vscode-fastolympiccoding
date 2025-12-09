# Fast Olympic Coding – Copilot Instructions

This repository contains a VS Code extension that provides two webview-based tools for competitive programming: **Judge** and **Stress**.

- Extension backend code lives under `src/extension/**` and uses the VS Code API. `JudgeViewProvider` and `StressViewProvider` extend `BaseViewProvider`, which handles webview setup, CSP nonce generation, workspaceState storage, and message dispatch.
- Webview frontend code lives under `src/webview/**` and is built with Preact. It talks to the extension only through typed messages defined in `src/shared/*-messages.ts`.
- Shared enums, message contracts, and types live under `src/shared/**` and define the protocol between extension and webviews (including the `Status` lifecycle and testcase structures).

Build and tooling:

- Use `bun install` to install dependencies.
- Use `bun run watch` during development and `bun run prod` for production builds. The build is two-stage: Tailwind CLI compiles `src/styles/global.css` to `dist/styles.css`, then Rspack bundles the extension and webviews into `dist/`.
- Run `bun run lint` and `bun run format` to apply ESLint (TypeScript + Preact) and Prettier rules.

Design and implementation guidelines:

- All extension ↔ webview communication must use the discriminated unions and enums in `src/shared/*-messages.ts`. Append to enums instead of reordering to keep numeric values and stored data stable.
- Use `compile()` and `Runnable` from `src/extension/utils/runtime.ts` for running code, and `resolveVariables` / `resolveCommand` from `src/extension/utils/vscode.ts` for safe, cross-platform commands.
- Use `TextHandler` for streamed output; always call `.reset()` for a fresh run and `.write(data, last)` for updates.
- Keep changes minimal and consistent with existing patterns. Prefer reusing the Judge/Stress provider and webview patterns over introducing new architectures.

Additional path-specific details are defined in `.github/instructions/*.instructions.md`, which Copilot uses when working in matching files.
