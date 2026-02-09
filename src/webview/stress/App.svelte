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

  function handleAdd(id: StateId) {
    postProviderMessage({ type: "ADD", id });
  }

  function handleOpen(id: StateId) {
    postProviderMessage({ type: "OPEN", id });
  }

  function handleInit({ interactiveMode: mode }: v.InferOutput<typeof InitMessageSchema>) {
    interactiveMode = mode;
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

  function handleSaveSettings() {
    handleSettingsToggle();
    postProviderMessage({ type: "SAVE", interactiveMode });
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
  }

  .settings-additional-info {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    margin-top: 2px;
    margin-bottom: 16px;
  }

  .half-opacity {
    opacity: 0.5;
    pointer-events: none;
  }
</style>
