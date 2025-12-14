<script lang="ts">
  import type * as v from "valibot";

  import type { TestcaseSchema } from "~shared/schemas";
  import { Status, Stdio } from "~shared/enums";
  import AutoresizeTextarea from "../AutoresizeTextarea.svelte";
  import { Action, ProviderMessageType } from "~shared/judge-messages";
  import { postProviderMessage } from "./message";

  type ITestcase = v.InferOutput<typeof TestcaseSchema>;

  interface Props {
    id: number;
    testcase: ITestcase;
    updateTestcaseData: (id: number, updates: Partial<ITestcase>) => void;
  }

  let { id, testcase, updateTestcaseData }: Props = $props();

  let newStdin = $state("");

  function handleSave() {
    const stdin = testcase.stdin;
    const acceptedStdout = testcase.acceptedStdout;
    // Clear the values locally (extension will send back shortened version)
    updateTestcaseData(id, { stdin: "", acceptedStdout: "" });
    postProviderMessage({
      type: ProviderMessageType.SAVE,
      id,
      stdin,
      acceptedStdout,
    });
  }

  function handleExpandStdio(stdio: Stdio) {
    postProviderMessage({ type: ProviderMessageType.VIEW, id, stdio });
  }

  function handleNewStdinKeyUp(event: KeyboardEvent) {
    if (event.key === "Enter") {
      postProviderMessage({
        type: ProviderMessageType.STDIN,
        id,
        data: newStdin,
      });
      newStdin = "";
    }
  }

  function handleAction(action: Action) {
    postProviderMessage({ type: ProviderMessageType.ACTION, id, action });
  }

  function handleRun() {
    newStdin = "";
    handleAction(Action.RUN);
  }

  function handleDebug() {
    newStdin = "";
    handleAction(Action.DEBUG);
  }

  function handleEdit() {
    handleAction(Action.EDIT);
  }

  function handleDelete() {
    handleAction(Action.DELETE);
  }

  function handleAccept() {
    handleAction(Action.ACCEPT);
  }

  function handleDecline() {
    handleAction(Action.DECLINE);
  }

  function handleToggleVisibility() {
    handleAction(Action.TOGGLE_VISIBILITY);
  }

  function handleToggleSkip() {
    handleAction(Action.TOGGLE_SKIP);
  }

  function handleStop() {
    handleAction(Action.STOP);
  }

  function handleCompare() {
    handleAction(Action.COMPARE);
  }

  // Update testcase fields when child component changes them
  function handleStdinChange(value: string) {
    updateTestcaseData(id, { stdin: value });
  }

  function handleAcceptedStdoutChange(value: string) {
    updateTestcaseData(id, { acceptedStdout: value });
  }

  function handleNewStdinChange(value: string) {
    newStdin = value;
  }

  // Derived values
  const status = $derived(testcase.status);
  const visible = $derived(testcase.shown);
  const skipped = $derived(testcase.skipped);
  const toggled = $derived(testcase.toggled);
  const showDetails = $derived(!skipped && visible && !(status === Status.AC && !toggled));
</script>

