<script lang="ts">
  import type * as v from "valibot";

  import type { TestcaseSchema } from "../../shared/schemas";
  import type { Stdio } from "../../shared/enums";
  import AutoresizeTextarea from "../AutoresizeTextarea.svelte";
  import { postProviderMessage } from "./message";
  import TestcaseToolbar from "./TestcaseToolbar.svelte";

  type ITestcase = v.InferOutput<typeof TestcaseSchema>;

  interface Props {
    id: number;
    testcase: ITestcase;
    updateTestcaseData: (id: number, updates: Partial<ITestcase>) => void;
  }

  let { id, testcase, updateTestcaseData }: Props = $props();
  let newStdin = $state("");
  let newInteractorSecret = $state("");

  function resetStdin() {
    newStdin = "";
  }

  function handleExpandStdio(stdio: Stdio) {
    postProviderMessage({ type: "VIEW", id, stdio });
  }

  function handleNewStdinKeyUp(event: KeyboardEvent) {
    if (event.key === "Enter") {
      postProviderMessage({
        type: "STDIN",
        id,
        data: newStdin,
      });
      newStdin = "";
    }
  }

  function handleStdinChange(value: string) {
    updateTestcaseData(id, { stdin: value });
  }

  function handleAcceptedStdoutChange(value: string) {
    updateTestcaseData(id, { acceptedStdout: value });
  }

  function handleNewInteractorSecretChange(value: string) {
    newInteractorSecret = value;
  }

  function handleNewStdinChange(value: string) {
    newStdin = value;
  }

  function handleSaveInteractorSecret() {
    const interactorSecret = newInteractorSecret;
    newInteractorSecret = "";
    // Clear the secret locally (extension will send back shortened version)
    updateTestcaseData(id, { interactorSecret: "" });
    postProviderMessage({
      type: "SAVE_INTERACTOR_SECRET",
      id,
      secret: interactorSecret,
    });
  }

  // Derived values
  const status = $derived(testcase.status);
  const visible = $derived(testcase.shown);
  const skipped = $derived(testcase.skipped);
  const toggled = $derived(testcase.toggled);
  const showDetails = $derived(!skipped && visible && !(status === "AC" && !toggled));
</script>

{#if status === "CE"}
  <div class="testcase-container">
    <TestcaseToolbar {id} {testcase} {updateTestcaseData} {resetStdin} />
  </div>
{:else if status === "NA" || status === "AC" || status === "WA" || status === "RE" || status === "TL" || status === "ML"}
  <div class="testcase-container">
    <TestcaseToolbar {id} {testcase} {updateTestcaseData} {resetStdin} />
    {#if showDetails}
      {#if testcase.mode === "interactive"}
        <AutoresizeTextarea
          value={testcase.interactorSecret}
          readonly
          hiddenOnEmpty
          placeholder="Interactor secret..."
          onexpand={() => handleExpandStdio("INTERACTOR_SECRET")}
          variant="interactor-secret"
        />
      {/if}
      <AutoresizeTextarea
        value={testcase.stdin}
        readonly
        hiddenOnEmpty
        placeholder="Stdin..."
        onexpand={() => handleExpandStdio("STDIN")}
      />
      <AutoresizeTextarea
        value={testcase.stderr}
        readonly
        hiddenOnEmpty
        placeholder="Stderr..."
        variant="stderr"
        onexpand={() => handleExpandStdio("STDERR")}
      />
      <AutoresizeTextarea
        value={testcase.stdout}
        readonly
        hiddenOnEmpty
        placeholder="Stdout..."
        onexpand={() => handleExpandStdio("STDOUT")}
      />
      {#if status === "WA"}
        <AutoresizeTextarea
          value={testcase.acceptedStdout}
          readonly
          hiddenOnEmpty
          placeholder="Accepted stdout..."
          variant="accepted"
          onexpand={() => handleExpandStdio("ACCEPTED_STDOUT")}
        />
      {/if}
    {/if}
  </div>
{:else if status === "COMPILING"}
  <div class="testcase-container">
    <TestcaseToolbar {id} {testcase} {updateTestcaseData} {resetStdin} />
  </div>
{:else if status === "RUNNING"}
  <div class="testcase-container">
    <TestcaseToolbar {id} {testcase} {updateTestcaseData} {resetStdin} />
    {#if visible}
      {#if testcase.mode === "interactive"}
        <AutoresizeTextarea
          value={testcase.interactorSecret}
          readonly
          hiddenOnEmpty
          placeholder="Interactor secret..."
          onexpand={() => handleExpandStdio("INTERACTOR_SECRET")}
          variant="interactor-secret"
        />
        {#if testcase.interactorSecret === "" || testcase.interactorSecret === "\n"}
          <AutoresizeTextarea
            value={newInteractorSecret}
            placeholder="New interactor secret..."
            onchange={handleNewInteractorSecretChange}
            variant="active"
          />
          <button
            class="interactor-secret-set-button"
            type="button"
            onclick={handleSaveInteractorSecret}
          >
            <div class="codicon codicon-gist-secret"></div>
            Save Secret
          </button>
        {/if}
      {/if}
      {#if testcase.mode !== "interactive" || (testcase.interactorSecret !== "" && testcase.interactorSecret !== "\n")}
        <AutoresizeTextarea
          value={testcase.stdin}
          readonly
          hiddenOnEmpty
          placeholder="Stdin..."
          onexpand={() => handleExpandStdio("STDIN")}
        />
        <AutoresizeTextarea
          value={newStdin}
          placeholder="New stdin..."
          onkeyup={handleNewStdinKeyUp}
          onchange={handleNewStdinChange}
          variant="active"
        />
      {/if}
      <AutoresizeTextarea
        value={testcase.stderr}
        readonly
        hiddenOnEmpty
        placeholder="Stderr..."
        variant="stderr"
        onexpand={() => handleExpandStdio("STDERR")}
      />
      <AutoresizeTextarea value={testcase.stdout} readonly placeholder="Stdout..." />
    {/if}
  </div>
{:else if status === "EDITING"}
  <div class="testcase-container">
    <TestcaseToolbar {id} {testcase} {updateTestcaseData} {resetStdin} />
    <AutoresizeTextarea
      value={testcase.stdin}
      placeholder="Stdin..."
      onchange={handleStdinChange}
      onexpand={() => handleExpandStdio("STDIN")}
    />
    <AutoresizeTextarea
      value={testcase.acceptedStdout}
      placeholder="Accepted stdout..."
      variant="accepted"
      onchange={handleAcceptedStdoutChange}
      onexpand={() => handleExpandStdio("ACCEPTED_STDOUT")}
    />
  </div>
{/if}

<style>
  .testcase-container {
    margin-bottom: 24px;
  }

  .interactor-secret-set-button {
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

  .interactor-secret-set-button:hover {
    background: var(--vscode-button-hoverBackground);
  }

  .interactor-secret-set-button :global(.codicon) {
    margin-right: 4px;
  }
</style>
