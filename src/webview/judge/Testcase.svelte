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

  function onprerun() {
    newStdin = "";
    newInteractorSecret = "";
    stdinEditing = false;
    acceptedStdoutEditing = false;
    interactorSecretEditing = false;
    handleSaveStdin();
    handleSaveAcceptedStdout();
    handleSaveInteractorSecret();
  }

  function handleExpandStdio(stdio: Stdio) {
    postProviderMessage({ type: "VIEW", id, stdio });
  }

  function handleSaveInteractorSecret() {
    postProviderMessage({
      type: "SAVE",
      id,
      stdio: "INTERACTOR_SECRET",
      data: testcase.interactorSecret,
    });
  }

  function handleSaveStdin() {
    postProviderMessage({ type: "SAVE", id, stdio: "STDIN", data: testcase.stdin });
  }

  function handleSaveAcceptedStdout() {
    postProviderMessage({
      type: "SAVE",
      id,
      stdio: "ACCEPTED_STDOUT",
      data: testcase.acceptedStdout,
    });
  }

  const status = $derived(testcase.status);
  const visible = $derived(testcase.shown);
  const skipped = $derived(testcase.skipped);
  const toggled = $derived(testcase.toggled);
  const showDetails = $derived(!skipped && visible && !(status === "AC" && !toggled));

  let newInteractorSecret = $state("");
  let stdinEditing = $state(false);
  let acceptedStdoutEditing = $state(false);
  let interactorSecretEditing = $state(false);
</script>

{#if status === "CE"}
  <div class="testcase-container">
    <TestcaseToolbar {id} {testcase} {onprerun} />
  </div>
{:else if status === "NA" || status === "AC" || status === "WA" || status === "RE" || status === "TL" || status === "ML"}
  <div class="testcase-container">
    <TestcaseToolbar {id} {testcase} {onprerun} />
    {#if showDetails}
      {#if testcase.mode === "interactive"}
        <AutoresizeTextarea
          bind:value={testcase.interactorSecret}
          bind:editing={interactorSecretEditing}
          placeholder="Interactor secret..."
          variant="interactor-secret"
          onexpand={() => handleExpandStdio("INTERACTOR_SECRET")}
          onpreedit={() => {
            postProviderMessage({ type: "REQUEST_FULL_DATA", id, stdio: "INTERACTOR_SECRET" });
          }}
          onsave={handleSaveInteractorSecret}
          oncancel={() => {
            postProviderMessage({
              type: "REQUEST_TRIMMED_DATA",
              id,
              stdio: "INTERACTOR_SECRET",
            });
          }}
        />
      {/if}
      <AutoresizeTextarea
        bind:value={testcase.stdin}
        bind:editing={stdinEditing}
        placeholder="Stdin..."
        onexpand={() => handleExpandStdio("STDIN")}
        onpreedit={() => {
          postProviderMessage({ type: "REQUEST_FULL_DATA", id, stdio: "STDIN" });
        }}
        onsave={handleSaveStdin}
        oncancel={() => {
          postProviderMessage({ type: "REQUEST_TRIMMED_DATA", id, stdio: "STDIN" });
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
      {#if testcase.mode !== "interactive"}
        <AutoresizeTextarea
          bind:value={testcase.acceptedStdout}
          bind:editing={acceptedStdoutEditing}
          placeholder="Accepted stdout..."
          variant="accepted"
          onexpand={() => handleExpandStdio("ACCEPTED_STDOUT")}
          onpreedit={() => {
            postProviderMessage({ type: "REQUEST_FULL_DATA", id, stdio: "ACCEPTED_STDOUT" });
          }}
          onsave={handleSaveAcceptedStdout}
          oncancel={() => {
            postProviderMessage({
              type: "REQUEST_TRIMMED_DATA",
              id,
              stdio: "ACCEPTED_STDOUT",
            });
          }}
        />
      {/if}
    {/if}
  </div>
{:else if status === "COMPILING"}
  <div class="testcase-container">
    <TestcaseToolbar {id} {testcase} {onprerun} />
  </div>
{:else if status === "RUNNING"}
  <div class="testcase-container">
    <TestcaseToolbar {id} {testcase} {onprerun} />
    {#if visible}
      {#if testcase.mode === "interactive"}
        {#if testcase.interactorSecret === "" || testcase.interactorSecret === "\n"}
          <AutoresizeTextarea
            bind:value={newInteractorSecret}
            placeholder="Interactor secret..."
            variant="interactor-secret"
            onsave={() => {
              postProviderMessage({
                type: "SAVE",
                id,
                stdio: "INTERACTOR_SECRET",
                data: newInteractorSecret,
              });
              newInteractorSecret = "";
            }}
          />
        {:else}
          <AutoresizeTextarea
            value={testcase.interactorSecret}
            readonly
            placeholder="Interactor secret..."
            onexpand={() => handleExpandStdio("INTERACTOR_SECRET")}
            variant="interactor-secret"
          />
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
</style>
