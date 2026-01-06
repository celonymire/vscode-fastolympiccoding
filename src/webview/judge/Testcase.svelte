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
  }

  let { id, testcase = $bindable() }: Props = $props();
  let newStdin = $state("");
  let newInteractorSecret = $state("");

  function resetStdin() {
    newStdin = "";
  }

  function handleExpandStdio(stdio: Stdio) {
    postProviderMessage({ type: "VIEW", id, stdio });
  }

  function handleSaveInteractorSecret() {
    const interactorSecret = newInteractorSecret;
    newInteractorSecret = "";
    postProviderMessage({
      type: "SAVE",
      id,
      stdio: "INTERACTOR_SECRET",
      data: interactorSecret,
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
    <TestcaseToolbar {id} {testcase} {resetStdin} />
  </div>
{:else if status === "NA" || status === "AC" || status === "WA" || status === "RE" || status === "TL" || status === "ML"}
  <div class="testcase-container">
    <TestcaseToolbar {id} {testcase} {resetStdin} />
    {#if showDetails}
      {#if testcase.mode === "interactive"}
        <AutoresizeTextarea
          bind:value={testcase.interactorSecret}
          placeholder="Interactor secret..."
          variant="interactor-secret"
          onexpand={() => handleExpandStdio("INTERACTOR_SECRET")}
          onsave={() => {
            postProviderMessage({
              type: "SAVE",
              id,
              stdio: "INTERACTOR_SECRET",
              data: testcase.interactorSecret,
            });
          }}
        />
      {/if}
      <AutoresizeTextarea
        bind:value={testcase.stdin}
        placeholder="Stdin..."
        onexpand={() => handleExpandStdio("STDIN")}
        onpreedit={() => {
          postProviderMessage({ type: "REQUEST_DATA", id, stdio: "STDIN" });
        }}
        onsave={() => {
          postProviderMessage({ type: "SAVE", id, stdio: "STDIN", data: testcase.stdin });
        }}
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
      <AutoresizeTextarea
        bind:value={testcase.acceptedStdout}
        placeholder="Accepted stdout..."
        variant="accepted"
        onexpand={() => handleExpandStdio("ACCEPTED_STDOUT")}
        onpreedit={() => {
          postProviderMessage({ type: "REQUEST_DATA", id, stdio: "ACCEPTED_STDOUT" });
        }}
        onsave={() => {
          postProviderMessage({
            type: "SAVE",
            id,
            stdio: "ACCEPTED_STDOUT",
            data: testcase.acceptedStdout,
          });
        }}
      />
    {/if}
  </div>
{:else if status === "COMPILING"}
  <div class="testcase-container">
    <TestcaseToolbar {id} {testcase} {resetStdin} />
  </div>
{:else if status === "RUNNING"}
  <div class="testcase-container">
    <TestcaseToolbar {id} {testcase} {resetStdin} />
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
            bind:value={newInteractorSecret}
            placeholder="New interactor secret..."
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
          bind:value={newStdin}
          placeholder="New stdin..."
          onkeyup={(e) => {
            if (e.key === "Enter") {
              postProviderMessage({ type: "STDIN", id, data: newStdin });
              newStdin = "";
            }
          }}
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
