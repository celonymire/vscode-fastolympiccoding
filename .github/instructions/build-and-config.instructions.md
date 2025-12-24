---
applyTo: "package.json,rspack.config.ts,eslint.config.mjs,tsconfig*.json"
---

This repository uses npm, Rspack, TypeScript, and ESLint to build and lint the Fast Olympic Coding VS Code extension and its webviews.

When working on the build, config, or tooling files matched by this pattern:

- Use `npm install` to install dependencies. Prefer npm scripts in `package.json` over ad-hoc commands.
- During development, run `npm run watch` to start Rspack in watch mode. For production builds, use `npm run prod` to generate minified, no-sourcemap bundles.
- Rspack bundles the extension backend and webview frontends into `dist/`. Each webview has its own `index.css` stylesheet that is bundled alongside its JavaScript.
- This repo also builds an optional **Windows-only** native addon via `node-gyp`; keep the `package.json` scripts and `rspack.config.ts` copy-to-`dist/` wiring working, and ensure non-Windows builds do not hard-fail when the addon is absent.
- The Rspack configuration (`rspack.config.ts`) exports two configs: one targeting Node.js/CommonJS for the extension, and one targeting the web/ES modules for the webviews (TypeScript with Svelte). Keep this separation intact when modifying the config.
- Type-checking is handled by ForkTsCheckerWebpackPlugin, using `tsconfig.node.json` for the extension and `tsconfig.app.json` for the webviews. Keep these project files aligned with the respective code trees.
- Use `npm run typecheck` to run `svelte-check` for Svelte component type validation.
- For quality gates, use `npm run lint` (ESLint with TypeScript + Svelte rules) and `npm run format` (Prettier with `prettier-plugin-svelte`). Avoid adding overlapping or conflicting linters/formatters.
- Prefer minimal, focused config changes. Avoid introducing large new toolchains or build systems; extend the existing Rspack + npm setup instead.