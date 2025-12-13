# Fast Olympic Coding – Copilot Instructions

This repository contains a VS Code extension that provides two webview-based tools for competitive programming: **Judge** and **Stress**.

- Extension backend code lives under `src/extension/**` and uses the VS Code API. `JudgeViewProvider` and `StressViewProvider` extend `BaseViewProvider`, which handles webview setup, CSP nonce generation, workspaceState storage, and message dispatch.
- Webview frontend code lives under `src/webview/**` and is built with React + `@legendapp/state` for reactive state management. It talks to the extension only through typed messages defined in `src/shared/*-messages.ts`.
- Shared enums, message contracts, and Valibot schemas live under `src/shared/**` and define the protocol between extension and webviews (including the `Status` lifecycle in `enums.ts` and testcase structures in `schemas.ts`).

Build and tooling:

- Use `bun install` to install dependencies.
- Use `bun run watch` during development and `bun run prod` for production builds. Rspack bundles the extension and webviews into `dist/`. Each webview has its own `index.css` stylesheet that is bundled alongside its JavaScript.
- Run `bun run lint` and `bun run format` to apply ESLint (TypeScript + React) and Prettier rules.

Design and implementation guidelines:

- All extension ↔ webview communication must use the discriminated unions and Valibot schemas in `src/shared/*-messages.ts`. Append to enums instead of reordering to keep numeric values and stored data stable.
- Use `compile()` and `Runnable` from `src/extension/utils/runtime.ts` for running code, and `resolveVariables` / `resolveCommand` from `src/extension/utils/vscode.ts` for safe, cross-platform commands.
- Use `TextHandler` for streamed output; always call `.reset()` for a fresh run and `.write(data, last)` for updates.
- Use `@legendapp/state` for webview state: wrap components with `observer()`, access values via `.get()`, mutate via `.set()`, and use `<For>` for reactive list rendering.
- Keep changes minimal and consistent with existing patterns. Prefer reusing the Judge/Stress provider and webview patterns over introducing new architectures.

Additional path-specific details are defined in `.github/instructions/*.instructions.md`, which Copilot uses when working in matching files.
