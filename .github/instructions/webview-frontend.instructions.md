---
applyTo: "src/webview/**/*.ts,src/webview/**/*.svelte"
---

The `src/webview/**` tree contains the Svelte 5-based frontend code for the Judge and Stress webviews. These run in an isolated browser-like environment, not in the VS Code extension host.

When changing files under `src/webview/**`:

- Do not import the `vscode` module here; webview code should communicate with the extension only via `postProviderMessage()` from each view's `message.ts` file, which wraps `vscode.postMessage()` with typed contracts from `src/shared/*-messages.ts`.
- Treat the `App.svelte` components under `src/webview/judge/` and `src/webview/stress/` as entry points for each view. They receive initial state and subsequent updates exclusively through message types defined in the shared message unions via `window.addEventListener("message", ...)`.
- Codicons are the icon set used across the webviews. The backend already exposes `@vscode/codicons/dist/codicon.css`; prefer the existing `codicon-` classes instead of adding new icon libraries or custom SVG sprite sheets unless strictly necessary.
- When you need new messages or actions from the webview to the extension, first extend the shared string literal arrays and Valibot schemas in `src/shared/*-messages.ts`, then update both the extension providers and the webview components to handle the new types. Avoid magic string message names.
- Styles are co-located within each Svelte component using `<style>` blocks. Svelte automatically scopes styles to the component. Use `:global()` when you need to target elements outside the component's scope or child components.
- Use Svelte 5 runes for reactive state management:
  - Use `let value = $state(initial)` for reactive state variables.
  - Use `$derived(expression)` for computed values that depend on reactive state.
  - Use `$effect(() => { ... })` for side effects that run when dependencies change.
  - Use `$props()` to destructure component props with types.
  - Use `{#each items as item (key)}` for list rendering with keyed iterations.
  - Avoid introducing additional state libraries; follow the patterns in the Judge and Stress apps.
- The shared `AutoresizeTextarea.svelte` and `Tooltip.svelte` components are used by both webviews and live in `src/webview/`.
  - `AutoresizeTextarea` supports inline editing via the `editing` prop (bound via `bind:editing`). It emits `onpreedit` (before editing starts, e.g., to fetch full data), `onsave` (when saving changes), and `oncancel` events.
- Keep UI logic decoupled from process execution details. The webview should focus on rendering state and sending/receiving typed messages, not on spawning processes or resolving filesystem paths.
- Maintain consistency with existing components such as `AutoresizeTextarea.svelte`, `Testcase.svelte`, and `State.svelte` in terms of props, message handling, and minimal DOM manipulation.
- Keep the file layout lean (e.g., flat component files per view) and avoid introducing extra nested directories unless there's a clear benefit; mirror the existing Judge/Stress structure when adding new pieces.
- Keep changes surgical: avoid large-scale refactors or stylistic rewrites unless they are necessary for a specific task.
- Use `onMount()` from Svelte for initialization logic that should run once when the component is mounted.
- Message listeners should be set up in `onMount()` and cleaned up by returning a cleanup function.
