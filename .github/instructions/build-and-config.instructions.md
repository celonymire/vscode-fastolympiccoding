---
applyTo: "package.json,rspack.config.ts,eslint.config.mjs,tsconfig*.json"
---

This repository uses npm, Rspack, TypeScript, and ESLint to build and lint the Fast Olympic Coding VS Code extension and its webviews.

When working on the build, config, or tooling files matched by this pattern:

- Use `npm install` to install dependencies. Prefer npm scripts in `package.json` over ad-hoc commands.
- Builds are driven by **Rspack mode** (not `NODE_ENV`):
  - `npm run build` runs `rspack build --mode development`
  - `npm run watch` runs `rspack build --watch --mode development`
  - `npm run prod` runs `rspack build --mode production`
- Use `npm run lint` to lint the codebase.
- Use `npm run format` to apply Prettier formatting.
- Use `npm run typecheck` to run Svelte type checking.
