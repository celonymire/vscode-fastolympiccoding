# Fast Olympic Coding – Copilot Instructions

This repository contains a VS Code extension that provides two webview-based tools for competitive programming: **Judge** and **Stress**.

- `src/extension/`: Extension host (Node.js) backend. Registers views/commands and implements the runtime that compiles/runs code.
- `src/webview/`: Webview UI (Svelte 5) for Judge and Stress.
- `src/shared/`: Shared protocol between extension and webviews (schemas, message unions, string-literal enums).
- `src/addons/`: Platform-specific native addons for efficient process monitoring with strict time/memory enforcement.

Path-specific rules live in `.github/instructions/*.instructions.md` and are applied automatically based on file globs:

- Build/tooling config: `build-and-config.instructions.md` (package.json, rspack config, TS configs, ESLint config)
- Extension backend: `extension-backend.instructions.md` (`src/extension/**`)
- Judge provider: `judge-provider.instructions.md` (`**/JudgeViewProvider.ts`)
- Stress provider: `stress-provider.instructions.md` (`**/StressViewProvider.ts`)
- Shared contracts: `shared-contracts.instructions.md` (`src/shared/**`)
- Webview frontend: `webview-frontend.instructions.md` (`src/webview/**`)
- Native addons: `native-addon.instructions.md` (binding.gyp, addons, runtime loader)

Avoid adding comments that are not strictly necessary for understanding the code. Prioritize clear and concise code over comments. If a piece of code requires extensive commenting to be understood, consider refactoring it for better clarity.

Always use context7 when I need code generation, setup or configuration steps, or library/API documentation. This means you should automatically use the Context7 MCP tools to resolve library id and get library docs without me having to explicitly ask.
