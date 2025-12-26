<script lang="ts">
  import type { Status } from "../../shared/enums";
  import AutoresizeTextarea from "../AutoresizeTextarea.svelte";

  interface IState {
    data: string;
    status: Status;
  }

  interface Props {
    state: IState;
    id: number;
    onView: (id: number) => void;
    onAdd: (id: number) => void;
  }

  let { state, id, onView, onAdd }: Props = $props();

  const from = ["Generator", "Solution", "Judge"];
  const placeholders = ["Generator input...", "Solution output...", "Accepted output..."];

  function handleAdd() {
    onAdd(id);
  }

  function handleExpand() {
    onView(id);
  }

  const status = $derived(state.status);

  const statusText = $derived(
    status === "WA"
      ? "Wrong Answer"
      : status === "RE"
        ? "Runtime Error"
        : status === "TL"
          ? "Time Limit Exceeded"
          : status === "ML"
            ? "Memory Limit Exceeded"
            : ""
  );
</script>

{#if status === "COMPILING"}
  <div class="state-container">
    <div class="state-toolbar">
      <div class="state-toolbar-left">
        <div class="state-badge state-status" data-status="NA">
          <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
            <div class="codicon codicon-bolded codicon-play"></div>
          </div>
          <p class="state-badge-text">
            {from[id]}
          </p>
        </div>
        <div class="state-badge state-status" data-status={status}>
          <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
            <div class="codicon codicon-loading codicon-modifier-spin"></div>
          </div>
          <p class="state-badge-text">COMPILING</p>
        </div>
      </div>
    </div>
  </div>
{:else if status === "RUNNING"}
  <div class="state-container">
    <div class="state-toolbar">
      <div class="state-toolbar-left">
        <div class="state-badge state-status" data-status="NA">
          <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
            <div class="codicon codicon-bolded codicon-play"></div>
          </div>
          <p class="state-badge-text">
            {from[id]}
          </p>
        </div>
        <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
          <div class="codicon codicon-loading codicon-modifier-spin"></div>
        </div>
      </div>
    </div>
    <AutoresizeTextarea
      value={state.data}
      readonly
      placeholder={placeholders[id]}
      onexpand={handleExpand}
    />
  </div>
{:else if status === "CE"}
  <div class="state-container">
    <div class="state-toolbar">
      <div class="state-toolbar-left">
        <div class="state-badge state-status" data-status="NA">
          <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
            <div class="codicon codicon-bolded codicon-play"></div>
          </div>
          <p class="state-badge-text">
            {from[id]}
          </p>
        </div>
        <div class="state-badge state-status" data-status={status}>
          <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
            <div class="codicon codicon-bolded codicon-terminal-bash"></div>
          </div>
          <p class="state-badge-text">Compile Error</p>
        </div>
      </div>
    </div>
  </div>
{:else if status === "WA" || status === "RE" || status === "TL" || status === "ML"}
  <div class="state-container">
    <div class="state-toolbar">
      <div class="state-toolbar-left">
        <div class="state-badge state-status" data-status="NA">
          <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
            <div class="codicon codicon-bolded codicon-play"></div>
          </div>
          <p class="state-badge-text">
            {from[id]}
          </p>
        </div>
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
            {/if}
          </div>
          <p class="state-badge-text">{statusText}</p>
        </div>
      </div>
      <div class="state-toolbar-right">
        <button class="state-toolbar-icon" aria-label="Add" onclick={handleAdd}>
          <div class="codicon codicon-insert"></div>
        </button>
      </div>
    </div>
    <AutoresizeTextarea
      value={state.data}
      readonly
      placeholder={placeholders[id]}
      onexpand={handleExpand}
      variant="stderr"
    />
  </div>
{:else}
  <div class="state-container">
    <div class="state-toolbar">
      <div class="state-toolbar-left">
        <div class="state-badge state-status" data-status="NA">
          <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
            <div class="codicon codicon-bolded codicon-play"></div>
          </div>
          <p class="state-badge-text">
            {from[id]}
          </p>
        </div>
      </div>
    </div>
    <AutoresizeTextarea
      value={state.data}
      readonly
      placeholder={placeholders[id]}
      onexpand={handleExpand}
    />
  </div>
{/if}

<style>
  .state-toolbar {
    display: flex;
    align-items: center;
    margin-bottom: 6px;
    flex-wrap: wrap;
    gap: 6px;
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
    gap: 6px;
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
  }

  .state-toolbar-icon:not(.state-toolbar-icon-exclude-highlight):hover {
    background: var(--vscode-button-secondaryBackground);
  }

  .state-container {
    margin-bottom: 28px;
  }

  .state-badge {
    display: flex;
    align-items: center;
    padding: 1px 6px;
    border-radius: 11px;
    font-size: 15px;
    font-weight: bold;
    line-height: 1;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .state-badge-text {
    margin: 0 3px 0 0;
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
