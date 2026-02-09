<script lang="ts">
  import { onMount } from "svelte";
  import type * as v from "valibot";

  import type { Testcase as TestcaseType } from "../../shared/schemas";
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
  import TestcaseToolbar from "./TestcaseToolbar.svelte";
  import Button from "../Button.svelte";
  import ButtonDropdown from "../ButtonDropdown.svelte";

  // Reactive state using Svelte 5 runes
  let testcases = $state<TestcaseType[]>([]);
  let newTimeLimit = $state(0);
  let newMemoryLimit = $state(0);
  let show = $state(true);
  let showSettings = $state(false);
  let testcaseRefs = $state<Record<string, { reset: () => void }>>({});

  // Helper to find testcase by uuid
  function findTestcaseIndex(uuid: string): number {
    return testcases.findIndex((t) => t.uuid === uuid);
  }

  // Message handlers
  function handleNew({ uuid }: v.InferOutput<typeof NewMessageSchema>) {
    const existing = findTestcaseIndex(uuid);
    if (existing === -1) {
      testcases.push({
        uuid,
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
      });
    }
  }

  function handleSet({ uuid, property, value }: v.InferOutput<typeof SetMessageSchema>) {
    const idx = findTestcaseIndex(uuid);
    if (idx !== -1) {
      (testcases[idx] as unknown as Record<string, unknown>)[property] = value;
    }
  }

  function handleStdio({ uuid, data, stdio }: v.InferOutput<typeof StdioMessageSchema>) {
    const idx = findTestcaseIndex(uuid);
    if (idx === -1) return;
    const tc = testcases[idx];
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

  function handleDelete({ uuid }: v.InferOutput<typeof DeleteMessageSchema>) {
    const idx = findTestcaseIndex(uuid);
    if (idx !== -1) {
      testcases.splice(idx, 1);
    }
  }

  function handleShow({ visible }: v.InferOutput<typeof ShowMessageSchema>) {
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
    postProviderMessage({ type: "NEXT", mode: "standard" });
    (e.currentTarget as HTMLElement | null)?.blur();
  }

  function handleNewInteractiveTestcase(e: Event) {
    postProviderMessage({ type: "NEXT", mode: "interactive" });
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

  function handlePrerun(uuid: string) {
    if (testcaseRefs[uuid]) {
      testcaseRefs[uuid].reset();
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
    <Button text="Save" codicon="codicon-save" onclick={handleSaveSettings} />
  {:else}
    <div class="testcase-container">
      {#each testcases as testcase, index (testcase.uuid)}
        <div class="testcase-item">
          <TestcaseToolbar {testcase} onprerun={() => handlePrerun(testcase.uuid)} />
          {#if testcase.status === "COMPILING" || testcase.skipped}
            <div class="half-opacity">
              <Testcase bind:testcase={testcases[index]} bind:this={testcaseRefs[testcase.uuid]} />
            </div>
          {:else}
            <Testcase bind:testcase={testcases[index]} bind:this={testcaseRefs[testcase.uuid]} />
          {/if}
        </div>
      {/each}
      <ButtonDropdown
        text="New Testcase"
        codicon="codicon-add"
        onclick={handleNewTestcase}
        options={[
          { text: "New Testcase", onclick: handleNewTestcase },
          { text: "New Interactive Testcase", onclick: handleNewInteractiveTestcase },
        ]}
      />
    </div>
  {/if}
{:else}
  <div id="empty-state">
    <div class="codicon codicon-symbol-event empty-state-icon"></div>
    <p class="empty-state-text">Open a file to get started</p>
  </div>
{/if}

<style>
  .testcase-item {
    margin-bottom: 24px;
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

  .half-opacity {
    opacity: 0.5;
    pointer-events: none;
  }
</style>
