<script lang="ts">
  import type { Status } from "../../shared/enums";
  import type { StateId } from "../../shared/stress-messages";
  import Tooltip from "../Tooltip.svelte";

  interface Props {
    id: StateId;
    status: Status;
    interactiveMode: boolean;
    shown: boolean;
    onAdd: (id: StateId) => void;
    onOpen: (id: StateId) => void;
    onToggleVisibility: (id: StateId) => void;
    onToggleInteractive: () => void;
  }

  let {
    id,
    status,
    interactiveMode,
    shown,
    onAdd,
    onOpen,
    onToggleVisibility,
    onToggleInteractive,
  }: Props = $props();

  function handleAdd() {
    onAdd(id);
  }

  function handleOpen() {
    onOpen(id);
  }

  function handleToggleVisibility() {
    onToggleVisibility(id);
  }

  function handleToggleInteractive() {
    onToggleInteractive();
  }

  // Derived value for whether details should be shown
  const showDetails = $derived(shown);
</script>

{#if status === "COMPILING"}
  <div class="state-toolbar">
    <div class="state-toolbar-left">
      <div class="state-badge state-status" data-status="NA">
        <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
          <div class="codicon codicon-bolded codicon-file-code"></div>
        </div>
        <p class="state-badge-text state-badge-text-id">{id}</p>
      </div>
      <div class="state-badge state-status" data-status={interactiveMode ? "CE" : "NA"}>
        <button
          class="state-toolbar-icon state-toolbar-icon-exclude-highlight"
          data-tooltip={interactiveMode ? "Make Non-Interactive" : "Make Interactive"}
          aria-label={interactiveMode ? "Make Non-Interactive" : "Make Interactive"}
          onclick={handleToggleInteractive}
        >
          <div class="codicon codicon-bolded codicon-chat-sparkle"></div>
        </button>
      </div>
      <div class="state-badge state-status" data-status={status}>
        <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
          <div class="codicon codicon-loading codicon-modifier-spin"></div>
        </div>
        <p class="state-badge-text">COMPILING</p>
      </div>
    </div>
  </div>
{:else if status === "RUNNING"}
  <div class="state-toolbar">
    <div class="state-toolbar-left">
      <div class="state-badge state-toolbar-dropdown-container">
        <button
          class="state-toolbar-icon state-toolbar-icon-exclude-highlight"
          data-tooltip={showDetails ? "Hide Details" : "Show Details"}
          aria-label={showDetails ? "Hide" : "Show"}
          onclick={handleToggleVisibility}
        >
          <div
            class="codicon codicon-bolded {showDetails
              ? 'codicon-chevron-down'
              : 'codicon-chevron-right'}"
          ></div>
        </button>
      </div>
      <div class="state-badge state-status" data-status="NA">
        <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
          <div class="codicon codicon-bolded codicon-file-code"></div>
        </div>
        <p class="state-badge-text state-badge-text-id">{id}</p>
      </div>
      <div class="state-badge state-status" data-status={interactiveMode ? "CE" : "NA"}>
        <button
          class="state-toolbar-icon state-toolbar-icon-exclude-highlight"
          data-tooltip={interactiveMode ? "Make Non-Interactive" : "Make Interactive"}
          aria-label={interactiveMode ? "Make Non-Interactive" : "Make Interactive"}
          onclick={handleToggleInteractive}
        >
          <div class="codicon codicon-bolded codicon-chat-sparkle"></div>
        </button>
      </div>
      <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
        <div class="codicon codicon-loading codicon-modifier-spin"></div>
      </div>
    </div>
  </div>
{:else if status === "CE"}
  <div class="state-toolbar">
    <div class="state-toolbar-left">
      <div class="state-badge state-toolbar-dropdown-container">
        <button
          class="state-toolbar-icon state-toolbar-icon-exclude-highlight"
          data-tooltip={showDetails ? "Hide Details" : "Show Details"}
          aria-label={showDetails ? "Hide" : "Show"}
          onclick={handleToggleVisibility}
        >
          <div
            class="codicon codicon-bolded {showDetails
              ? 'codicon-chevron-down'
              : 'codicon-chevron-right'}"
          ></div>
        </button>
      </div>
      <div class="state-badge state-status" data-status="NA">
        <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
          <div class="codicon codicon-bolded codicon-file-code"></div>
        </div>
        <p class="state-badge-text state-badge-text-id">{id}</p>
      </div>
      <div class="state-badge state-status" data-status={interactiveMode ? "CE" : "NA"}>
        <button
          class="state-toolbar-icon state-toolbar-icon-exclude-highlight"
          data-tooltip={interactiveMode ? "Make Non-Interactive" : "Make Interactive"}
          aria-label={interactiveMode ? "Make Non-Interactive" : "Make Interactive"}
          onclick={handleToggleInteractive}
        >
          <div class="codicon codicon-bolded codicon-chat-sparkle"></div>
        </button>
      </div>
      <div class="state-badge state-status" data-status={status}>
        <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
          <div class="codicon codicon-bolded codicon-terminal-bash"></div>
        </div>
        <p class="state-badge-text">Compile Error</p>
      </div>
    </div>
  </div>
{:else}
  <div class="state-toolbar">
    <div class="state-toolbar-left">
      <div class="state-badge state-toolbar-dropdown-container">
        <button
          class="state-toolbar-icon state-toolbar-icon-exclude-highlight"
          data-tooltip={showDetails ? "Hide Details" : "Show Details"}
          aria-label={showDetails ? "Hide" : "Show"}
          onclick={handleToggleVisibility}
        >
          <div
            class="codicon codicon-bolded {showDetails
              ? 'codicon-chevron-down'
              : 'codicon-chevron-right'}"
          ></div>
        </button>
      </div>
      <div class="state-badge state-status" data-status="NA">
        <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
          <div class="codicon codicon-bolded codicon-file-code"></div>
        </div>
        <p class="state-badge-text state-badge-text-id">{id}</p>
      </div>
      {#if status !== "NA"}
        <div class="state-badge state-status" data-status={status}>
          <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
            {#if status === "WA"}
              <div class="codicon codicon-bolded codicon-error"></div>
            {:else if status === "RE"}
              <div class="codicon codicon-bolded codicon-warning"></div>
            {:else if status === "TL"}
              <div class="codicon codicon-bolded codicon-clock"></div>
            {:else if status === "ML"}
              <div class="codicon codicon-bolded codicon-chip"></div>
            {:else if status === "AC"}
              <div class="codicon codicon-bolded codicon-check"></div>
            {/if}
          </div>
          <p class="state-badge-text">{status}</p>
        </div>
      {/if}
      <div class="state-badge state-status" data-status={interactiveMode ? "CE" : "NA"}>
        <button
          class="state-toolbar-icon state-toolbar-icon-exclude-highlight"
          data-tooltip={interactiveMode ? "Make Non-Interactive" : "Make Interactive"}
          aria-label={interactiveMode ? "Make Non-Interactive" : "Make Interactive"}
          onclick={handleToggleInteractive}
        >
          <div class="codicon codicon-bolded codicon-chat-sparkle"></div>
        </button>
      </div>
    </div>
    <div class="state-toolbar-right">
      <button
        class="state-toolbar-icon"
        data-tooltip="Open File"
        aria-label="Open"
        onclick={handleOpen}
      >
        <div class="codicon codicon-go-to-file"></div>
      </button>
      {#if status !== "NA" && status !== "AC"}
        <button
          class="state-toolbar-icon"
          data-tooltip="Add to File"
          aria-label="Add"
          onclick={handleAdd}
        >
          <div class="codicon codicon-insert"></div>
        </button>
      {/if}
    </div>
  </div>
{/if}

<Tooltip />

<style>
  .state-toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }

  .state-toolbar-left {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 6px;
    flex-wrap: wrap;
    margin-right: auto;
  }

  .state-toolbar-right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 3px;
  }

  .state-toolbar-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    align-self: stretch;
    border-radius: 2px;
    padding: 3px;
    border: none;
    background: transparent;
    cursor: pointer;
    color: inherit;
  }

  .state-toolbar-icon:not(.state-toolbar-icon-exclude-highlight):hover {
    background: var(--vscode-button-secondaryBackground);
  }

  .state-badge {
    display: flex;
    align-items: center;
    padding: 0px 3px;
    border-radius: 5px;
    font-size: 15px;
    font-weight: bold;
    line-height: 1;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .state-badge-text {
    margin: 0 3px 0 0;
  }

  .state-badge-text-id {
    margin-left: 1px;
  }

  .state-toolbar-dropdown-container {
    padding: 0px;
  }

  .codicon-bolded {
    text-shadow: 0 0 2px currentColor;
  }

  /* Status-specific colors using data-status attribute */
  .state-status[data-status="CE"] {
    background-color: var(--vscode-terminal-ansiMagenta);
  }

  .state-status[data-status="RE"] {
    background-color: var(--vscode-terminal-ansiRed);
  }

  .state-status[data-status="WA"] {
    background-color: var(--vscode-terminal-ansiRed);
  }

  .state-status[data-status="AC"] {
    background-color: var(--vscode-terminal-ansiGreen);
  }

  .state-status[data-status="TL"] {
    background-color: var(--vscode-terminal-ansiRed);
  }

  .state-status[data-status="COMPILING"] {
    background-color: var(--vscode-terminal-ansiMagenta);
  }

  .state-status[data-status="ML"] {
    background-color: var(--vscode-terminal-ansiRed);
  }
</style>
