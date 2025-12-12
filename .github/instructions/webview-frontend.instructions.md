---
applyTo: "src/webview/**/*.ts,src/webview/**/*.tsx"
---

The `src/webview/**` tree contains the React-based frontend code for the Judge and Stress webviews. These run in an isolated browser-like environment, not in the VS Code extension host.

When changing files under `src/webview/**`:

- Do not import the `vscode` module here; webview code should communicate with the extension only via the typed message contracts defined in `src/shared/*-messages.ts`.
- Treat the `App.tsx` components under `src/webview/judge/` and `src/webview/stress/` as entry points for each view. They receive initial state and subsequent updates exclusively through message types defined in the shared message unions.
- When you need new messages or actions from the webview to the extension, first extend the shared enums and message interfaces in `src/shared/*-messages.ts`, then update both the extension providers and the webview components to handle the new types. Avoid magic string message names.
- Assume styles are provided by an external CSS file built from `src/styles/global.css` into `dist/styles.css` via Tailwind CLI. Do not import CSS directly into TypeScript/TSX; the extension side (`BaseViewProvider`) injects the stylesheet as a `<link>` in the webview HTML.
- Use `@legendapp/state` for reactive state management:
  - Wrap components with `observer()` from `@legendapp/state/react` for automatic re-rendering.
  - Access observable values with `.get()` and mutate with `.set(value)` or `.set(prev => newValue)`.
  - Use `<Memo>{() => obs$.get()}</Memo>` for direct DOM updates that bypass VDOM diffing (ideal for streaming stdout/stderr).
  - Use `useObservable(value)` for component-local observable state.
  - Collections like `Map` and `Set` have fine-grained reactivity; use `state$.map.get(key)` to get an observable for a specific entry.
  - Avoid introducing additional state libraries; follow the patterns in the Judge and Stress apps.
- Keep UI logic decoupled from process execution details. The webview should focus on rendering state and sending/receiving typed messages, not on spawning processes or resolving filesystem paths.
- Maintain consistency with existing components such as `AutoresizeTextarea`, `Testcase`, and `State` in terms of props, message handling, and minimal DOM manipulation.
- Keep changes surgical: avoid large-scale refactors or stylistic rewrites unless they are necessary for a specific task.
