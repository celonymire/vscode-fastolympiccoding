<script lang="ts">
  import { onMount } from "svelte";

  let tooltipText = $state("");
  let tooltipVisible = $state(false);
  let tooltipOpacity = $state(0);
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let tooltipElement: HTMLDivElement | undefined = $state();

  let showTimeout: number | undefined;
  let hideTimeout: number | undefined;
  let currentTarget: HTMLElement | null = null;

  const SHOW_DELAY = 500;
  const HIDE_DELAY = 100;

  function updatePosition(targetElement: HTMLElement) {
    const rect = targetElement.getBoundingClientRect();

    // Set rough center position immediately
    let x = rect.left + rect.width / 2;
    let y = rect.bottom + 8;
    tooltipX = x;
    tooltipY = y;

    // Fine-tune position after render
    requestAnimationFrame(() => {
      if (!tooltipElement) return;

      const tooltipRect = tooltipElement.getBoundingClientRect();

      // Center horizontally
      x = rect.left + rect.width / 2 - tooltipRect.width / 2;
      y = rect.bottom + 8;

      // Screen bounds checks
      if (x < 8) {
        x = 8;
      } else if (x + tooltipRect.width > window.innerWidth - 8) {
        x = window.innerWidth - tooltipRect.width - 8;
      }

      if (y + tooltipRect.height > window.innerHeight - 8) {
        y = rect.top - tooltipRect.height - 8;
      }

      tooltipX = x;
      tooltipY = y;
    });
  }

  function showTooltip(text: string, targetElement: HTMLElement) {
    currentTarget = targetElement;
    clearTimeout(hideTimeout);
    clearTimeout(showTimeout);

    if (tooltipVisible) {
      // If already visible (or fading out), switch instantly
      tooltipOpacity = 1;
      tooltipText = text;
      updatePosition(targetElement);
    } else {
      // Set rough position for initial render state
      updatePosition(targetElement);

      showTimeout = window.setTimeout(() => {
        if (currentTarget !== targetElement) return;

        tooltipText = text;
        tooltipVisible = true;
        tooltipOpacity = 0;
        updatePosition(targetElement);

        // Ensure browser renders initial state (opacity 0) before transitioning
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            tooltipOpacity = 1;
          });
        });
      }, SHOW_DELAY);
    }
  }

  function hideTooltip() {
    currentTarget = null;
    clearTimeout(showTimeout);

    hideTimeout = window.setTimeout(() => {
      if (currentTarget === null) {
        tooltipOpacity = 0;
      }
    }, HIDE_DELAY);
  }

  function handleTransitionEnd() {
    if (tooltipOpacity === 0) {
      tooltipVisible = false;
    }
  }

  function handleMouseEnter(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const tooltipAttr = target.closest("[data-tooltip]");

    if (tooltipAttr instanceof HTMLElement) {
      const text = tooltipAttr.getAttribute("data-tooltip");
      if (text) {
        showTooltip(text, tooltipAttr);
      }
    }
  }

  function handleMouseLeave(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("[data-tooltip]")) {
      hideTooltip();
    }
  }

  onMount(() => {
    document.addEventListener("mouseenter", handleMouseEnter, true);
    document.addEventListener("mouseleave", handleMouseLeave, true);

    return () => {
      document.removeEventListener("mouseenter", handleMouseEnter, true);
      document.removeEventListener("mouseleave", handleMouseLeave, true);
      clearTimeout(showTimeout);
      clearTimeout(hideTimeout);
    };
  });
</script>

{#if tooltipVisible && tooltipText}
  <div
    bind:this={tooltipElement}
    class="tooltip"
    style:left="{tooltipX}px"
    style:top="{tooltipY}px"
    style:opacity={tooltipOpacity}
    ontransitionend={handleTransitionEnd}
  >
    {tooltipText}
  </div>
{/if}

<style>
  .tooltip {
    position: fixed;
    z-index: 10000;
    background-color: var(--vscode-editorHoverWidget-background);
    color: var(--vscode-editorHoverWidget-foreground);
    border: 1px solid var(--vscode-editorHoverWidget-border);
    padding: 4px 8px;
    border-radius: 3px;
    font-size: 12px;
    line-height: 16px;
    white-space: nowrap;
    pointer-events: none;
    box-shadow: 0 2px 4px var(--vscode-widget-shadow);
    transition: opacity 100ms ease-out;
  }
</style>
