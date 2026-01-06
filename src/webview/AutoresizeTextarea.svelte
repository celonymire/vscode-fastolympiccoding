<script lang="ts">
  type Variant = "default" | "stderr" | "accepted" | "active" | "interactor-secret";

  interface Props {
    value?: string;
    readonly?: boolean;
    hiddenOnEmpty?: boolean;
    placeholder?: string;
    editing?: boolean;
    onkeyup?: (event: KeyboardEvent) => void;
    onexpand?: () => void;
    onpreedit?: () => void;
    onsave?: () => void;
    oncancel?: () => void;
    variant?: Variant;
  }

  let {
    value = $bindable(""),
    readonly = false,
    hiddenOnEmpty = false,
    placeholder = "",
    editing = $bindable(false),
    onkeyup,
    onexpand,
    onpreedit,
    onsave,
    oncancel,
    variant = "default",
  }: Props = $props();

  let textarea: HTMLTextAreaElement | undefined = $state();
  let containerElement: HTMLDivElement | undefined = $state();
  let isHovered = $state();
  let initialCursorPosition = $state(0);

  function handleKeyUp(event: KeyboardEvent) {
    onkeyup?.(event);
  }

  function handleExpand() {
    onexpand?.();
  }

  function handleBlur(event: FocusEvent) {
    const relatedTarget = event.relatedTarget as HTMLElement;
    if (relatedTarget?.closest(".action-buttons")) {
      return;
    }

    if (editing) {
      editing = false;
      onsave?.();
    }
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
      editing = true;
      onpreedit?.();
    }
  }

  $effect(() => {
    if (editing && textarea && document.activeElement !== textarea) {
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
    {#if readonly || !editing}
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
        class:editing
        data-variant={variant}
        {placeholder}
        bind:value
        onkeyup={handleKeyUp}
        onblur={handleBlur}
      ></textarea>
    {/if}
    {#if !editing && onexpand}
      <div class="action-buttons">
        <button
          type="button"
          data-tooltip="Expand"
          aria-label="Expand"
          class="action-button codicon codicon-screen-full"
          class:action-button--visible={isHovered}
          onclick={handleExpand}
        ></button>
      </div>
    {/if}
    {#if editing}
      <div class="action-buttons">
        {#if oncancel}
          <button
            type="button"
            data-tooltip="Cancel"
            aria-label="Cancel"
            class="action-button codicon codicon-close action-button--visible"
            onclick={() => {
              editing = false;
              oncancel?.();
            }}
          ></button>
        {/if}
        {#if onsave}
          <button
            type="button"
            data-tooltip="Save"
            aria-label="Save"
            class="action-button codicon codicon-save action-button--visible"
            onclick={() => {
              editing = false;
              onsave?.();
            }}
          ></button>
        {/if}
      </div>
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
    display: block;
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

  .content[data-variant="interactor-secret"] {
    border-color: var(--vscode-terminal-ansiMagenta);
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
  }

  textarea.content.editing {
    border-color: var(--vscode-inputOption-activeBorder);
  }

  .action-button {
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

  .action-buttons {
    position: absolute;
    top: 2px;
    right: 2px;
    display: flex;
    gap: 2px;
  }
</style>
