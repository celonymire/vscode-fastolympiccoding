---
applyTo: "package.json,rspack.config.ts,eslint.config.ts,tailwind.config.ts,tsconfig*.json"
---

This repository uses Bun, Rspack, Tailwind CSS, TypeScript, and ESLint to build and lint the Fast Olympic Coding VS Code extension and its webviews.

When working on the build, config, or tooling files matched by this pattern:

- Use `bun install` to install dependencies. Prefer Bun scripts in `package.json` over ad-hoc commands.
- During development, run `bun run watch` to start Rspack and the Tailwind CLI in watch mode. For production builds, use `bun run prod` to generate minified, no-sourcemap bundles.
- The build is two-stage:
  - `build:css`: Tailwind CLI reads from `src/styles/global.css` and writes `dist/styles.css`.
  - `build:js`: Rspack bundles the extension backend and webview frontends into `dist/`.
- The Rspack configuration (`rspack.config.ts`) exports two configs: one targeting Node.js/CommonJS for the extension, and one targeting the web/ES modules for the webviews (TypeScript/TSX with Preact). Keep this separation intact when modifying the config.
- Type-checking is handled by ForkTsCheckerWebpackPlugin, using `tsconfig.node.json` for the extension and `tsconfig.app.json` for the webviews. Keep these project files aligned with the respective code trees.
- For quality gates, use `bun run lint` (ESLint with TypeScript + Preact rules) and `bun run format` (Prettier). Avoid adding overlapping or conflicting linters/formatters.
- Prefer minimal, focused config changes. Avoid introducing large new toolchains or build systems; extend the existing Rspack + Tailwind + Bun setup instead.
