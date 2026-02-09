<script lang="ts">
  import type { ClassValue, HTMLButtonAttributes } from "svelte/elements";

  interface Props extends HTMLButtonAttributes {
    text?: string;
    codicon?: string;
    class?: ClassValue;
  }

  let { text, codicon, class: extraClass, ...rest }: Props = $props();
</script>

<button type="button" class={["text-button", extraClass]} {...rest}>
  {#if codicon}
    <div class={"codicon " + codicon}></div>
  {/if}
  {#if text}
    {text}
  {/if}
</button>

<style>
  .text-button {
    box-sizing: border-box;
    display: flex;
    width: 100%;
    padding: 4px;
    border-radius: 4px;
    text-align: center;
    cursor: pointer;
    justify-content: center;
    align-items: center;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    line-height: 18px;
  }

  .text-button:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .text-button :global(.codicon) {
    margin-right: 4px;
  }
</style>
