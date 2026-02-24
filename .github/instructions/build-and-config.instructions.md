---
applyTo: "package.json,rspack.config.ts,eslint.config.mjs,tsconfig*.json"
---

This repository uses npm, Rspack, TypeScript, and ESLint to build and lint the Fast Olympic Coding VS Code extension and its webviews.

When working on the build, config, or tooling files matched by this pattern:

- Use `npm install` to install dependencies. Prefer npm scripts in `package.json` over ad-hoc commands.

**Build System (Rspack):**

- Builds are driven by **Rspack mode** (not `NODE_ENV`):
  - `npm run build` runs `rspack build --mode development`
  - `npm run watch` runs `rspack build --watch --mode development`
  - `npm run prod` runs `rspack build --mode production`
- `rspack.config.ts` exports a dual configuration: one for the Node.js extension backend (`extensionConfig`) and one for the Svelte webviews (`webviewsConfig`).
- Rspack uses `builtin:swc-loader` for fast transpilation and `ForkTsCheckerWebpackPlugin` for type checking.
- Rspack automatically copies the compiled native addons (`.node` files) from `build/Release/` to `dist/` based on the host OS.

**TypeScript Configuration:**

- The project uses a composite TypeScript setup:
  - `tsconfig.json`: Base configuration with project references.
  - `tsconfig.node.json`: For the extension backend (`src/extension`) and shared code.
  - `tsconfig.app.json`: For the webview frontend (`src/webview`) and shared code.

**Linting & Formatting:**

- Use `npm run lint` to lint the codebase. ESLint uses the Flat Config format (`eslint.config.mjs`) with `@typescript-eslint` (`projectService: true`) and supports Svelte 5 runes as globals.
- Use `npm run format` to apply Prettier formatting, or `npm run check` to verify formatting.
- Use `npm run svelte:check` to run Svelte type checking against `tsconfig.app.json`.

**Native Addons & Packaging:**

- Use `npm run build:addon` to compile the C++ process monitor addons via `node-gyp`.
- Use `npm run test` to run the monitor tests.
- Use `npm run package` to package the extension via `vsce`.
