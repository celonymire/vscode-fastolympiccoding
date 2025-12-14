<script lang="ts">
  import { onMount } from "svelte";
  import type * as v from "valibot";

  import { Status, Stdio } from "~shared/enums";
  import type { TestcaseSchema } from "~shared/schemas";
  import {
    type DeleteMessageSchema,
    type InitialStateSchema,
    type NewMessageSchema,
    ProviderMessageType,
    type SetMessageSchema,
    type ShowMessageSchema,
    type StdioMessageSchema,
    type WebviewMessage,
    WebviewMessageType,
  } from "~shared/judge-messages";
  import { postProviderMessage } from "./message";
  import Testcase from "./Testcase.svelte";

  type IShowMessage = v.InferOutput<typeof ShowMessageSchema>;
  type IStdioMessage = v.InferOutput<typeof StdioMessageSchema>;
  type ITestcase = v.InferOutput<typeof TestcaseSchema>;

  // Reactive state using Svelte 5 runes
  let testcases = $state<{ id: number; data: ITestcase }[]>([]);
  let newTimeLimit = $state(0);
  let show = $state(true);
  let showSettings = $state(false);

  // Helper to find testcase by id
  function findTestcaseIndex(id: number): number {
    return testcases.findIndex((t) => t.id === id);
  }

  // Message handlers
  function handleNew({ id }: v.InferOutput<typeof NewMessageSchema>) {
    const existing = findTestcaseIndex(id);
    if (existing === -1) {
      testcases.push({
        id,
        data: {
          stdin: "",
          stderr: "",
          stdout: "",
          acceptedStdout: "",
          elapsed: 0,
          status: Status.NA,
          shown: true,
          toggled: false,
          skipped: false,
        },
      });
    }
  }

  function handleSet({ id, property, value }: v.InferOutput<typeof SetMessageSchema>) {
    const idx = findTestcaseIndex(id);
    if (idx !== -1) {
      (testcases[idx].data as unknown as Record<string, unknown>)[property] = value;
    }
  }

  function handleStdio({ id, data, stdio }: IStdioMessage) {
    const idx = findTestcaseIndex(id);
    if (idx === -1) return;
    const tc = testcases[idx].data;
    switch (stdio) {
      case Stdio.STDIN:
        tc.stdin += data;
        break;
      case Stdio.STDERR:
        tc.stderr += data;
        break;
      case Stdio.STDOUT:
        tc.stdout += data;
        break;
      case Stdio.ACCEPTED_STDOUT:
        tc.acceptedStdout += data;
        break;
    }
  }

  function handleDelete({ id }: v.InferOutput<typeof DeleteMessageSchema>) {
    const idx = findTestcaseIndex(id);
    if (idx !== -1) {
      testcases.splice(idx, 1);
    }
  }

  function handleSaveAll() {
    for (const { id, data: tc } of testcases) {
      if (tc.status === Status.EDITING) {
        postProviderMessage({
          type: ProviderMessageType.SAVE,
          id,
          stdin: tc.stdin,
          acceptedStdout: tc.acceptedStdout,
        });
      }
    }
  }

  function handleShow({ visible }: IShowMessage) {
    show = visible;
  }

  function handleInitialState({ timeLimit }: v.InferOutput<typeof InitialStateSchema>) {
    newTimeLimit = timeLimit;
  }

  function handleSettingsToggle() {
    showSettings = !showSettings;
  }

  function handleNewTestcase(e: Event) {
    postProviderMessage({ type: ProviderMessageType.NEXT });
    (e.currentTarget as HTMLElement | null)?.blur();
  }

  function handleSaveSettings() {
    handleSettingsToggle();
    postProviderMessage({ type: ProviderMessageType.TL, limit: newTimeLimit });
  }

  function handleTimeLimitInput(e: Event) {
    const target = e.target as HTMLInputElement;
    newTimeLimit = Number(target.value);
  }

  function handleTimeLimitKeyDown(e: KeyboardEvent) {
    if (
      !/\d/.test(e.key) &&
      !["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Tab"].includes(e.key)
    ) {
      e.preventDefault();
    }
  }

  // Update testcase data from child component
  function updateTestcaseData(id: number, updates: Partial<ITestcase>) {
    const idx = findTestcaseIndex(id);
    if (idx !== -1) {
      Object.assign(testcases[idx].data, updates);
    }
  }

  // Listen for messages from extension
  onMount(() => {
    const handleMessage = (msg: MessageEvent<WebviewMessage>) => {
      switch (msg.data.type) {
        case WebviewMessageType.NEW:
          handleNew(msg.data);
          break;
        case WebviewMessageType.SET:
          handleSet(msg.data);
          break;
        case WebviewMessageType.STDIO:
          handleStdio(msg.data);
          break;
        case WebviewMessageType.DELETE:
          handleDelete(msg.data);
          break;
        case WebviewMessageType.SAVE_ALL:
          handleSaveAll();
          break;
        case WebviewMessageType.SHOW:
          handleShow(msg.data);
          break;
        case WebviewMessageType.INITIAL_STATE:
          handleInitialState(msg.data);
          break;
        case WebviewMessageType.SETTINGS_TOGGLE:
          handleSettingsToggle();
          break;
      }
    };

    window.addEventListener("message", handleMessage);
    postProviderMessage({ type: ProviderMessageType.LOADED });

    return () => {
      window.removeEventListener("message", handleMessage);
    };
  });
</script>

{#if show}
  {#if showSettings}
    <div class="settings-section">
      <p class="settings-label">Time Limit</p>
      <input
        value={newTimeLimit}
        oninput={handleTimeLimitInput}
        onkeydown={handleTimeLimitKeyDown}
        class="settings-input"
      />
      <p class="settings-additional-info">
        Specify time limit in milliseconds. "0" Means no limit.
      </p>
    </div>
    <button type="button" class="text-button" onclick={handleSaveSettings}>
      <div class="codicon codicon-save"></div>
      Save
    </button>
  {:else}
    <div class="testcase-container">
      {#each testcases as { id, data } (id)}
        <Testcase {id} testcase={data} {updateTestcaseData} />
      {/each}
      <button type="button" class="text-button" onclick={handleNewTestcase}>
        <div class="codicon codicon-add"></div>
        New Testcase
      </button>
    </div>
  {/if}
{:else}
  <div id="empty-state">
    <div class="codicon codicon-symbol-event empty-state-icon"></div>
    <p class="empty-state-text">Open a file to get started</p>
  </div>
{/if}

<style>
  /* Standard VSCode styling */
  .text-button {
    box-sizing: border-box;
    display: flex;
    width: 100%;
    padding: 4px;
    border-radius: 2px;
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

  /* Main View */
  #empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 100vh;
  }

  .codicon.empty-state-icon {
    font-size: 150px;
  }

  .empty-state-text {
    line-height: 1;
  }

  /* Settings View */
  .settings-section {
    margin-bottom: 16px;
  }

  .settings-label {
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 13px;
    margin-bottom: 2px;
  }

  .settings-additional-info {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    margin-top: 2px;
  }

  .settings-input {
    width: 100%;
    box-sizing: border-box;
    padding: 4px;
    border: 1px solid var(--vscode-input-border);
    border-radius: 2px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
  }

  .settings-input:focus {
    border: 1px solid var(--vscode-inputOption-activeBorder);
  }

  /* Testcase View */
  .testcase-container {
    margin-top: 4px;
    margin-bottom: 24px;
  }
</style>
