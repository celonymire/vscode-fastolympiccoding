<script lang="ts">
  import type * as v from "valibot";

  import type { TestcaseSchema } from "../../shared/schemas";
  import type { Stdio } from "../../shared/enums";
  import AutoresizeTextarea from "../AutoresizeTextarea.svelte";
  import { type ActionValue } from "../../shared/judge-messages";
  import { postProviderMessage } from "./message";
  import Tooltip from "../Tooltip.svelte";

  type ITestcase = v.InferOutput<typeof TestcaseSchema>;

  interface Props {
    id: number;
    testcase: ITestcase;
    resetStdin: () => void;
    updateTestcaseData: (id: number, updates: Partial<ITestcase>) => void;
  }

  let { id, testcase, resetStdin, updateTestcaseData }: Props = $props();

  function handleSave() {
    const stdin = testcase.stdin;
    const acceptedStdout = testcase.acceptedStdout;
    // Clear the values locally (extension will send back shortened version)
    updateTestcaseData(id, { stdin: "", acceptedStdout: "" });
    postProviderMessage({
      type: "SAVE",
      id,
      stdin,
      acceptedStdout,
    });
  }

  function handleAction(action: ActionValue) {
    postProviderMessage({ type: "ACTION", id, action });
  }

  function handleRun() {
    resetStdin();
    handleAction("RUN");
  }

  function handleDebug() {
    resetStdin();
    handleAction("DEBUG");
  }

  function handleEdit() {
    handleAction("EDIT");
  }

  function handleDelete() {
    handleAction("DELETE");
  }

  function handleAccept() {
    handleAction("ACCEPT");
  }

  function handleDecline() {
    handleAction("DECLINE");
  }

  function handleToggleVisibility() {
    handleAction("TOGGLE_VISIBILITY");
  }

  function handleToggleSkip() {
    handleAction("TOGGLE_SKIP");
  }

  function handleStop() {
    handleAction("STOP");
  }

  function handleCompare() {
    handleAction("COMPARE");
  }

  // Derived values
  const status = $derived(testcase.status);
  const visible = $derived(testcase.shown);
  const skipped = $derived(testcase.skipped);
  const toggled = $derived(testcase.toggled);
  const showDetails = $derived(!skipped && visible && !(status === "AC" && !toggled));
</script>

