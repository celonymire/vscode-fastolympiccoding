<script lang="ts">
  import type { Stdio } from "../../shared/enums";
  import type { Testcase } from "../../shared/schemas";
  import AutoresizeTextarea from "../AutoresizeTextarea.svelte";
  import { postProviderMessage } from "./message";
  import TestcaseToolbar from "./TestcaseToolbar.svelte";

  interface Props {
    testcase: Testcase;
  }

  let { testcase = $bindable() }: Props = $props();
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
    postProviderMessage({ type: "VIEW", uuid: testcase.uuid, stdio });
  }

  function handleSaveInteractorSecret() {
    postProviderMessage({
      type: "SAVE",
      uuid: testcase.uuid,
      stdio: "INTERACTOR_SECRET",
      data: testcase.interactorSecret,
    });
  }

  function handleSaveStdin() {
    postProviderMessage({
      type: "SAVE",
      uuid: testcase.uuid,
      stdio: "STDIN",
      data: testcase.stdin,
    });
  }

  function handleSaveAcceptedStdout() {
    postProviderMessage({
      type: "SAVE",
      uuid: testcase.uuid,
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

{#if status === "NA" || status === "AC" || status === "WA" || status === "RE" || status === "TL" || status === "ML" || status === "CE"}
  <div class="testcase-container">
    <TestcaseToolbar {testcase} {onprerun} />
    {#if showDetails}
      {#if status !== "CE"}
        {#if testcase.mode === "interactive"}
          <AutoresizeTextarea
            bind:value={testcase.interactorSecret}
            bind:editing={interactorSecretEditing}
            placeholder="Interactor secret..."
            variant="interactor-secret"
            onexpand={() => handleExpandStdio("INTERACTOR_SECRET")}
            onpreedit={() => {
              postProviderMessage({
                type: "REQUEST_FULL_DATA",
                uuid: testcase.uuid,
                stdio: "INTERACTOR_SECRET",
              });
            }}
            onsave={handleSaveInteractorSecret}
            oncancel={() => {
              postProviderMessage({
                type: "REQUEST_TRIMMED_DATA",
                uuid: testcase.uuid,
                stdio: "INTERACTOR_SECRET",
              });
            }}
          />
        {/if}
        <AutoresizeTextarea
          bind:value={testcase.stdin}
          bind:editing={stdinEditing}
          placeholder="Input..."
          readonly={testcase.mode === "interactive"}
          onexpand={() => handleExpandStdio("STDIN")}
          onpreedit={() => {
            postProviderMessage({ type: "REQUEST_FULL_DATA", uuid: testcase.uuid, stdio: "STDIN" });
          }}
          onsave={handleSaveStdin}
          oncancel={() => {
            postProviderMessage({
              type: "REQUEST_TRIMMED_DATA",
              uuid: testcase.uuid,
              stdio: "STDIN",
            });
          }}
        />
        <AutoresizeTextarea
          value={testcase.stderr}
          readonly
          hiddenOnEmpty
          variant="stderr"
          onexpand={() => handleExpandStdio("STDERR")}
        />
        {#if testcase.mode === "interactive" || testcase.status !== "AC"}
          <AutoresizeTextarea
            value={testcase.stdout}
            readonly
            hiddenOnEmpty
            onexpand={() => handleExpandStdio("STDOUT")}
          >
            {#snippet actions()}
              {#if (status === "NA" || status === "WA") && testcase.mode !== "interactive"}
                <button
                  class="action-button action-button--always-visible codicon codicon-pass"
                  data-tooltip="Accept Output"
                  aria-label="Accept"
                  onclick={() =>
                    postProviderMessage({ type: "ACTION", uuid: testcase.uuid, action: "ACCEPT" })}
                ></button>
              {/if}
              {#if status === "WA" && testcase.mode !== "interactive"}
                <button
                  class="action-button action-button--always-visible codicon codicon-diff-single"
                  data-tooltip="Compare Answers"
                  aria-label="Compare"
                  onclick={() =>
                    postProviderMessage({ type: "ACTION", uuid: testcase.uuid, action: "COMPARE" })}
                ></button>
              {/if}
            {/snippet}
          </AutoresizeTextarea>
        {/if}
        {#if testcase.mode !== "interactive"}
          <AutoresizeTextarea
            bind:value={testcase.acceptedStdout}
            bind:editing={acceptedStdoutEditing}
            placeholder="Accepted output..."
            variant="accepted"
            onexpand={() => handleExpandStdio("ACCEPTED_STDOUT")}
            onpreedit={() => {
              postProviderMessage({
                type: "REQUEST_FULL_DATA",
                uuid: testcase.uuid,
                stdio: "ACCEPTED_STDOUT",
              });
            }}
            onsave={handleSaveAcceptedStdout}
            oncancel={() => {
              postProviderMessage({
                type: "REQUEST_TRIMMED_DATA",
                uuid: testcase.uuid,
                stdio: "ACCEPTED_STDOUT",
              });
            }}
          >
            {#snippet actions()}
              {#if status === "AC" && testcase.mode !== "interactive"}
                <button
                  class="action-button action-button--always-visible codicon codicon-close"
                  data-tooltip="Decline Answer"
                  aria-label="Decline"
                  onclick={() =>
                    postProviderMessage({ type: "ACTION", uuid: testcase.uuid, action: "DECLINE" })}
                ></button>
              {/if}
            {/snippet}
          </AutoresizeTextarea>
        {/if}
      {:else}
        <AutoresizeTextarea
          value={testcase.stderr}
          readonly
          hiddenOnEmpty
          variant="stderr"
          onexpand={() => handleExpandStdio("STDERR")}
        />
        <AutoresizeTextarea
          value={testcase.stdout}
          readonly
          hiddenOnEmpty
          onexpand={() => handleExpandStdio("STDOUT")}
        />
      {/if}
    {/if}
  </div>
{:else if status === "COMPILING"}
  <div class="testcase-container">
    <TestcaseToolbar {testcase} {onprerun} />
  </div>
{:else if status === "RUNNING"}
  <div class="testcase-container">
    <TestcaseToolbar {testcase} {onprerun} />
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
                uuid: testcase.uuid,
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
          onexpand={() => handleExpandStdio("STDIN")}
        />
        <AutoresizeTextarea
          bind:value={newStdin}
          placeholder="Online input..."
          ctrlEnterNewline={true}
          onkeyup={(e) => {
            if (e.key === "Enter" && !e.ctrlKey) {
              postProviderMessage({ type: "STDIN", uuid: testcase.uuid, data: newStdin });
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
        variant="stderr"
        onexpand={() => handleExpandStdio("STDERR")}
      />
      {#if testcase.mode !== "interactive" || (testcase.interactorSecret !== "" && testcase.interactorSecret !== "\n")}
        <AutoresizeTextarea value={testcase.stdout} readonly placeholder="Output..." />
      {/if}
    {/if}
  </div>
{/if}

<style>
  .testcase-container {
    margin-bottom: 24px;
  }
</style>
