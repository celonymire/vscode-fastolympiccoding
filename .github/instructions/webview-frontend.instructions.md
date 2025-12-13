---
applyTo: "src/webview/**/*.ts,src/webview/**/*.tsx"
---

The `src/webview/**` tree contains the React-based frontend code for the Judge and Stress webviews. These run in an isolated browser-like environment, not in the VS Code extension host.

When changing files under `src/webview/**`:

- Do not import the `vscode` module here; webview code should communicate with the extension only via `postProviderMessage()` from each view's `message.ts` file, which wraps `vscode.postMessage()` with typed contracts from `src/shared/*-messages.ts`.
- Treat the `App.tsx` components under `src/webview/judge/` and `src/webview/stress/` as entry points for each view. They receive initial state and subsequent updates exclusively through message types defined in the shared message unions via `window.addEventListener("message", ...)`.
- Codicons are the icon set used across the webviews. The backend already exposes `@vscode/codicons/dist/codicon.css`; prefer the existing `codicon-` classes instead of adding new icon libraries or custom SVG sprite sheets unless strictly necessary.
- When you need new messages or actions from the webview to the extension, first extend the shared enums and Valibot schemas in `src/shared/*-messages.ts`, then update both the extension providers and the webview components to handle the new types. Avoid magic string message names.
- Each webview has its own `index.css` stylesheet (e.g., `src/webview/judge/index.css`, `src/webview/stress/index.css`). Import it in the webview's entry file (`index.tsx`). The CSS is bundled by Rspack alongside the webview JavaScript.
- Use `@legendapp/state` for reactive state management:
  - Wrap components with `observer()` from `@legendapp/state/react` for automatic re-rendering.
  - Access observable values with `.get()` and mutate with `.set(value)` or `.set(prev => newValue)`.
  - Use `<For each={obs$}>` for reactive list rendering; it efficiently handles additions/removals without re-rendering the entire list.
  - Use `useObservable(value)` for component-local observable state.
  - Collections like `Map` and `Set` have fine-grained reactivity; use `state$.map.get(key)` to get an observable for a specific entry.
  - Avoid introducing additional state libraries; follow the patterns in the Judge and Stress apps.
- Shared webview utilities live in `src/webview/utils.ts` (e.g., `getStatusColor`).
- Keep UI logic decoupled from process execution details. The webview should focus on rendering state and sending/receiving typed messages, not on spawning processes or resolving filesystem paths.
- Maintain consistency with existing components such as `AutoresizeTextarea`, `Testcase`, and `State` in terms of props, message handling, and minimal DOM manipulation.
- Keep the file layout lean (e.g., flat component files per view) and avoid introducing extra nested directories unless there's a clear benefit; mirror the existing Judge/Stress structure when adding new pieces.
- Keep changes surgical: avoid large-scale refactors or stylistic rewrites unless they are necessary for a specific task.
