<script lang="ts">
  import type { Status, Stdio } from "../../shared/enums";
  import type { StateId } from "../../shared/stress-messages";
  import AutoresizeTextarea from "../AutoresizeTextarea.svelte";
  import Tooltip from "../Tooltip.svelte";

  interface IState {
    stdin: string;
    stdout: string;
    stderr: string;
    status: Status;
  }

  interface Props {
    state: IState;
    id: StateId;
    interactiveMode: boolean;
    placeholder: string;
    onView: (id: StateId, stdio: Stdio) => void;
    onAdd: (id: StateId) => void;
  }

  let { state, id, interactiveMode, placeholder, onView, onAdd }: Props = $props();

  function handleAdd() {
    onAdd(id);
  }

  function handleViewStdin() {
    onView(id, "STDIN");
  }

  function handleViewStdout() {
    onView(id, "STDOUT");
  }

  function handleViewStderr() {
    onView(id, "STDERR");
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
            : status === "AC"
              ? "Accepted"
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
            {id}
          </p>
        </div>
        {#if interactiveMode}
          <div class="state-badge state-status" data-status="CE">
            <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
              <div class="codicon codicon-bolded codicon-chat-sparkle"></div>
            </div>
          </div>
        {/if}
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
            {id}
          </p>
        </div>
        {#if interactiveMode}
          <div class="state-badge state-status" data-status="CE">
            <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
              <div class="codicon codicon-bolded codicon-chat-sparkle"></div>
            </div>
          </div>
        {/if}
        <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
          <div class="codicon codicon-loading codicon-modifier-spin"></div>
        </div>
      </div>
    </div>
    <AutoresizeTextarea value={state.stdin} readonly hiddenOnEmpty onexpand={handleViewStdin} />
    <AutoresizeTextarea
      value={state.stderr}
      readonly
      hiddenOnEmpty
      onexpand={handleViewStderr}
      variant="stderr"
    />
    <AutoresizeTextarea value={state.stdout} readonly {placeholder} onexpand={handleViewStdout} />
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
            {id}
          </p>
        </div>
        {#if interactiveMode}
          <div class="state-badge state-status" data-status="CE">
            <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
              <div class="codicon codicon-bolded codicon-chat-sparkle"></div>
            </div>
          </div>
        {/if}
        <div class="state-badge state-status" data-status={status}>
          <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
            <div class="codicon codicon-bolded codicon-terminal-bash"></div>
          </div>
          <p class="state-badge-text">Compile Error</p>
        </div>
      </div>
    </div>
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
            {id}
          </p>
        </div>
        {#if interactiveMode}
          <div class="state-badge state-status" data-status="CE">
            <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
              <div class="codicon codicon-bolded codicon-chat-sparkle"></div>
            </div>
          </div>
        {/if}
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
            <p class="state-badge-text">{statusText}</p>
          </div>
        {/if}
      </div>
      {#if status !== "NA" && status !== "AC"}
        <div class="state-toolbar-right">
          <button
            class="state-toolbar-icon"
            data-tooltip="Add to Judge"
            aria-label="Add"
            onclick={handleAdd}
          >
            <div class="codicon codicon-insert"></div>
          </button>
        </div>
      {/if}
    </div>
    <AutoresizeTextarea value={state.stdin} readonly hiddenOnEmpty onexpand={handleViewStdin} />
    <AutoresizeTextarea
      value={state.stderr}
      readonly
      hiddenOnEmpty
      onexpand={handleViewStderr}
      variant="stderr"
    />
    <AutoresizeTextarea
      value={state.stdout}
      readonly
      {placeholder}
      onexpand={handleViewStdout}
      variant={id === "Generator" && interactiveMode ? "interactor-secret" : "default"}
    />
  </div>
{/if}

<Tooltip />

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
    color: inherit;
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
    padding: 0px 6px;
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
