<script lang="ts">
  import { onMount, tick } from "svelte";
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
  let draggingUuid = $state<string | null>(null);
  let separatorIndex = $state<number | null>(null);

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

  function reorderTestcasesLocally(sourceUuid: string, targetIndex: number): boolean {
    const sourceIndex = findTestcaseIndex(sourceUuid);
    if (sourceIndex === -1 || sourceIndex === targetIndex) {
      return false;
    }

    const [moved] = testcases.splice(sourceIndex, 1);
    if (!moved) {
      return false;
    }

    const clampedTargetIndex = Math.max(0, Math.min(targetIndex, testcases.length));
    testcases.splice(clampedTargetIndex, 0, moved);
    return true;
  }

  function clearDragState() {
    draggingUuid = null;
    separatorIndex = null;
  }

  function getDropPosition(event: DragEvent, element: HTMLElement): "before" | "after" {
    const bounds = element.getBoundingClientRect();
    const middleY = bounds.top + bounds.height / 2;
    return event.clientY < middleY ? "before" : "after";
  }

  function handleDragStart(uuid: string, event: DragEvent) {
    draggingUuid = uuid;
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) {
      return;
    }
    dataTransfer.setData("text/plain", uuid);
    dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(uuid: string, event: DragEvent) {
    if (!draggingUuid || draggingUuid === uuid) {
      return;
    }
    event.preventDefault();

    const currentTarget = event.currentTarget;
    if (!(currentTarget instanceof HTMLElement)) {
      return;
    }

    const hoveredIndex = findTestcaseIndex(uuid);
    if (hoveredIndex === -1) {
      separatorIndex = null;
      return;
    }

    const position = getDropPosition(event, currentTarget);
    const candidateIndex = position === "before" ? hoveredIndex : hoveredIndex + 1;
    const isValidIndex = candidateIndex >= 0 && candidateIndex <= testcases.length;
    separatorIndex = isValidIndex ? candidateIndex : null;

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  }

  function handleSeparatorDragOver(index: number, event: DragEvent) {
    if (!draggingUuid) {
      return;
    }
    event.preventDefault();
    separatorIndex = index;
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  }

  function resolveDropIndexFromSeparator(
    sourceUuid: string,
    candidateIndex: number
  ): number | null {
    const sourceIndex = findTestcaseIndex(sourceUuid);
    if (sourceIndex === -1) {
      return null;
    }

    if (sourceIndex < candidateIndex) {
      return candidateIndex - 1;
    }
    return candidateIndex;
  }

  function commitReorder(sourceUuid: string, targetIndex: number) {
    if (!reorderTestcasesLocally(sourceUuid, targetIndex)) {
      return;
    }
    postProviderMessage({ type: "REORDER", sourceUuid, targetIndex });
  }

  function handleDrop(event: DragEvent) {
    if (!draggingUuid || separatorIndex === null) {
      clearDragState();
      return;
    }
    event.preventDefault();

    const targetIndex = resolveDropIndexFromSeparator(draggingUuid, separatorIndex);
    if (targetIndex !== null) {
      commitReorder(draggingUuid, targetIndex);
    }
    clearDragState();
  }

  function handleContainerDragOver(event: DragEvent) {
    if (!draggingUuid) {
      return;
    }
    event.preventDefault();

    const currentTarget = event.currentTarget;
    if (!(currentTarget instanceof HTMLElement)) {
      return;
    }

    const targetElement = event.target;
    if (targetElement instanceof HTMLElement && targetElement.closest(".testcase-item")) {
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      return;
    }

    const testcaseElements = currentTarget.querySelectorAll<HTMLElement>(".testcase-item");
    if (testcaseElements.length > 0) {
      const firstRect = testcaseElements[0]?.getBoundingClientRect();
      const lastRect = testcaseElements[testcaseElements.length - 1]?.getBoundingClientRect();
      if (firstRect && event.clientY < firstRect.top) {
        separatorIndex = 0;
      } else if (lastRect && event.clientY > lastRect.bottom) {
        separatorIndex = testcases.length;
      }
    }

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  }

  function isEditableTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    return target.closest("textarea, input, [contenteditable='true']") !== null;
  }

  async function focusTestcaseItem(uuid: string) {
    await tick();
    const testcaseElement = document.querySelector<HTMLElement>(
      `.testcase-item[data-uuid="${uuid}"] .toolbar-icon--drag`
    );
    testcaseElement?.focus();
  }

  function handleTestcaseKeydown(uuid: string, event: KeyboardEvent) {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
      return;
    }
    if (isEditableTarget(event.target)) {
      return;
    }

    const currentIndex = findTestcaseIndex(uuid);
    if (currentIndex === -1) {
      return;
    }

    let targetIndex: number | null = null;
    if (event.key === "ArrowUp" && currentIndex > 0) {
      targetIndex = currentIndex - 1;
    } else if (event.key === "ArrowDown" && currentIndex < testcases.length - 1) {
      targetIndex = currentIndex + 1;
    }

    if (targetIndex === null) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    commitReorder(uuid, targetIndex);
    void focusTestcaseItem(uuid);
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
    <div
      class="testcase-container"
      role="list"
      ondragover={handleContainerDragOver}
      ondrop={handleDrop}
    >
      {#if testcases.length > 0 && separatorIndex === 0}
        <div
          class="testcase-gap-row"
          role="separator"
          ondragover={(event) => handleSeparatorDragOver(0, event)}
        >
          <div class="testcase-drop-indicator"></div>
        </div>
      {/if}
      {#each testcases as testcase, index (testcase.uuid)}
        {#if index > 0}
          <div
            class="testcase-gap-row"
            role="separator"
            ondragover={(event) => handleSeparatorDragOver(index, event)}
          >
            {#if separatorIndex === index}
              <div class="testcase-drop-indicator"></div>
            {/if}
          </div>
        {/if}
        <div
          class="testcase-item"
          class:testcase-item--dragging={draggingUuid === testcase.uuid}
          data-uuid={testcase.uuid}
          role="listitem"
          ondragover={(event) => handleDragOver(testcase.uuid, event)}
        >
          <TestcaseToolbar
            {testcase}
            onprerun={() => handlePrerun(testcase.uuid)}
            ondragstart={(event) => handleDragStart(testcase.uuid, event)}
            ondragend={clearDragState}
            ondragkeydown={(event) => handleTestcaseKeydown(testcase.uuid, event)}
          />
          {#if testcase.status === "COMPILING" || testcase.skipped}
            <div class="half-opacity">
              <Testcase bind:testcase={testcases[index]} bind:this={testcaseRefs[testcase.uuid]} />
            </div>
          {:else}
            <Testcase bind:testcase={testcases[index]} bind:this={testcaseRefs[testcase.uuid]} />
          {/if}
        </div>
      {/each}
      {#if testcases.length > 0 && separatorIndex === testcases.length}
        <div
          class="testcase-gap-row"
          role="separator"
          ondragover={(event) => handleSeparatorDragOver(testcases.length, event)}
        >
          <div class="testcase-drop-indicator"></div>
        </div>
      {/if}
    </div>
    <ButtonDropdown
      text="New Testcase"
      codicon="codicon-add"
      onclick={handleNewTestcase}
      options={[
        { text: "New Testcase", onclick: handleNewTestcase },
        { text: "New Interactive Testcase", onclick: handleNewInteractiveTestcase },
      ]}
    />
  {/if}
{:else}
  <div id="empty-state">
    <div class="codicon codicon-symbol-event empty-state-icon"></div>
    <p class="empty-state-text">Open a file to get started</p>
  </div>
{/if}

<style>
  .testcase-item--dragging {
    opacity: 0.5;
  }

  .testcase-drop-indicator {
    width: 100%;
    height: 2px;
    border-radius: 999px;
    background: var(--vscode-focusBorder);
    pointer-events: none;
  }

  .testcase-gap-row {
    height: var(--testcase-row-gap);
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .testcase-item {
    min-width: 0;
    width: 100%;
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
    border-radius: 4px;
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
    --testcase-row-gap: 24px;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    width: 100%;
    min-width: 0;
    row-gap: 0;
    margin-top: 4px;
    margin-bottom: 24px;
  }

  .half-opacity {
    opacity: 0.5;
    pointer-events: none;
  }
</style>
