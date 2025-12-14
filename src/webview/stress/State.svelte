<script lang="ts">
  import { Status } from "~shared/enums";
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

  const from = ["Generator", "Solution", "Good Solution"];
  const placeholders = ["Generator input...", "Solution output...", "Accepted output..."];

  function handleAdd() {
    onAdd(id);
  }

  function handleExpand() {
    onView(id);
  }

  const status = $derived(state.status);

  const statusText = $derived(
    status === Status.WA
      ? "Wrong Answer"
      : status === Status.RE
        ? "Runtime Error"
        : status === Status.TL
          ? "Time Limit Exceeded"
          : ""
  );
</script>

{#if status === Status.COMPILING}
  <div class="state-container">
    <div class="state-toolbar">
      <div class="state-toolbar-left">
        <strong class="state-toolbar-text-bubble" data-status={status}>
          {from[id]}
        </strong>
        <strong class="state-toolbar-text-bubble" data-status={status}>COMPILING</strong>
        <div class="state-toolbar-icon state-toolbar-icon-exclude-highlight">
          <div class="codicon codicon-loading codicon-modifier-spin"></div>
        </div>
      </div>
    </div>
  </div>
{:else if status === Status.RUNNING}
  <div class="state-container">
    <div class="state-toolbar">
      <div class="state-toolbar-left">
        <strong class="state-toolbar-text-bubble" data-status={status}>
          {from[id]}
        </strong>
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
{:else if status === Status.CE}
  <div class="state-container">
    <div class="state-toolbar">
      <div class="state-toolbar-left">
        <strong class="state-toolbar-text-bubble" data-status={Status.NA}>
          {from[id]}
        </strong>
        <strong class="state-toolbar-text-bubble" data-status={status}> Compile Error </strong>
      </div>
    </div>
  </div>
{:else if status === Status.WA || status === Status.RE || status === Status.TL}
  <div class="state-container">
    <div class="state-toolbar">
      <div class="state-toolbar-left">
        <strong class="state-toolbar-text-bubble" data-status={Status.NA}>
          {from[id]}
        </strong>
        <strong class="state-toolbar-text-bubble" data-status={status}>
          {statusText}
        </strong>
      </div>
      <div class="state-toolbar-right">
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="state-toolbar-icon" onclick={handleAdd}>
          <div class="codicon codicon-insert"></div>
        </div>
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
        <strong class="state-toolbar-text-bubble" data-status={Status.NA}>
          {from[id]}
        </strong>
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
  }

  .state-toolbar-left {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 6px;
  }

  .state-toolbar-right {
    display: flex;
    align-items: center;
    margin-left: auto;
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
  }

  .state-toolbar-icon:not(.state-toolbar-icon-exclude-highlight):hover {
    background: var(--vscode-button-secondaryBackground);
  }

  .state-container {
    margin-bottom: 28px;
  }

  .state-toolbar-text-bubble {
    display: flex;
    align-items: center;
    height: 22px;
    padding: 1px 6px;
    border-radius: 11px;
    font-size: 15px;
    font-weight: bold;
    line-height: 1;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  /* Status-specific colors using data-status attribute */
  /* CE=0 */
  .state-toolbar-text-bubble[data-status="0"] {
    background-color: var(--vscode-terminal-ansiMagenta);
  }

  /* RE=1 */
  .state-toolbar-text-bubble[data-status="1"] {
    background-color: var(--vscode-terminal-ansiRed);
  }

  /* WA=2 */
  .state-toolbar-text-bubble[data-status="2"] {
    background-color: var(--vscode-terminal-ansiRed);
  }

  /* AC=3 */
  .state-toolbar-text-bubble[data-status="3"] {
    background-color: var(--vscode-terminal-ansiGreen);
  }

  /* TL=5 */
  .state-toolbar-text-bubble[data-status="5"] {
    background-color: var(--vscode-terminal-ansiRed);
  }
</style>
