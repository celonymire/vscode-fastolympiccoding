<script lang="ts">
  import { onMount } from "svelte";

  let tooltipText = $state("");
  let tooltipOpacity = $state(0);
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let tooltipElement: HTMLDivElement | undefined = $state();

  let showTimeout: number | undefined;
  let hideTimeout: number | undefined;
  let currentTarget: HTMLElement | null = null;

  const SHOW_DELAY = 500;
  const HIDE_DELAY = 100;
  const WEBVIEW_PADDING = 20;

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
      if (x < WEBVIEW_PADDING) {
        x = WEBVIEW_PADDING;
      } else if (x + tooltipRect.width > window.innerWidth - WEBVIEW_PADDING) {
        x = window.innerWidth - tooltipRect.width - WEBVIEW_PADDING;
      }

      if (y + tooltipRect.height > window.innerHeight - WEBVIEW_PADDING) {
        y = rect.top - tooltipRect.height - WEBVIEW_PADDING;
      }

      tooltipX = x;
      tooltipY = y;
    });
  }

  function showTooltip(text: string, targetElement: HTMLElement) {
    currentTarget = targetElement;
    clearTimeout(hideTimeout);
    clearTimeout(showTimeout);

    // Always mounted; just update/animate opacity and content.
    // If already visible (or fading out), switch instantly.
    if (tooltipOpacity > 0) {
      tooltipOpacity = 1;
      tooltipText = text;
      updatePosition(targetElement);
      return;
    }

    // Set rough position for initial render state
    updatePosition(targetElement);

    showTimeout = window.setTimeout(() => {
      if (currentTarget !== targetElement) return;

      tooltipText = text;
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

  function hideTooltip() {
    currentTarget = null;
    clearTimeout(showTimeout);

    hideTimeout = window.setTimeout(() => {
      if (currentTarget === null) {
        tooltipOpacity = 0;
      }
    }, HIDE_DELAY);
  }

  function handleMouseEnter(event: MouseEvent) {
    const target = event.target ? (event.target as HTMLElement) : null;
    const tooltipElem =
      target?.nodeType === Node.ELEMENT_NODE ? target?.closest("[data-tooltip]") : null;

    if (tooltipElem instanceof HTMLElement) {
      const text = tooltipElem.getAttribute("data-tooltip");
      if (text) {
        showTooltip(text, tooltipElem);
      }
    }
  }

  function handleMouseLeave(event: MouseEvent) {
    const target = event.target ? (event.target as HTMLElement) : null;
    const tooltipElem =
      target?.nodeType === Node.ELEMENT_NODE ? target?.closest("[data-tooltip]") : null;
    if (tooltipElem instanceof HTMLElement) {
      hideTooltip();
    }
  }

  function isMouseOverTarget(mouseX: number, mouseY: number): boolean {
    if (!currentTarget) return false;
    const rect = currentTarget.getBoundingClientRect();
    return (
      mouseX >= rect.left && mouseX <= rect.right && mouseY >= rect.top && mouseY <= rect.bottom
    );
  }

  onMount(() => {
    // Reset state on mount
    tooltipText = "";
    tooltipOpacity = 0;
    tooltipX = 0;
    tooltipY = 0;
    currentTarget = null;
    clearTimeout(showTimeout);
    clearTimeout(hideTimeout);

    const mutationObserver = new MutationObserver(() => {
      // If the target element is no longer in the DOM, hide the tooltip
      if (currentTarget && !document.contains(currentTarget)) {
        hideTooltip();
      }
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Hide tooltip on window resize
    window.addEventListener("resize", hideTooltip);

    // Hide tooltip if mouse leaves target element
    const handleMouseMove = (event: MouseEvent) => {
      if (tooltipOpacity > 0 && !isMouseOverTarget(event.clientX, event.clientY)) {
        hideTooltip();
      }
    };
    document.addEventListener("mousemove", handleMouseMove);

    document.addEventListener("mouseenter", handleMouseEnter, true);
    document.addEventListener("mouseleave", handleMouseLeave, true);

    return () => {
      mutationObserver.disconnect();
      window.removeEventListener("resize", hideTooltip);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseenter", handleMouseEnter, true);
      document.removeEventListener("mouseleave", handleMouseLeave, true);
      clearTimeout(showTimeout);
      clearTimeout(hideTimeout);
    };
  });
</script>

<div
  bind:this={tooltipElement}
  class="tooltip"
  style:left="{tooltipX}px"
  style:top="{tooltipY}px"
  style:opacity={tooltipOpacity}
>
  {tooltipText}
</div>

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
