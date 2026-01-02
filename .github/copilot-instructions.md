# Fast Olympic Coding – Copilot Instructions

This repository contains a VS Code extension that provides two webview-based tools for competitive programming: **Judge** and **Stress**.

- `src/extension/`: Extension host (Node.js) backend. Registers views/commands and implements the runtime that compiles/runs code.
- `src/webview/`: Webview UI (Svelte) for Judge and Stress.
- `src/shared/`: Shared protocol between extension and webviews (schemas, message unions, string-literal enums).
- `src/addons/`: Optional native addons (platform-specific) used for efficient memory stats.
- `rspack.config.ts` / `tsconfig*.json` / `eslint.config.mjs`: Build, bundling, and lint configuration.
- `dist/`: Build output (extension bundle + webview bundles + copied assets).

Path-specific rules live in `.github/instructions/*.instructions.md` and are applied automatically based on file globs:

- Build/tooling config: `.github/instructions/build-and-config.instructions.md` (package.json, rspack config, TS configs, ESLint config)
- Extension backend: `.github/instructions/extension-backend.instructions.md` (`src/extension/**`)
- Shared contracts: `.github/instructions/shared-contracts.instructions.md` (`src/shared/**`)
- Webview frontend: `.github/instructions/webview-frontend.instructions.md` (`src/webview/**`)
- Native addons: `.github/instructions/native-addon.instructions.md` (binding.gyp, addons, runtime loader)
