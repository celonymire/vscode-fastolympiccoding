<script lang="ts">
  import type * as v from "valibot";

  import type { TestcaseSchema } from "../../shared/schemas";
  import { type ActionValue } from "../../shared/judge-messages";
  import { postProviderMessage } from "./message";
  import Tooltip from "../Tooltip.svelte";

  type ITestcase = v.InferOutput<typeof TestcaseSchema>;

  interface Props {
    testcase: ITestcase;
    onprerun: () => void;
  }

  let { testcase, onprerun }: Props = $props();

  function handleAction(action: ActionValue) {
    postProviderMessage({ type: "ACTION", uuid: testcase.uuid, action });
  }

  function handleRun() {
    onprerun();
    handleAction("RUN");
  }

  function handleDebug() {
    onprerun();
    handleAction("DEBUG");
  }

  function handleDelete() {
    handleAction("DELETE");
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

  function handleToggleInteractive() {
    handleAction("TOGGLE_INTERACTIVE");
  }

  // Derived values
  const status = $derived(testcase.status);
  const visible = $derived(testcase.shown);
  const skipped = $derived(testcase.skipped);
  const toggled = $derived(testcase.toggled);
  const showDetails = $derived(!skipped && visible && !(status === "AC" && !toggled));
  const statusIcon = $derived(
    testcase.mode === "interactive" ? "codicon-comment-discussion-sparkle" : "codicon-output"
  );
</script>

{#if status === "NA" || status === "AC" || status === "WA" || status === "RE" || status === "TL" || status === "ML" || status === "CE"}
  <div class="toolbar" class:toolbar--hidden={skipped} class:toolbar--skipped={skipped}>
    <div class="toolbar-badges">
      <div
        class="toolbar-badge-container toolbar-dropdown-container toolbar-badge"
        data-status={status}
      >
        <button
          class="toolbar-icon toolbar-icon-exclude-highlight"
          data-tooltip={showDetails ? "Hide Details" : "Show Details"}
          aria-label={showDetails ? "Hide" : "Show"}
          onclick={handleToggleVisibility}
          disabled={skipped}
        >
          <div
            class="codicon codicon-bolded {showDetails
              ? 'codicon-chevron-down'
              : 'codicon-chevron-right'}"
          ></div>
        </button>
      </div>
      <div class="toolbar-badge-container toolbar-badge" data-status={status}>
        <div class="toolbar-icon toolbar-icon-exclude-highlight">
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
          {:else if status === "CE"}
            <div class="codicon codicon-bolded codicon-terminal-bash"></div>
          {/if}
        </div>
        <p class="toolbar-badge-text">
          {status !== "NA" && status !== "AC" && status !== "ML" && status !== "WA"
            ? status
            : testcase.elapsed >= 1000
              ? (testcase.elapsed / 1000).toFixed(1) + "s"
              : testcase.elapsed + "ms"}
        </p>
      </div>
      {#if status !== "CE"}
        <div class="toolbar-badge-container toolbar-badge" data-status={status}>
          <div class="toolbar-icon toolbar-icon-exclude-highlight">
            <div class="codicon codicon-bolded codicon-chip"></div>
          </div>
          <p class="toolbar-badge-text">
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
      {/if}
      <div
        class="toolbar-badge-container toolbar-badge"
        data-status={testcase.mode === "interactive" ? "CE" : "NA"}
      >
        <button
          class="toolbar-icon toolbar-icon-exclude-highlight"
          data-tooltip={testcase.mode === "interactive"
            ? "Make Non-Interactive"
            : "Make Interactive"}
          aria-label={testcase.mode === "interactive" ? "Make Non-Interactive" : "Make Interactive"}
          onclick={handleToggleInteractive}
        >
          <div class="codicon codicon-bolded {statusIcon}"></div>
        </button>
      </div>
    </div>
    <div class="testcase-buttons">
      <button
        class="toolbar-icon"
        data-tooltip="Run Testcase"
        aria-label="Run"
        onclick={handleRun}
        disabled={skipped}
      >
        <div class="codicon codicon-run-below"></div>
      </button>
      <button
        class="toolbar-icon"
        data-tooltip="Debug Testcase"
        aria-label="Debug"
        onclick={handleDebug}
        disabled={skipped}
      >
        <div class="codicon codicon-debug-alt"></div>
      </button>
      <button
        class="toolbar-icon toolbar-icon--visibility"
        data-tooltip={skipped ? "Unskip Testcase" : "Skip Testcase"}
        aria-label={skipped ? "Unskip" : "Skip"}
        onclick={handleToggleSkip}
      >
        <div class="codicon {skipped ? 'codicon-run-coverage' : 'codicon-run-errors'}"></div>
      </button>
      <button
        class="toolbar-icon"
        data-tooltip="Delete Testcase"
        aria-label="Delete"
        onclick={handleDelete}
      >
        <div class="codicon codicon-trash"></div>
      </button>
      {#if testcase.mode === "interactive"}
        <div class="spacer"></div>
        <button
          class="toolbar-icon"
          data-tooltip="Open Interactor"
          aria-label="Open Interactor"
          onclick={() => handleAction("OPEN_INTERACTOR")}
        >
          <div class="codicon codicon-go-to-file"></div>
        </button>
      {/if}
    </div>
  </div>
{:else if status === "COMPILING"}
  <div class="toolbar">
    <div class="toolbar-left">
      <div
        class="toolbar-badge-container toolbar-dropdown-container toolbar-badge"
        data-status={status}
      >
        <button
          class="toolbar-icon toolbar-icon-exclude-highlight"
          data-tooltip={visible ? "Hide Details" : "Show Details"}
          aria-label={visible ? "Hide" : "Show"}
          disabled
        >
          <div
            class="codicon codicon-bolded {visible
              ? 'codicon-chevron-down'
              : 'codicon-chevron-right'}"
          ></div>
        </button>
      </div>
      <div class="toolbar-badge-container toolbar-badge" data-status={status}>
        <div class="toolbar-icon toolbar-icon-exclude-highlight">
          <div class="codicon codicon-loading codicon-modifier-spin"></div>
        </div>
        <p class="toolbar-badge-text">COMPILING</p>
      </div>
      <div
        class="toolbar-badge-container toolbar-badge"
        data-status={testcase.mode === "interactive" ? "CE" : "NA"}
      >
        <button
          class="toolbar-icon toolbar-icon-exclude-highlight"
          data-tooltip={testcase.mode === "interactive"
            ? "Make Non-Interactive"
            : "Make Interactive"}
          aria-label={testcase.mode === "interactive" ? "Make Non-Interactive" : "Make Interactive"}
          onclick={handleToggleInteractive}
        >
          <div class="codicon codicon-bolded {statusIcon}"></div>
        </button>
      </div>
    </div>
  </div>
{:else if status === "RUNNING"}
  <div class="toolbar">
    <div class="toolbar-left">
      <div
        class="toolbar-badge-container toolbar-dropdown-container toolbar-badge"
        data-status={status}
      >
        <button
          class="toolbar-icon toolbar-icon-exclude-highlight"
          data-tooltip={showDetails ? "Hide Details" : "Show Details"}
          aria-label={showDetails ? "Hide" : "Show"}
          onclick={handleToggleVisibility}
          disabled={skipped}
        >
          <div
            class="codicon codicon-bolded {showDetails
              ? 'codicon-chevron-down'
              : 'codicon-chevron-right'}"
          ></div>
        </button>
      </div>
      <div
        class="toolbar-badge-container toolbar-badge"
        data-status={testcase.mode === "interactive" ? "CE" : "NA"}
      >
        <button
          class="toolbar-icon toolbar-icon-exclude-highlight"
          data-tooltip={testcase.mode === "interactive"
            ? "Make Non-Interactive"
            : "Make Interactive"}
          aria-label={testcase.mode === "interactive" ? "Make Non-Interactive" : "Make Interactive"}
          onclick={handleToggleInteractive}
        >
          <div class="codicon codicon-bolded {statusIcon}"></div>
        </button>
      </div>
      <div class="toolbar-icon toolbar-icon-exclude-highlight">
        <div class="codicon codicon-loading codicon-modifier-spin"></div>
      </div>
      <button
        class="toolbar-icon"
        data-tooltip="Stop Testcase"
        aria-label="Stop"
        onclick={handleStop}
      >
        <div class="codicon codicon-stop-circle"></div>
      </button>
    </div>
  </div>
{/if}

<Tooltip />

<style>
  .toolbar {
    display: flex;
    align-items: center;
    margin-bottom: 6px;
    flex-wrap: wrap;
    gap: 6px;
  }

  .toolbar-left {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 6px;
    margin-right: auto;
  }

  .toolbar-badges {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .testcase-buttons {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    flex-grow: 1;
  }

  .spacer {
    flex-grow: 1;
  }

  .toolbar-icon {
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

  .toolbar-icon:not(.toolbar-icon-exclude-highlight):hover {
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground);
  }

  .toolbar-icon:disabled:not(.toolbar-icon-exclude-highlight) {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .toolbar-badge-container {
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

  .toolbar--skipped .toolbar-badge-container {
    opacity: 0.5;
  }

  .toolbar-dropdown-container {
    padding: 0px;
  }

  .toolbar-badge-text {
    margin: 0 3px 0 0;
  }

  .codicon-bolded {
    text-shadow: 0 0 2px currentColor;
  }

  /* Status-specific colors using data-status attribute */
  .toolbar-badge[data-status="CE"] {
    background-color: var(--vscode-terminal-ansiMagenta);
  }

  .toolbar-badge[data-status="RE"] {
    background-color: var(--vscode-terminal-ansiRed);
  }

  .toolbar-badge[data-status="WA"] {
    background-color: var(--vscode-terminal-ansiRed);
  }

  .toolbar-badge[data-status="AC"] {
    background-color: var(--vscode-terminal-ansiGreen);
  }

  .toolbar-badge[data-status="TL"] {
    background-color: var(--vscode-terminal-ansiRed);
  }

  .toolbar-badge[data-status="COMPILING"] {
    background-color: var(--vscode-terminal-ansiMagenta);
  }

  .toolbar-badge[data-status="ML"] {
    background-color: var(--vscode-terminal-ansiRed);
  }
</style>
