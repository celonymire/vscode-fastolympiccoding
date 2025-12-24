<script lang="ts">
  import { onMount } from "svelte";
  import type * as v from "valibot";

  import type { TestcaseSchema } from "../../shared/schemas";
  import {
    type DeleteMessageSchema,
    type InitialStateSchema,
    type NewMessageSchema,
    type SetMessageSchema,
    type ShowMessageSchema,
    type StdioMessageSchema,
    type WebviewMessage,
  } from "../../shared/judge-messages";
  import { postProviderMessage } from "./message";
  import Testcase from "./Testcase.svelte";

  type IShowMessage = v.InferOutput<typeof ShowMessageSchema>;
  type IStdioMessage = v.InferOutput<typeof StdioMessageSchema>;
  type ITestcase = v.InferOutput<typeof TestcaseSchema>;

  // Reactive state using Svelte 5 runes
  let testcases = $state<{ id: number; data: ITestcase }[]>([]);
  let newTimeLimit = $state(0);
  let newMemoryLimit = $state(0);
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
          memoryBytes: 0,
          status: "NA",
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
      case "STDIN":
        tc.stdin += data;
        break;
      case "STDERR":
        tc.stderr += data;
        break;
      case "STDOUT":
        tc.stdout += data;
        break;
      case "ACCEPTED_STDOUT":
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
      if (tc.status === "EDITING") {
        postProviderMessage({
          type: "SAVE",
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

  function handleInitialState({
    timeLimit,
    memoryLimit,
  }: v.InferOutput<typeof InitialStateSchema>) {
    newTimeLimit = timeLimit;
    newMemoryLimit = memoryLimit;
  }

  function handleSettingsToggle() {
    showSettings = !showSettings;
  }

  function handleNewTestcase(e: Event) {
    postProviderMessage({ type: "NEXT" });
    (e.currentTarget as HTMLElement | null)?.blur();
  }

  function handleSaveSettings() {
    handleSettingsToggle();
    postProviderMessage({ type: "TL", limit: newTimeLimit });
    postProviderMessage({ type: "ML", limit: newMemoryLimit });
  }

  function handleTimeLimitInput(e: Event) {
    const target = e.target as HTMLInputElement;
    newTimeLimit = Number(target.value);
  }

  function handleMemoryLimitInput(e: Event) {
    const target = e.target as HTMLInputElement;
    newMemoryLimit = Number(target.value);
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
        case "NEW":
          handleNew(msg.data);
          break;
        case "SET":
          handleSet(msg.data);
          break;
        case "STDIO":
          handleStdio(msg.data);
          break;
        case "DELETE":
          handleDelete(msg.data);
          break;
        case "SAVE_ALL":
          handleSaveAll();
          break;
        case "SHOW":
          handleShow(msg.data);
          break;
        case "INITIAL_STATE":
          handleInitialState(msg.data);
          break;
        case "SETTINGS_TOGGLE":
          handleSettingsToggle();
          break;
      }
    };

    window.addEventListener("message", handleMessage);
    postProviderMessage({ type: "LOADED" });

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
        type="number"
        value={newTimeLimit}
        oninput={handleTimeLimitInput}
        class="settings-input"
      />
      <p class="settings-additional-info">
        Specify time limit in milliseconds. "0" means no limit.
      </p>
      <p class="settings-label">Memory Limit</p>
      <input
        type="number"
        value={newMemoryLimit}
        oninput={handleMemoryLimitInput}
        class="settings-input"
      />
      <p class="settings-additional-info">Specify memory limit in megabytes. "0" means no limit.</p>
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

  /* Hide number input spinner buttons */
  .settings-input::-webkit-outer-spin-button,
  .settings-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .settings-input[type="number"] {
    -moz-appearance: textfield;
    appearance: textfield;
  }

  /* Testcase View */
  .testcase-container {
    margin-top: 4px;
    margin-bottom: 24px;
  }
</style>
