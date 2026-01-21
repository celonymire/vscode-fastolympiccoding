---
applyTo: "src/webview/**/*.ts,src/webview/**/*.svelte"
---

## Environment

Webviews run in an isolated browser context, not the VS Code extension host. Do not import `vscode` module directly.

## Messaging

Communicate with the extension via typed `postProviderMessage()` from each view's `message.ts`:

```typescript
// src/webview/judge/message.ts
import type { ProviderMessage } from "../../shared/judge-messages";
const vscode = acquireVsCodeApi();
export const postProviderMessage = (msg: ProviderMessage) => vscode.postMessage(msg);
```

Receive messages in `App.svelte` via `window.addEventListener("message", ...)` in `onMount()`.

## Component Structure

### Judge View (`src/webview/judge/`)

- **App.svelte**: Entry point, message handling, testcase list rendering
- **TestcaseToolbar.svelte**: Status badges, action buttons (run, stop, debug, delete)
- **Testcase.svelte**: Stdio textareas (stdin, stdout, stderr, acceptedStdout)

Rendering pattern:

```svelte
{#each testcases as testcase (testcase.uuid)}
  <TestcaseToolbar {testcase} onprerun={() => handlePrerun(testcase.uuid)} />
  <Testcase {testcase} bind:this={testcaseRefs[testcase.uuid]} />
{/each}
```

### Stress View (`src/webview/stress/`)

- **App.svelte**: Entry point, message handling, state list rendering
- **StateToolbar.svelte**: Status badges, action buttons (add, open file)
- **State.svelte**: Stdio textareas for Generator/Solution/Judge

### Shared Components (`src/webview/`)

- **AutoresizeTextarea.svelte**: Resizable textarea with ANSI color support
- **Tooltip.svelte**: Global tooltip singleton

## AutoresizeTextarea

Key props:

- `value`: Bound text value
- `readonly`: Disable editing
- `editing`: Bindable, tracks edit mode
- `hiddenOnEmpty`: Hide when empty
- `variant`: `"default"` | `"stderr"` | `"accepted"` | `"active"` | `"interactor-secret"`

Editing callbacks:

- `onpreedit`: Called before entering edit mode (fetch full data from extension)
- `onsave`: Called when saving changes
- `oncancel`: Called when canceling edit

Pattern for fetching full data on edit:

```svelte
<AutoresizeTextarea
  bind:value={testcase.stdin}
  bind:editing={stdinEditing}
  onpreedit={() => {
    postProviderMessage({ type: "REQUEST_FULL_DATA", uuid: testcase.uuid, stdio: "STDIN" });
  }}
  onsave={handleSaveStdin}
  oncancel={() => {
    postProviderMessage({ type: "REQUEST_TRIMMED_DATA", uuid: testcase.uuid, stdio: "STDIN" });
  }}
/>
```

## Tooltip

Singleton tooltip component that reads `data-tooltip` attributes:

```svelte
<button data-tooltip="Run Testcase" onclick={handleRun}>
  <div class="codicon codicon-run-below"></div>
</button>
<Tooltip />
<!-- Once per component using tooltips -->
```

## Icons

Use Codicons via CSS classes. The stylesheet is loaded by BaseViewProvider:

```svelte
<div class="codicon codicon-play"></div>
<div class="codicon codicon-loading codicon-modifier-spin"></div>
```

## Svelte 5 Patterns

- `let value = $state(initial)`: Reactive state
- `const derived = $derived(expression)`: Computed values
- `$effect(() => { ... })`: Side effects
- `let { prop }: Props = $props()`: Component props
- `{#each items as item (key)}`: Keyed iteration