{#if status === "CE"}
  <div class="testcase-toolbar" class:testcase-toolbar--hidden={skipped}>
    <div class="testcase-badges">
      <div class="testcase-elapsed-badge testcase-elapsed" data-status={status}>
        <div class="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
          <div class="codicon codicon-bolded codicon-terminal-bash"></div>
        </div>
        <p class="testcase-elapsed-text">CE</p>
      </div>
      {#if testcase.mode === "interactive"}
        <div class="testcase-elapsed-badge testcase-elapsed" data-status={"CE"}>
          <div class="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
            <div class="codicon codicon-bolded codicon-chat-sparkle"></div>
          </div>
        </div>
      {/if}
    </div>
    <div class="testcase-actions">
      <div class="testcase-left-buttons">
        <button
          class="testcase-toolbar-icon"
          data-tooltip="Run Testcase"
          aria-label="Run"
          onclick={handleRun}
        >
          <div class="codicon codicon-run-below"></div>
        </button>
        <button
          class="testcase-toolbar-icon"
          data-tooltip="Debug Testcase"
          aria-label="Debug"
          onclick={handleDebug}
        >
          <div class="codicon codicon-debug-alt"></div>
        </button>
        <button
          class="testcase-toolbar-icon"
          data-tooltip="Edit Testcase"
          aria-label="Edit"
          onclick={handleEdit}
        >
          <div class="codicon codicon-edit"></div>
        </button>
        <button
          class="testcase-toolbar-icon"
          data-tooltip="Delete Testcase"
          aria-label="Delete"
          onclick={handleDelete}
        >
          <div class="codicon codicon-trash"></div>
        </button>
        <button
          class="testcase-toolbar-icon"
          data-tooltip={showDetails ? "Hide Details" : "Show Details"}
          aria-label={showDetails ? "Hide" : "Show"}
          onclick={handleToggleVisibility}
        >
          <div class="codicon {showDetails ? 'codicon-eye-closed' : 'codicon-eye'}"></div>
        </button>
        <button
          class="testcase-toolbar-icon testcase-toolbar-icon--visibility"
          data-tooltip={skipped ? "Unskip Testcase" : "Skip Testcase"}
          aria-label={skipped ? "Unskip" : "Skip"}
          onclick={handleToggleSkip}
        >
          <div
            class="codicon {skipped ? 'codicon-debug-connected' : 'codicon-debug-disconnect'}"
          ></div>
        </button>
      </div>
    </div>
  </div>
{:else if status === "NA" || status === "AC" || status === "WA" || status === "RE" || status === "TL" || status === "ML"}
  <div class="testcase-toolbar" class:testcase-toolbar--hidden={skipped}>
    <div class="testcase-badges">
      <div class="testcase-elapsed-badge testcase-elapsed" data-status={status}>
        <div class="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
          {#if status === "NA"}
            <div class="codicon codicon-bolded codicon-play"></div>
          {:else if status === "AC"}
            <div class="codicon codicon-bolded codicon-pass"></div>
          {:else if status === "WA"}
            <div class="codicon codicon-bolded codicon-error"></div>
          {:else if status === "RE"}
            <div class="codicon codicon-bolded codicon-warning"></div>
          {:else if status === "TL"}
            <div class="codicon codicon-bolded codicon-clock"></div>
          {:else if status === "ML"}
            <div class="codicon codicon-bolded codicon-chip"></div>
          {/if}
        </div>
        <p class="testcase-elapsed-text">
          {status !== "NA" && status !== "AC" && status !== "ML" && status !== "WA"
            ? status
            : testcase.elapsed >= 1000
              ? (testcase.elapsed / 1000).toFixed(1) + "s"
              : testcase.elapsed + "ms"}
        </p>
      </div>
      <div class="testcase-elapsed-badge testcase-elapsed" data-status={status}>
        <div class="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
          <div class="codicon codicon-bolded codicon-chip"></div>
        </div>
        <p class="testcase-elapsed-text">
          {status === "ML"
            ? "ML"
            : testcase.memoryBytes >= 1024 * 1024 * 1024
              ? (testcase.memoryBytes / (1024 * 1024 * 1024)).toFixed(1) + "GB"
              : testcase.memoryBytes >= 1024 * 1024
                ? (testcase.memoryBytes / (1024 * 1024)).toFixed(0) + "MB"
                : testcase.memoryBytes >= 1024
                  ? (testcase.memoryBytes / 1024).toFixed(0) + "KB"
                  : testcase.memoryBytes + "B"}
        </p>
      </div>
      {#if testcase.mode === "interactive"}
        <div class="testcase-elapsed-badge testcase-elapsed" data-status={"CE"}>
          <div class="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
            <div class="codicon codicon-bolded codicon-chat-sparkle"></div>
          </div>
        </div>
      {/if}
    </div>
    <div class="testcase-actions">
      <div class="testcase-left-buttons">
        <button
          class="testcase-toolbar-icon"
          data-tooltip="Run Testcase"
          aria-label="Run"
          onclick={handleRun}
        >
          <div class="codicon codicon-run-below"></div>
        </button>
        <button
          class="testcase-toolbar-icon"
          data-tooltip="Debug Testcase"
          aria-label="Debug"
          onclick={handleDebug}
        >
          <div class="codicon codicon-debug-alt"></div>
        </button>
        <button
          class="testcase-toolbar-icon"
          data-tooltip="Edit Testcase"
          aria-label="Edit"
          onclick={handleEdit}
        >
          <div class="codicon codicon-edit"></div>
        </button>
        <button
          class="testcase-toolbar-icon"
          data-tooltip="Delete Testcase"
          aria-label="Delete"
          onclick={handleDelete}
        >
          <div class="codicon codicon-trash"></div>
        </button>
        <button
          class="testcase-toolbar-icon"
          data-tooltip={showDetails ? "Hide Details" : "Show Details"}
          aria-label={showDetails ? "Hide" : "Show"}
          onclick={handleToggleVisibility}
        >
          <div class="codicon {showDetails ? 'codicon-eye-closed' : 'codicon-eye'}"></div>
        </button>
        <button
          class="testcase-toolbar-icon testcase-toolbar-icon--visibility"
          data-tooltip={skipped ? "Unskip Testcase" : "Skip Testcase"}
          aria-label={skipped ? "Unskip" : "Skip"}
          onclick={handleToggleSkip}
        >
          <div
            class="codicon {skipped ? 'codicon-debug-connected' : 'codicon-debug-disconnect'}"
          ></div>
        </button>
      </div>
      <div class="testcase-right-buttons">
        {#if status === "NA" || (status === "WA" && testcase.mode !== "interactive")}
          <button
            class="testcase-toolbar-icon"
            data-tooltip="Accept Output"
            aria-label="Accept"
            onclick={handleAccept}
          >
            <div class="codicon codicon-pass"></div>
          </button>
        {/if}
        {#if status === "AC" && testcase.mode !== "interactive"}
          <button
            class="testcase-toolbar-icon"
            data-tooltip="Decline Answer"
            aria-label="Decline"
            onclick={handleDecline}
          >
            <div class="codicon codicon-close"></div>
          </button>
        {/if}
        {#if status === "WA" && testcase.mode !== "interactive"}
          <button
            class="testcase-toolbar-icon"
            data-tooltip="Compare Answers"
            aria-label="Compare"
            onclick={handleCompare}
          >
            <div class="codicon codicon-diff-single"></div>
          </button>
        {/if}
      </div>
    </div>
  </div>
{:else if status === "COMPILING"}
  <div class="testcase-toolbar">
    <div class="testcase-toolbar-left">
      <div class="testcase-elapsed-badge testcase-elapsed" data-status={status}>
        <div class="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
          <div class="codicon codicon-loading codicon-modifier-spin"></div>
        </div>
        <p class="testcase-elapsed-text">COMPILING</p>
      </div>
      {#if testcase.mode === "interactive"}
        <div class="testcase-elapsed-badge testcase-elapsed" data-status={"CE"}>
          <div class="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
            <div class="codicon codicon-bolded codicon-chat-sparkle"></div>
          </div>
        </div>
      {/if}
    </div>
  </div>
{:else if status === "RUNNING"}
  <div class="testcase-toolbar">
    <div class="testcase-toolbar-left">
      <div class="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
        <div class="codicon codicon-loading codicon-modifier-spin"></div>
      </div>
      {#if testcase.mode === "interactive"}
        <div class="testcase-elapsed-badge testcase-elapsed" data-status={"CE"}>
          <div class="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
            <div class="codicon codicon-bolded codicon-chat-sparkle"></div>
          </div>
        </div>
      {/if}
      <button
        class="testcase-toolbar-icon"
        data-tooltip="Stop Testcase"
        aria-label="Stop"
        onclick={handleStop}
      >
        <div class="codicon codicon-stop-circle"></div>
      </button>
    </div>
  </div>
{:else if status === "EDITING"}
  <div class="testcase-toolbar">
    <div class="testcase-toolbar-left">
      <div class="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
        <div class="codicon codicon-sync codicon-modifier-spin"></div>
      </div>
      {#if testcase.mode === "interactive"}
        <div class="testcase-elapsed-badge testcase-elapsed" data-status={"CE"}>
          <div class="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
            <div class="codicon codicon-bolded codicon-chat-sparkle"></div>
          </div>
        </div>
      {/if}
      <button
        class="testcase-toolbar-icon"
        data-tooltip="Save Testcase"
        aria-label="Save"
        onclick={handleSave}
      >
        <div class="codicon codicon-save"></div>
      </button>
    </div>
  </div>
{/if}

<Tooltip />

<style>
  .testcase-toolbar {
    display: flex;
    align-items: center;
    margin-bottom: 6px;
    flex-wrap: wrap;
    gap: 6px;
  }

  .testcase-toolbar--hidden > .testcase-badges {
    opacity: 0.5;
  }

  .testcase-toolbar--hidden
    > .testcase-actions
    > .testcase-left-buttons
    > *:not(.testcase-toolbar-icon-exclude-fade) {
    opacity: 0.5;
  }

  .testcase-toolbar--hidden > .testcase-actions > .testcase-right-buttons {
    opacity: 0.5;
  }

  .testcase-toolbar-left {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 6px;
    margin-right: auto;
  }

  .testcase-badges {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .testcase-actions {
    display: flex;
    align-items: center;
    flex-grow: 1;
    flex-wrap: wrap;
    gap: 6px;
  }

  .testcase-left-buttons {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .testcase-right-buttons {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    margin-left: auto;
    flex-wrap: wrap;
  }

  .testcase-toolbar-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    align-self: stretch;
    border-radius: 2px;
    padding: 3px;
    border: none;
    background: transparent;
    color: inherit;
  }

  .testcase-toolbar-icon:not(.testcase-toolbar-icon-exclude-highlight):hover {
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
  }

  .testcase-elapsed-badge {
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

  .testcase-elapsed-text {
    margin: 0 3px 0 0;
  }

  .codicon-bolded {
    text-shadow: 0 0 2px currentColor;
  }

  /* Status-specific colors using data-status attribute */
  .testcase-elapsed[data-status="CE"] {
    background-color: var(--vscode-terminal-ansiMagenta);
  }

  .testcase-elapsed[data-status="RE"] {
    background-color: var(--vscode-terminal-ansiRed);
  }

  .testcase-elapsed[data-status="WA"] {
    background-color: var(--vscode-terminal-ansiRed);
  }

  .testcase-elapsed[data-status="AC"] {
    background-color: var(--vscode-terminal-ansiGreen);
  }

  .testcase-elapsed[data-status="TL"] {
    background-color: var(--vscode-terminal-ansiRed);
  }

  .testcase-elapsed[data-status="COMPILING"] {
    background-color: var(--vscode-terminal-ansiMagenta);
  }

  .testcase-elapsed[data-status="ML"] {
    background-color: var(--vscode-terminal-ansiRed);
  }
</style>