{#if status === Status.CE}
  <div class="testcase-container">
    <div class="testcase-toolbar" class:testcase-toolbar--hidden={skipped}>
      <div class="testcase-toolbar-left">
        <strong class="testcase-elapsed" data-status={status}>CE</strong>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="testcase-toolbar-icon" onclick={handleRun}>
          <div class="codicon codicon-run-below"></div>
        </div>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="testcase-toolbar-icon" onclick={handleDebug}>
          <div class="codicon codicon-debug-alt"></div>
        </div>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="testcase-toolbar-icon" onclick={handleEdit}>
          <div class="codicon codicon-edit"></div>
        </div>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="testcase-toolbar-icon" onclick={handleDelete}>
          <div class="codicon codicon-trash"></div>
        </div>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="testcase-toolbar-icon" onclick={handleToggleVisibility}>
          <div class="codicon {showDetails ? 'codicon-eye-closed' : 'codicon-eye'}"></div>
        </div>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div
          class="testcase-toolbar-icon testcase-toolbar-icon--visibility"
          onclick={handleToggleSkip}
        >
          <div
            class="codicon {skipped ? 'codicon-debug-connected' : 'codicon-debug-disconnect'}"
          ></div>
        </div>
      </div>
    </div>
  </div>
{:else if status === Status.NA || status === Status.AC || status === Status.WA || status === Status.RE || status === Status.TL}
  <div class="testcase-container">
    <div class="testcase-toolbar" class:testcase-toolbar--hidden={skipped}>
      <div class="testcase-toolbar-left">
        <strong class="testcase-elapsed" data-status={status}>
          {testcase.elapsed}ms
        </strong>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="testcase-toolbar-icon" onclick={handleRun}>
          <div class="codicon codicon-run-below"></div>
        </div>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="testcase-toolbar-icon" onclick={handleDebug}>
          <div class="codicon codicon-debug-alt"></div>
        </div>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="testcase-toolbar-icon" onclick={handleEdit}>
          <div class="codicon codicon-edit"></div>
        </div>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="testcase-toolbar-icon" onclick={handleDelete}>
          <div class="codicon codicon-trash"></div>
        </div>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="testcase-toolbar-icon" onclick={handleToggleVisibility}>
          <div class="codicon {showDetails ? 'codicon-eye-closed' : 'codicon-eye'}"></div>
        </div>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div
          class="testcase-toolbar-icon testcase-toolbar-icon--visibility"
          onclick={handleToggleSkip}
        >
          <div
            class="codicon {skipped ? 'codicon-debug-connected' : 'codicon-debug-disconnect'}"
          ></div>
        </div>
      </div>
      <div class="testcase-toolbar-right">
        {#if status === Status.NA || status === Status.WA}
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div class="testcase-toolbar-icon" onclick={handleAccept}>
            <div class="codicon codicon-pass"></div>
          </div>
        {/if}
        {#if status === Status.AC}
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div class="testcase-toolbar-icon" onclick={handleDecline}>
            <div class="codicon codicon-close"></div>
          </div>
        {/if}
        {#if status === Status.WA}
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div class="testcase-toolbar-icon" onclick={handleCompare}>
            <div class="codicon codicon-diff-single"></div>
          </div>
        {/if}
      </div>
    </div>
    {#if showDetails}
      <AutoresizeTextarea
        value={testcase.stdin}
        readonly
        hiddenOnEmpty
        placeholder="Stdin..."
        onexpand={() => handleExpandStdio(Stdio.STDIN)}
      />
      <AutoresizeTextarea
        value={testcase.stderr}
        readonly
        hiddenOnEmpty
        placeholder="Stderr..."
        variant="stderr"
        onexpand={() => handleExpandStdio(Stdio.STDERR)}
      />
      <AutoresizeTextarea
        value={testcase.stdout}
        readonly
        hiddenOnEmpty
        placeholder="Stdout..."
        onexpand={() => handleExpandStdio(Stdio.STDOUT)}
      />
      {#if status === Status.WA}
        <AutoresizeTextarea
          value={testcase.acceptedStdout}
          readonly
          hiddenOnEmpty
          placeholder="Accepted stdout..."
          variant="accepted"
          onexpand={() => handleExpandStdio(Stdio.ACCEPTED_STDOUT)}
        />
      {/if}
    {/if}
  </div>
{:else if status === Status.COMPILING}
  <div class="testcase-container">
    <div class="testcase-toolbar">
      <div class="testcase-toolbar-left">
        <strong class="testcase-elapsed" data-status={status}> COMPILING </strong>
        <div class="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
          <div class="codicon codicon-loading codicon-modifier-spin"></div>
        </div>
      </div>
    </div>
  </div>
{:else if status === Status.RUNNING}
  <div class="testcase-container">
    <div class="testcase-toolbar">
      <div class="testcase-toolbar-left">
        <div class="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
          <div class="codicon codicon-loading codicon-modifier-spin"></div>
        </div>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="testcase-toolbar-icon" onclick={handleStop}>
          <div class="codicon codicon-stop-circle"></div>
        </div>
      </div>
    </div>
    {#if visible}
      <AutoresizeTextarea
        value={testcase.stdin}
        readonly
        hiddenOnEmpty
        placeholder="Stdin..."
        onexpand={() => handleExpandStdio(Stdio.STDIN)}
      />
      <AutoresizeTextarea
        value={newStdin}
        placeholder="New stdin..."
        onkeyup={handleNewStdinKeyUp}
        onchange={handleNewStdinChange}
        variant="active"
      />
      <AutoresizeTextarea
        value={testcase.stderr}
        readonly
        hiddenOnEmpty
        placeholder="Stderr..."
        variant="stderr"
        onexpand={() => handleExpandStdio(Stdio.STDERR)}
      />
      <AutoresizeTextarea value={testcase.stdout} readonly placeholder="Stdout..." />
    {/if}
  </div>
{:else if status === Status.EDITING}
  <div class="testcase-container">
    <div class="testcase-toolbar">
      <div class="testcase-toolbar-left">
        <div class="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
          <div class="codicon codicon-sync codicon-modifier-spin"></div>
        </div>
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="testcase-toolbar-icon" onclick={handleSave}>
          <div class="codicon codicon-save"></div>
        </div>
      </div>
    </div>
    <AutoresizeTextarea
      value={testcase.stdin}
      placeholder="Stdin..."
      onchange={handleStdinChange}
      onexpand={() => handleExpandStdio(Stdio.STDIN)}
    />
    <AutoresizeTextarea
      value={testcase.acceptedStdout}
      placeholder="Accepted stdout..."
      variant="accepted"
      onchange={handleAcceptedStdoutChange}
      onexpand={() => handleExpandStdio(Stdio.ACCEPTED_STDOUT)}
    />
  </div>
{/if}

<style>
  .testcase-toolbar {
    display: flex;
    align-items: center;
    margin-bottom: 6px;
  }

  .testcase-toolbar--hidden > :global(*) > :global(*:not(.testcase-toolbar-icon--visibility)) {
    opacity: 0.5;
  }

  .testcase-toolbar-left {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 6px;
  }

  .testcase-toolbar-right {
    display: flex;
    align-items: center;
    margin-left: auto;
    justify-content: flex-end;
    gap: 6px;
  }

  .testcase-toolbar-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    align-self: stretch;
    border-radius: 2px;
    padding: 3px;
  }

  .testcase-toolbar-icon:not(.testcase-toolbar-icon-exclude-highlight):hover {
    background: var(--vscode-button-secondaryBackground);
  }

  .testcase-container {
    margin-bottom: 24px;
  }

  .testcase-elapsed {
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
  .testcase-elapsed[data-status="0"] {
    background-color: var(--vscode-terminal-ansiMagenta);
  }

  /* RE=1 */
  .testcase-elapsed[data-status="1"] {
    background-color: var(--vscode-terminal-ansiRed);
  }

  /* WA=2 */
  .testcase-elapsed[data-status="2"] {
    background-color: var(--vscode-terminal-ansiRed);
  }

  /* AC=3 */
  .testcase-elapsed[data-status="3"] {
    background-color: var(--vscode-terminal-ansiGreen);
  }

  /* TL=5 */
  .testcase-elapsed[data-status="5"] {
    background-color: var(--vscode-terminal-ansiRed);
  }
</style>
