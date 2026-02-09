<script lang="ts">
  import type { ClassValue, HTMLButtonAttributes } from "svelte/elements";

  import Button from "./Button.svelte";
  import { onMount } from "svelte";

  interface DropdownItem {
    text: string;
    onclick: (event: Event) => void;
  }

  interface Props extends HTMLButtonAttributes {
    text?: string;
    codicon?: string;
    class?: ClassValue;
    onclick?: (event: Event) => void;
    options: DropdownItem[];
  }

  let { text, codicon, class: extraClass, onclick, options, ...rest }: Props = $props();
  let showDropdownMenu = $state(false);

  onMount(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const wrapper = document.querySelector(".dropdown-button");
      const dropdown = document.querySelector(".dropdown-menu");

      if (
        showDropdownMenu &&
        wrapper &&
        dropdown &&
        !wrapper.contains(target) &&
        !dropdown.contains(target)
      ) {
        showDropdownMenu = false;
      }
    };

    document.addEventListener("click", handleClickOutside);
    return () => {
      document.removeEventListener("click", handleClickOutside);
    };
  });
</script>

<div class="dropdown-button">
  <Button
    {text}
    {codicon}
    class={extraClass}
    onclick={(event: Event) => {
      onclick?.(event);
      showDropdownMenu = false;
    }}
    {...rest}
  />
  <div class="dropdown-separator"></div>
  <Button
    class="dropdown-icon"
    codicon="codicon-chevron-down"
    onclick={() => (showDropdownMenu = !showDropdownMenu)}
  />
</div>
{#if showDropdownMenu}
  <div class="dropdown-menu">
    {#each options as option (option.text)}
      <button
        type="button"
        class="dropdown-item"
        onclick={(event: Event) => {
          option.onclick(event);
          showDropdownMenu = false;
        }}>{option.text}</button
      >
    {/each}
  </div>
{/if}

<style>
  .dropdown-button {
    display: flex;
    margin-top: 8px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-radius: 4px;
  }

  .dropdown-button > :global(.text-button) {
    border: none;
  }

  .dropdown-separator {
    width: 1px;
    height: auto;
    margin: 4px 0;
    background-color: var(--vscode-button-separator);
  }

  :global(.text-button.dropdown-icon) {
    width: auto;
    padding-left: 4px;
    padding-right: 0;
  }

  .dropdown-menu {
    width: fit-content;
    margin-left: auto;
    background: var(--vscode-menu-background);
    border: 1px solid var(--vscode-menu-border);
    border-radius: 6px;
    box-shadow: 0 2px 8px var(--vscode-menu-shadow);
    padding: 3px;
  }

  .dropdown-item {
    display: block;
    width: 100%;
    padding: 6px 24px;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--vscode-menu-foreground);
    cursor: pointer;
  }

  .dropdown-item:hover {
    background: var(--vscode-menu-selectionBackground);
    color: var(--vscode-menu-selectionForeground);
  }
</style>
