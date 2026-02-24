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
- **Testcase.svelte**: Stdio textareas (stdin, stdout, stderr, acceptedStdout, interactorSecret)

Rendering pattern:

```svelte
{#each testcases as testcase, index (testcase.uuid)}
  <div class="testcase-item">
    <TestcaseToolbar {testcase} onprerun={() => handlePrerun(testcase.uuid)} />
    {#if testcase.status === "COMPILING" || testcase.skipped}
      <div class="half-opacity">
        <Testcase bind:testcase={testcases[index]} bind:this={testcaseRefs[testcase.uuid]} />
      </div>
    {:else}
      <Testcase bind:testcase={testcases[index]} bind:this={testcaseRefs[testcase.uuid]} />
    {/if}
  </div>
{/each}
```

### Stress View (`src/webview/stress/`)

- **App.svelte**: Entry point, message handling, state list rendering
- **StateToolbar.svelte**: Status badges, action buttons (add, open file, toggle interactive mode)
- **State.svelte**: Stdio textareas for Generator/Solution/Judge

### Shared Components (`src/webview/`)

- **AutoresizeTextarea.svelte**: Resizable textarea with ANSI color support
- **Tooltip.svelte**: Global tooltip singleton
- **Button.svelte**: Standard button component
- **ButtonDropdown.svelte**: Composite component providing a main button alongside a dropdown menu

## AutoresizeTextarea

Key props:

- `value`: Bound text value
- `readonly`: Disable editing
- `editing`: Bindable, tracks edit mode
- `hiddenOnEmpty`: Hide when empty
- `variant`: `"default"` | `"stderr"` | `"accepted"` | `"active"` | `"interactor-secret"`
- `placeholder`: Text to display when empty
- `ctrlEnterNewline`: Boolean to toggle specific Ctrl+Enter newline behavior
- `actions`: A Svelte `Snippet` prop for injecting custom action buttons into the textarea overlay

Callbacks:

- `onpreedit`: Called before entering edit mode (fetch full data from extension)
- `onsave`: Called when saving changes
- `oncancel`: Called when canceling edit
- `onexpand`: Called when the user clicks the expand icon (to view full stdio)
- `oncopy`: Called when the user clicks the copy icon
- `onkeyup`: Keyboard event handler

Pattern for fetching full data on edit and handling actions:

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
  onexpand={() => handleExpand("STDIN")}
  oncopy={() => handleCopy("STDIN")}
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
