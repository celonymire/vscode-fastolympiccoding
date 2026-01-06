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
    type FullDataSchema,
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
  let showTestcaseDropdown = $state(false);

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
          mode: "standard",
          interactorSecret: "",
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
      case "INTERACTOR_SECRET":
        tc.interactorSecret += data;
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
          stdio: "STDIN",
          data: tc.stdin,
        });
        postProviderMessage({
          type: "SAVE",
          id,
          stdio: "ACCEPTED_STDOUT",
          data: tc.acceptedStdout,
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
    showTestcaseDropdown = false;
    showSettings = !showSettings;
  }

  function handleToggleDropdown() {
    showTestcaseDropdown = !showTestcaseDropdown;
  }

  function handleNewTestcase(e: Event) {
    postProviderMessage({ type: "NEXT", mode: "standard" });
    showTestcaseDropdown = false;
    (e.currentTarget as HTMLElement | null)?.blur();
  }

  function handleNewInteractiveTestcase(e: Event) {
    postProviderMessage({ type: "NEXT", mode: "interactive" });
    showTestcaseDropdown = false;
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

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const wrapper = document.querySelector(".new-button-wrapper");
      const dropdown = document.querySelector(".dropdown-menu");

      if (
        showTestcaseDropdown &&
        wrapper &&
        dropdown &&
        !wrapper.contains(target) &&
        !dropdown.contains(target)
      ) {
        showTestcaseDropdown = false;
      }
    };

    window.addEventListener("message", handleMessage);
    document.addEventListener("click", handleClickOutside);
    postProviderMessage({ type: "LOADED" });

    return () => {
      window.removeEventListener("message", handleMessage);
      document.removeEventListener("click", handleClickOutside);
    };
  });
</script>

{#if show}
  {#if showSettings}
    <div class="settings-section">
      <label for="time-limit-input" class="settings-label">Time Limit</label>
      <input
        id="time-limit-input"
        type="number"
        value={newTimeLimit}
        oninput={handleTimeLimitInput}
        class="settings-input"
      />
      <p class="settings-additional-info">
        Specify time limit in milliseconds. "0" means no limit.
      </p>
      <label for="memory-limit-input" class="settings-label">Memory Limit</label>
      <input
        id="memory-limit-input"
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
      {#each testcases as testcase, index (testcase.id)}
        <Testcase id={testcase.id} bind:testcase={testcases[index].data} />
      {/each}
      <div class="new-button-wrapper">
        <button class="text-button grow-1" type="button" onclick={handleNewTestcase}>
          <div class="codicon codicon-add"></div>
          New Testcase
        </button>
        <div class="center-everything grow-0 new-button-dropdown-group">
          <div class="new-button-dropdown-separator"></div>
          <button
            aria-label="New Testcase Dropdown"
            type="button"
            onclick={handleToggleDropdown}
            class="text-button new-button-dropdown-icon"
          >
            <div class="codicon codicon-chevron-down"></div>
          </button>
        </div>
      </div>
      {#if showTestcaseDropdown}
        <div class="dropdown-menu">
          <button type="button" class="dropdown-item" onclick={handleNewTestcase}>
            New Testcase
          </button>
          <br />
          <button type="button" class="dropdown-item" onclick={handleNewInteractiveTestcase}>
            New Interactive Testcase
          </button>
        </div>
      {/if}
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

  .new-button-wrapper {
    display: flex;
    margin-top: 8px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-radius: 2px;
  }

  .center-everything {
    display: flex;
    text-align: center;
    cursor: pointer;
    justify-content: center;
    align-items: center;
    gap: 4px;
    flex-grow: 1;
    height: 100%;
  }

  .grow-1 {
    flex-grow: 1;
  }

  .grow-0 {
    flex-grow: 0;
  }

  .new-button-dropdown-separator {
    width: 1px;
    height: 20px;
    background-color: var(--vscode-button-separator);
  }

  .new-button-dropdown-group {
    gap: 0;
  }

  .new-button-dropdown-icon {
    padding-left: 4px;
    padding-right: 0;
  }

  .new-button-dropdown-icon:hover {
    background-color: var(--vscode-button-hoverBackground);
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
