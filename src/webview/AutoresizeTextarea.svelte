<script lang="ts">
  type Variant = "default" | "stderr" | "accepted" | "active" | "interactor-secret";

  interface Props {
    value?: string;
    readonly?: boolean;
    hiddenOnEmpty?: boolean;
    placeholder?: string;
    onkeyup?: (event: KeyboardEvent) => void;
    onexpand?: () => void;
    onpreedit?: () => void;
    onsave?: () => void;
    variant?: Variant;
  }

  let {
    value = $bindable(""),
    readonly = false,
    hiddenOnEmpty = false,
    placeholder = "",
    onkeyup,
    onexpand,
    onpreedit,
    onsave,
    variant = "default",
  }: Props = $props();

  let textarea: HTMLTextAreaElement | undefined = $state();
  let containerElement: HTMLDivElement | undefined = $state();
  let isHovered = $state();
  let isEditing = $state(false);
  let initialCursorPosition = $state(0);

  function handleKeyUp(event: KeyboardEvent) {
    onkeyup?.(event);
  }

  function handleExpand() {
    onexpand?.();
  }

  function handleTextareaTransition(event?: MouseEvent) {
    if (!readonly) {
      if (event instanceof MouseEvent && value) {
        // caretPositionFromPoint is a VERY new function (December 2025!) so fallback to VSCode's
        // older caretRangeFromPoint (which is deprecated but still widely supported)
        if (typeof (document as any).caretPositionFromPoint === "function") {
          const position = (document as any).caretPositionFromPoint(event.clientX, event.clientY);
          initialCursorPosition = position?.offset ?? value.length;
        } else if (typeof document.caretRangeFromPoint === "function") {
          const range = document.caretRangeFromPoint(event.clientX, event.clientY);
          initialCursorPosition = range?.startOffset ?? value.length;
        } else {
          initialCursorPosition = value.length;
        }
      } else {
        initialCursorPosition = value?.length ?? 0;
      }
      isEditing = true;
      onpreedit?.();
    }
  }

  $effect(() => {
    if (isEditing && textarea && document.activeElement !== textarea) {
      textarea.focus();
      const pos = Math.min(initialCursorPosition, value?.length ?? 0);
      textarea.setSelectionRange(pos, pos);
    }
  });

  $effect(() => {
    if (hiddenOnEmpty && (value === "" || value === "\n")) {
      return;
    }

    if (containerElement) {
      const handleMouseEnter = () => (isHovered = true);
      const handleMouseLeave = () => (isHovered = false);

      containerElement.addEventListener("mouseenter", handleMouseEnter);
      containerElement.addEventListener("mouseleave", handleMouseLeave);

      return () => {
        containerElement?.removeEventListener("mouseenter", handleMouseEnter);
        containerElement?.removeEventListener("mouseleave", handleMouseLeave);
      };
    }
  });

  const hasValue = $derived(!!value && value !== "\n");
  const hidden = $derived(hiddenOnEmpty && !hasValue);
</script>

{#if !hidden}
  <div bind:this={containerElement} class="container">
    {#if readonly || !isEditing}
      <div
        class="content readonly"
        class:content--has-value={hasValue}
        class:content--editable={!readonly}
        data-variant={variant}
        role="button"
        tabindex="0"
        onclick={handleTextareaTransition}
        onkeyup={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleTextareaTransition();
          }
        }}
      >
        {hasValue ? value : placeholder}
      </div>
    {:else}
      <textarea
        bind:this={textarea}
        rows={1}
        class="content"
        data-variant={variant}
        {placeholder}
        bind:value
        onkeyup={handleKeyUp}
      ></textarea>
    {/if}
    {#if !isEditing && onexpand}
      <button
        type="button"
        data-tooltip="Expand"
        aria-label="Expand"
        class="action-button codicon codicon-screen-full"
        class:action-button--visible={isHovered}
        onclick={handleExpand}
      ></button>
    {/if}
    {#if isEditing}
      <button
        type="button"
        data-tooltip="Save"
        aria-label="Save"
        class="action-button codicon codicon-save action-button--visible"
        onclick={() => {
          isEditing = false;
          onsave?.();
        }}
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
    padding: 4px;
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

  textarea.content[data-variant="stderr"] {
    animation: pulse-stderr 1s infinite ease-in-out;
  }

  .content[data-variant="accepted"] {
    border-color: var(--vscode-terminal-ansiGreen);
  }

  textarea.content[data-variant="accepted"] {
    animation: pulse-accepted 1s infinite ease-in-out;
  }

  .content[data-variant="active"] {
    border-color: var(--vscode-inputOption-activeBorder);
  }

  textarea.content[data-variant="active"] {
    animation: pulse-active 1s infinite ease-in-out;
  }

  .content[data-variant="interactor-secret"] {
    border-color: var(--vscode-terminal-ansiMagenta);
  }

  textarea.content[data-variant="interactor-secret"] {
    animation: pulse-interactor-secret 1s infinite ease-in-out;
  }

  @keyframes pulse-stderr {
    0%,
    100% {
      border-color: var(--vscode-terminal-ansiRed);
      box-shadow: 0 0 0px transparent;
    }
    50% {
      border-color: color-mix(in srgb, var(--vscode-terminal-ansiRed), white 40%);
      box-shadow: 0 0 4px var(--vscode-terminal-ansiRed);
    }
  }

  @keyframes pulse-accepted {
    0%,
    100% {
      border-color: var(--vscode-terminal-ansiGreen);
      box-shadow: 0 0 0px transparent;
    }
    50% {
      border-color: color-mix(in srgb, var(--vscode-terminal-ansiGreen), white 40%);
      box-shadow: 0 0 4px var(--vscode-terminal-ansiGreen);
    }
  }

  @keyframes pulse-interactor-secret {
    0%,
    100% {
      border-color: var(--vscode-terminal-ansiMagenta);
      box-shadow: 0 0 0px transparent;
    }
    50% {
      border-color: color-mix(in srgb, var(--vscode-terminal-ansiMagenta), white 40%);
      box-shadow: 0 0 4px var(--vscode-terminal-ansiMagenta);
    }
  }

  @keyframes pulse-active {
    0%,
    100% {
      border-color: var(--vscode-inputOption-activeBorder);
      box-shadow: 0 0 0px transparent;
    }
    50% {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 4px var(--vscode-focusBorder);
    }
  }

  @keyframes pulse-default {
    0%,
    100% {
      border-color: var(--vscode-editorWidget-border);
      box-shadow: 0 0 0px transparent;
    }
    50% {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 4px var(--vscode-focusBorder);
    }
  }

  .content.readonly {
    overflow-x: auto;
    color: var(--vscode-input-placeholderForeground);
  }

  .content.readonly.content--has-value {
    color: var(--vscode-foreground);
  }

  .content.readonly.content--editable {
    cursor: text;
  }

  textarea.content {
    field-sizing: content;
    min-height: 1lh;
    max-height: calc(30 * 1lh);
    height: auto;
    resize: none;
    overflow-y: auto;
    outline: none;
    animation: pulse-default 1s infinite ease-in-out;
  }

  .action-button {
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

  .action-button--visible {
    opacity: 1;
    pointer-events: auto;
  }
</style>
