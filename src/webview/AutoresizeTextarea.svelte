<script lang="ts">
  import { tick } from "svelte";

  type Variant = "default" | "stderr" | "accepted" | "active";

  interface Props {
    value: string;
    readonly?: boolean;
    hiddenOnEmpty?: boolean;
    placeholder?: string;
    onchange?: (value: string) => void;
    onkeyup?: (event: KeyboardEvent) => void;
    onexpand?: () => void;
    variant?: Variant;
  }

  let {
    value = "",
    readonly = false,
    hiddenOnEmpty = false,
    placeholder = "",
    onchange,
    onkeyup,
    onexpand,
    variant = "default",
  }: Props = $props();

  let textarea: HTMLTextAreaElement | undefined = $state();
  let isHovered = $state();

  // Auto-resize textarea when value changes
  $effect(() => {
    // Access value to track it
    void value;
    tick().then(() => {
      if (textarea) {
        textarea.style.height = "inherit";
        textarea.style.height = `${textarea.scrollHeight}px`;
      }
    });
  });

  function handleInput(event: Event) {
    const target = event.target as HTMLTextAreaElement;
    onchange?.(target.value);
  }

  function handleKeyUp(event: KeyboardEvent) {
    onkeyup?.(event);
  }

  function handleExpand() {
    onexpand?.();
  }

  $effect(() => {
    if (hiddenOnEmpty && (value === "" || value === "\n")) {
      return;
    }
  });

  const hidden = $derived(hiddenOnEmpty && (value === "" || value === "\n"));
  const hasValue = $derived(!!value && value !== "\n");
</script>

{#if !hidden}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="container"
    onmouseenter={() => (isHovered = true)}
    onmouseleave={() => (isHovered = false)}
  >
    {#if readonly}
      <div class="content readonly" class:content--has-value={hasValue} data-variant={variant}>
        {value || placeholder}
      </div>
    {:else}
      <textarea
        bind:this={textarea}
        rows={1}
        class="content"
        data-variant={variant}
        {placeholder}
        {value}
        oninput={handleInput}
        onkeyup={handleKeyUp}
      ></textarea>
    {/if}
    {#if onexpand}
      <button
        type="button"
        aria-label="Expand"
        class="expand-button codicon codicon-screen-full"
        class:expand-button--visible={isHovered}
        onclick={handleExpand}
      ></button>
    {/if}
  </div>
{/if}

<style>
  .container {
    position: relative;
  }

  .content {
    white-space: pre-wrap;
    border: 1px solid var(--vscode-editorWidget-border);
    border-radius: 2px;
    box-sizing: border-box;
    background: var(--vscode-editor-background);
    width: 100%;
    margin-bottom: 3px;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    color: var(--vscode-foreground);
  }

  /* Variant-specific border colors */
  .content[data-variant="stderr"] {
    border-color: var(--vscode-terminal-ansiRed);
  }

  .content[data-variant="accepted"] {
    border-color: var(--vscode-terminal-ansiGreen);
  }

  .content[data-variant="active"] {
    border-color: var(--vscode-inputOption-activeBorder);
  }

  .content.readonly {
    padding: 4px;
    overflow-x: auto;
    color: var(--vscode-input-placeholderForeground);
  }

  .content.readonly.content--has-value {
    color: var(--vscode-foreground);
  }

  textarea.content {
    resize: none;
    overflow-y: hidden;
    outline: none;
  }

  .expand-button {
    position: absolute;
    top: 2px;
    right: 2px;
    border: none;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: opacity 120ms ease-in-out;
    opacity: 0;
    pointer-events: none;
  }

  .expand-button--visible {
    opacity: 1;
    pointer-events: auto;
  }
</style>
