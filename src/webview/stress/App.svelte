<script lang="ts">
  import { onMount } from "svelte";
  import type * as v from "valibot";

  import type { Status, Stdio } from "../../shared/enums";
  import { type StateId, StateIdValue } from "../../shared/schemas";
  import {
    type ClearMessageSchema,
    type ShowMessageSchema,
    type StatusMessageSchema,
    type StdioMessageSchema,
    type WebviewMessage,
    InitMessageSchema,
  } from "../../shared/stress-messages";
  import { postProviderMessage } from "./message";
  import State from "./State.svelte";
  import StateToolbar from "./StateToolbar.svelte";
  import Button from "../Button.svelte";

  type IShowMessage = v.InferOutput<typeof ShowMessageSchema>;
  type IStdioMessage = v.InferOutput<typeof StdioMessageSchema>;

  interface IStateData {
    stdin: string;
    stdout: string;
    stderr: string;
    status: Status;
    id: StateId;
    placeholder: string;
    shown: boolean;
  }

  const placeholderMap: Record<StateId, string> = {
    Generator: "Generator output...",
    Solution: "Solution output...",
    Judge: "Judge output...",
  } as const;

  let states = $state<IStateData[]>(
    StateIdValue.map<IStateData>((id) => ({
      stdin: "",
      stdout: "",
      stderr: "",
      status: "NA",
      id,
      placeholder: placeholderMap[id],
      shown: true,
    }))
  );
  let showView = $state(true);
  let showSettings = $state(false);
  let interactiveMode = $state(false);
  let enforceGeneratorTime = $state(true);
  let enforceSolutionTime = $state(true);
  let enforceJudgeTime = $state(true);
  let enforceGeneratorMemory = $state(true);
  let enforceSolutionMemory = $state(true);
  let enforceJudgeMemory = $state(true);

  function findStateIndex(id: StateId): number {
    return states.findIndex((item) => item.id === id);
  }

  function findState(id: StateId): IStateData | null {
    const index = findStateIndex(id);
    return index !== -1 ? states[index] : null;
  }

  function handleView(id: StateId, stdio: Stdio) {
    postProviderMessage({ type: "VIEW", id, stdio });
  }

  function handleCopy(id: StateId, stdio: Stdio) {
    postProviderMessage({ type: "COPY", id, stdio });
  }

  function handleAdd(id: StateId) {
    postProviderMessage({ type: "ADD", id });
  }

  function handleOpen(id: StateId) {
    postProviderMessage({ type: "OPEN", id });
  }

  function handleInit({
    interactiveMode: mode,
    enforceGeneratorTime: eGT,
    enforceSolutionTime: eST,
    enforceJudgeTime: eJT,
    enforceGeneratorMemory: eGM,
    enforceSolutionMemory: eSM,
    enforceJudgeMemory: eJM,
  }: v.InferOutput<typeof InitMessageSchema>) {
    interactiveMode = mode;
    enforceGeneratorTime = eGT;
    enforceSolutionTime = eST;
    enforceJudgeTime = eJT;
    enforceGeneratorMemory = eGM;
    enforceSolutionMemory = eSM;
    enforceJudgeMemory = eJM;
  }

  function handleStatus({ id, status }: v.InferOutput<typeof StatusMessageSchema>) {
    const state = findState(id);
    if (state) {
      state.status = status;
    }
  }

  function handleStdio({ id, stdio, data }: IStdioMessage) {
    const state = findState(id);
    if (state) {
      switch (stdio) {
        case "STDIN":
          state.stdin += data;
          break;
        case "STDOUT":
          state.stdout += data;
          break;
        case "STDERR":
          state.stderr += data;
          break;
      }
    }
  }

  function handleClear({ id }: v.InferOutput<typeof ClearMessageSchema>) {
    for (const state of states) {
      if (state.id === id) {
        state.stdin = "";
        state.stdout = "";
        state.stderr = "";
      }
    }
  }

  function handleShow({ visible }: IShowMessage) {
    showView = visible;
  }

  function handleSettingsToggle() {
    showSettings = !showSettings;
  }

  function handleSet({ id, property, value }: { id: StateId; property: string; value: unknown }) {
    const state = findState(id);
    if (state && property === "shown") {
      state.shown = value as boolean;
    }
  }

  function handleToggleVisibility(id: StateId) {
    postProviderMessage({ type: "TOGGLE_VISIBILITY", id });
  }

  function handleToggleInteractive() {
    postProviderMessage({ type: "TOGGLE_INTERACTIVE" });
  }

  function handleInteractiveModeChange(e: Event) {
    const target = e.target as HTMLInputElement;
    interactiveMode = target.checked;
  }

  function handleEnforceGeneratorTimeChange(e: Event) {
    const target = e.target as HTMLInputElement;
    enforceGeneratorTime = target.checked;
  }

  function handleEnforceSolutionTimeChange(e: Event) {
    const target = e.target as HTMLInputElement;
    enforceSolutionTime = target.checked;
  }

  function handleEnforceJudgeTimeChange(e: Event) {
    const target = e.target as HTMLInputElement;
    enforceJudgeTime = target.checked;
  }

  function handleEnforceGeneratorMemoryChange(e: Event) {
    const target = e.target as HTMLInputElement;
    enforceGeneratorMemory = target.checked;
  }

  function handleEnforceSolutionMemoryChange(e: Event) {
    const target = e.target as HTMLInputElement;
    enforceSolutionMemory = target.checked;
  }

  function handleEnforceJudgeMemoryChange(e: Event) {
    const target = e.target as HTMLInputElement;
    enforceJudgeMemory = target.checked;
  }

  function handleSaveSettings() {
    handleSettingsToggle();
    postProviderMessage({
      type: "SAVE",
      interactiveMode,
      enforceGeneratorTime,
      enforceSolutionTime,
      enforceJudgeTime,
      enforceGeneratorMemory,
      enforceSolutionMemory,
      enforceJudgeMemory,
    });
  }

  onMount(() => {
    const handleMessage = (event: MessageEvent<WebviewMessage>) => {
      switch (event.data.type) {
        case "INIT":
          handleInit(event.data);
          break;
        case "STATUS":
          handleStatus(event.data);
          break;
        case "STDIO":
          handleStdio(event.data);
          break;
        case "CLEAR":
          handleClear(event.data);
          break;
        case "SHOW":
          handleShow(event.data);
          break;
        case "SETTINGS_TOGGLE":
          handleSettingsToggle();
          break;
        case "SET":
          handleSet(event.data);
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

{#if showView}
  <div class="state-container">
    {#if showSettings}
      <div class="settings-section">
        <div class="checkbox-group">
          <input
            id="interactive-mode-checkbox"
            type="checkbox"
            checked={interactiveMode}
            onchange={handleInteractiveModeChange}
            class="settings-checkbox"
          />
          <label for="interactive-mode-checkbox" class="settings-checkbox-label">
            Interactive Mode
          </label>
        </div>
        <p class="settings-additional-info">
          Enable interactive mode for stress testing with interactive problems.
        </p>
        <div class="settings-group">
          <h4>Time Enforcement</h4>
          <div class="checkbox-group">
            <input
              id="enforce-gen-time"
              type="checkbox"
              checked={enforceGeneratorTime}
              onchange={handleEnforceGeneratorTimeChange}
              class="settings-checkbox"
            />
            <label for="enforce-gen-time" class="settings-checkbox-label"
              >Enforce Generator Time Limit</label
            >
          </div>
          <div class="checkbox-group">
            <input
              id="enforce-sol-time"
              type="checkbox"
              checked={enforceSolutionTime}
              onchange={handleEnforceSolutionTimeChange}
              class="settings-checkbox"
            />
            <label for="enforce-sol-time" class="settings-checkbox-label"
              >Enforce Solution Time Limit</label
            >
          </div>
          <div class="checkbox-group">
            <input
              id="enforce-judge-time"
              type="checkbox"
              checked={enforceJudgeTime}
              onchange={handleEnforceJudgeTimeChange}
              class="settings-checkbox"
            />
            <label for="enforce-judge-time" class="settings-checkbox-label"
              >Enforce Judge Time Limit</label
            >
          </div>

          <h4>Memory Enforcement</h4>
          <div class="checkbox-group">
            <input
              id="enforce-gen-mem"
              type="checkbox"
              checked={enforceGeneratorMemory}
              onchange={handleEnforceGeneratorMemoryChange}
              class="settings-checkbox"
            />
            <label for="enforce-gen-mem" class="settings-checkbox-label"
              >Enforce Generator Memory Limit</label
            >
          </div>
          <div class="checkbox-group">
            <input
              id="enforce-sol-mem"
              type="checkbox"
              checked={enforceSolutionMemory}
              onchange={handleEnforceSolutionMemoryChange}
              class="settings-checkbox"
            />
            <label for="enforce-sol-mem" class="settings-checkbox-label"
              >Enforce Solution Memory Limit</label
            >
          </div>
          <div class="checkbox-group">
            <input
              id="enforce-judge-mem"
              type="checkbox"
              checked={enforceJudgeMemory}
              onchange={handleEnforceJudgeMemoryChange}
              class="settings-checkbox"
            />
            <label for="enforce-judge-mem" class="settings-checkbox-label"
              >Enforce Judge Memory Limit</label
            >
          </div>
        </div>
      </div>
      <Button text="Save" codicon="codicon-save" onclick={handleSaveSettings} />
    {:else}
      {#each states as item (item.id)}
        <div class="state-item">
          <StateToolbar
            id={item.id}
            status={item.status}
            {interactiveMode}
            shown={item.shown}
            onAdd={handleAdd}
            onOpen={handleOpen}
            onToggleVisibility={handleToggleVisibility}
            onToggleInteractive={handleToggleInteractive}
          />
          {#if item.status === "COMPILING"}
            <div class="half-opacity">
              <State
                id={item.id}
                state={item}
                placeholder={item.placeholder}
                {interactiveMode}
                shown={item.shown}
                onView={handleView}
                onCopy={handleCopy}
              />
            </div>
          {:else}
            <State
              id={item.id}
              state={item}
              placeholder={item.placeholder}
              {interactiveMode}
              shown={item.shown}
              onView={handleView}
              onCopy={handleCopy}
            />
          {/if}
        </div>
      {/each}
    {/if}
  </div>
{:else}
  <div id="empty-state">
    <div class="codicon codicon-symbol-event empty-state-icon"></div>
    <p>Open a file to get started</p>
  </div>
{/if}

<style>
  .state-container {
    margin-top: 4px;
    margin-bottom: 24px;
  }

  .state-item {
    margin-bottom: 28px;
  }

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

  /* Settings View */
  .settings-section {
    margin-bottom: 16px;
  }

  .checkbox-group {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .settings-checkbox {
    appearance: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    width: 18px;
    height: 18px;
    cursor: pointer;
    border: 1px solid var(--vscode-checkbox-border, var(--vscode-input-border));
    background: var(--vscode-checkbox-background, var(--vscode-input-background));
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .settings-checkbox:hover {
    background: var(--vscode-checkbox-hoverBackground, var(--vscode-input-background));
    border-color: var(--vscode-checkbox-hoverBorder, var(--vscode-input-border));
  }

  .settings-checkbox:checked {
    background: var(--vscode-checkbox-checkedBackground, var(--vscode-inputOption-activeBorder));
    border-color: var(--vscode-checkbox-checkedBorder, var(--vscode-inputOption-activeBorder));
  }

  .settings-checkbox:checked::after {
    content: "✓";
    color: var(--vscode-checkbox-foreground, white);
    font-weight: bold;
    font-size: 12px;
    display: block;
  }

  .settings-checkbox:focus {
    outline: 1px solid var(--vscode-focusBorder);
  }

  .settings-checkbox-label {
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 13px;
    user-select: none;
    margin-left: 6px;
  }

  .settings-additional-info {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    margin-top: 2px;
    margin-bottom: 16px;
  }

  .settings-group h4 {
    margin: 8px 0 6px;
    font-size: 13px;
    color: var(--vscode-foreground);
    font-weight: 600;
  }

  .settings-group .checkbox-group {
    margin-bottom: 6px;
  }

  .half-opacity {
    opacity: 0.5;
    pointer-events: none;
  }
</style>
