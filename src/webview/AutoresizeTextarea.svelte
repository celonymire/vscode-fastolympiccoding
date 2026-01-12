<script lang="ts">
  import type { Snippet } from "svelte";

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
    actions?: Snippet;
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
    actions,
  }: Props = $props();

  let textarea: HTMLTextAreaElement | undefined = $state();
  let containerElement: HTMLDivElement | undefined = $state();
  let actionButtonsElement: HTMLDivElement | undefined = $state();
  let isHovered = $state();
  let initialCursorPosition = $state(0);
  let cursorOverlapsActions = $state(false);
  let showExpandButton = $state(false);
  let showEditButtons = $state(false);

  let canvasContext: CanvasRenderingContext2D | null = null;

  function checkCursorOverlap() {
    if (!textarea || !actionButtonsElement) return;

    const style = window.getComputedStyle(textarea);
    const lh = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;

    // Get cursor position
    const { selectionStart, value, scrollTop, scrollLeft, clientWidth } = textarea;

    // Current line info
    const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
    const lineText = value.substring(lineStart, selectionStart); // Text up to cursor
    const lineIndex = value.substring(0, lineStart).split("\n").length - 1;

    // Coordinates relative to textarea content area (inside padding)
    const paddingTop = parseFloat(style.paddingTop);
    const paddingLeft = parseFloat(style.paddingLeft);

    const cursorY = paddingTop + lineIndex * lh - scrollTop;

    // Measure X
    if (!canvasContext) {
      const canvas = document.createElement("canvas");
      canvasContext = canvas.getContext("2d");
    }
    if (canvasContext) {
      canvasContext.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const textWidth = canvasContext.measureText(lineText).width;
      const cursorX = paddingLeft + textWidth - scrollLeft;

      // Buttons rect
      const { offsetWidth: btnW, offsetHeight: btnH } = actionButtonsElement;

      // Icons Left = clientWidth - 2 (right offset) - btnW.
      // 5px buffer
      const iconsLeft = clientWidth - 2 - btnW - 5;
      const iconsBottom = 2 + btnH;

      const isOverlappingX = cursorX > iconsLeft;
      const isOverlappingY = cursorY < iconsBottom && cursorY + lh > 0;

      cursorOverlapsActions = isOverlappingX && isOverlappingY;
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.ctrlKey && event.key === "Enter") {
      event.preventDefault();
      if (editing) {
        editing = false;
        onsave?.();
      }
    }
  }

  function handleKeyUp(event: KeyboardEvent) {
    onkeyup?.(event);
    checkCursorOverlap();
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
      const handleMouseEnter = () => {
        isHovered = true;
        showExpandButton = !editing && !!onexpand;
      };
      const handleMouseLeave = () => {
        isHovered = false;
        setTimeout(() => {
          if (!isHovered) showExpandButton = false;
        }, 200);
      };

      containerElement.addEventListener("mouseenter", handleMouseEnter);
      containerElement.addEventListener("mouseleave", handleMouseLeave);

      return () => {
        containerElement?.removeEventListener("mouseenter", handleMouseEnter);
        containerElement?.removeEventListener("mouseleave", handleMouseLeave);
      };
    }
  });

  $effect(() => {
    if (editing) {
      showEditButtons = true;
      showExpandButton = false;
    } else {
      setTimeout(() => {
        if (!editing) showEditButtons = false;
      }, 200);
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
        onkeydown={handleKeyDown}
        onkeyup={handleKeyUp}
        onblur={handleBlur}
        onpointerup={checkCursorOverlap}
        onscroll={checkCursorOverlap}
      ></textarea>
    {/if}
    {#if !editing}
      <div class="action-buttons" class:has-buttons={showExpandButton || actions}>
        {#if showExpandButton && onexpand}
          <button
            type="button"
            data-tooltip="Expand"
            aria-label="Expand"
            class="action-button codicon codicon-screen-full"
            onclick={handleExpand}
          ></button>
        {/if}
        {@render actions?.()}
      </div>
    {/if}
    {#if showEditButtons}
      <div
        class="action-buttons has-buttons"
        bind:this={actionButtonsElement}
        class:overlapped={cursorOverlapsActions}
      >
        {#if oncancel}
          <button
            type="button"
            data-tooltip="Cancel"
            aria-label="Cancel"
            class="action-button codicon codicon-close"
            onclick={() => {
              editing = false;
              oncancel?.();
            }}
          ></button>
        {/if}
        {#if onsave}
          <button
            type="button"
            data-tooltip="Save (Ctrl+Enter)"
            aria-label="Save"
            class="action-button codicon codicon-save"
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
    white-space: pre;
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
    overflow: auto;
    outline: none;
  }

  textarea.content.editing {
    border-color: var(--vscode-inputOption-activeBorder);
  }

  .action-buttons :global(.action-button) {
    border: none;
    background: transparent;
    padding: 2px;
    color: var(--vscode-foreground);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .action-buttons {
    position: absolute;
    padding: 2px;
    top: 1px;
    right: 1px;
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 200ms ease-in-out;
    pointer-events: none;
  }

  .action-buttons.has-buttons {
    opacity: 1;
    pointer-events: auto;
    backdrop-filter: blur(2px);
  }

  .action-buttons.overlapped {
    opacity: 0;
    pointer-events: none;
  }

  .action-buttons.overlapped:hover,
  .action-buttons:focus-within {
    opacity: 1;
    pointer-events: auto;
  }

  .action-buttons.overlapped {
    opacity: 0;
    pointer-events: none;
  }

  .action-buttons.overlapped:hover,
  .action-buttons:focus-within {
    opacity: 1;
    pointer-events: auto;
  }
</style>
