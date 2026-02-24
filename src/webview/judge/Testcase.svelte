<script lang="ts">
  import type { Stdio } from "../../shared/enums";
  import type { Testcase } from "../../shared/schemas";
  import AutoresizeTextarea from "../AutoresizeTextarea.svelte";
  import { postProviderMessage } from "./message";

  interface Props {
    testcase: Testcase;
  }

  let { testcase = $bindable() }: Props = $props();
  let newStdin = $state("");
  let newInteractorSecret = $state("");
  let stdinEditing = $state(false);
  let acceptedStdoutEditing = $state(false);
  let interactorSecretEditing = $state(false);

  function handleExpandStdio(stdio: Stdio) {
    postProviderMessage({ type: "VIEW", uuid: testcase.uuid, stdio });
  }

  function handleCopyStdio(stdio: Stdio) {
    postProviderMessage({ type: "COPY", uuid: testcase.uuid, stdio });
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
  const toggled = $derived(testcase.toggled);
  const showDetails = $derived(visible && !(status === "AC" && !toggled));

  export function reset() {
    newStdin = "";
    newInteractorSecret = "";
    if (stdinEditing) {
      stdinEditing = false;
      handleSaveStdin();
    }
    if (acceptedStdoutEditing) {
      acceptedStdoutEditing = false;
      handleSaveAcceptedStdout();
    }
    if (interactorSecretEditing) {
      interactorSecretEditing = false;
      handleSaveInteractorSecret();
    }
  }
</script>

{#if showDetails}
  {#if status === "NA" || status === "AC" || status === "WA" || status === "RE" || status === "TL" || status === "ML" || status === "CE" || status === "COMPILING"}
    {#if status !== "CE"}
      {#if testcase.mode === "interactive"}
        <AutoresizeTextarea
          bind:value={testcase.interactorSecret}
          bind:editing={interactorSecretEditing}
          placeholder="Interactor secret..."
          variant="interactor-secret"
          onexpand={() => handleExpandStdio("INTERACTOR_SECRET")}
          oncopy={() => handleCopyStdio("INTERACTOR_SECRET")}
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
        hiddenOnEmpty={testcase.mode === "interactive"}
        readonly={testcase.mode === "interactive"}
        onexpand={() => handleExpandStdio("STDIN")}
        oncopy={() => handleCopyStdio("STDIN")}
        onpreedit={() => {
          postProviderMessage({
            type: "REQUEST_FULL_DATA",
            uuid: testcase.uuid,
            stdio: "STDIN",
          });
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
        oncopy={() => handleCopyStdio("STDERR")}
      />
      {#if testcase.mode === "interactive" || testcase.status !== "AC"}
        <AutoresizeTextarea
          value={testcase.stdout}
          readonly
          placeholder="Output..."
          onexpand={() => handleExpandStdio("STDOUT")}
          oncopy={() => handleCopyStdio("STDOUT")}
        >
          {#snippet actions()}
            {#if (status === "NA" || status === "WA") && testcase.mode !== "interactive"}
              <button
                class="action-button action-button--always-visible codicon codicon-pass"
                data-tooltip="Accept Output"
                aria-label="Accept"
                onclick={() =>
                  postProviderMessage({
                    type: "ACTION",
                    uuid: testcase.uuid,
                    action: "ACCEPT",
                  })}
              ></button>
            {/if}
            {#if status === "WA" && testcase.mode !== "interactive"}
              <button
                class="action-button action-button--always-visible codicon codicon-diff-single"
                data-tooltip="Compare Answers"
                aria-label="Compare"
                onclick={() =>
                  postProviderMessage({
                    type: "ACTION",
                    uuid: testcase.uuid,
                    action: "COMPARE",
                  })}
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
          oncopy={() => handleCopyStdio("ACCEPTED_STDOUT")}
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
                  postProviderMessage({
                    type: "ACTION",
                    uuid: testcase.uuid,
                    action: "DECLINE",
                  })}
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
        oncopy={() => handleCopyStdio("STDERR")}
      />
      <AutoresizeTextarea
        value={testcase.stdout}
        readonly
        hiddenOnEmpty
        onexpand={() => handleExpandStdio("STDOUT")}
        oncopy={() => handleCopyStdio("STDOUT")}
      />
    {/if}
  {:else if status === "RUNNING"}
    {#if testcase.mode === "interactive"}
      {#if testcase.interactorSecret === "" || testcase.interactorSecret === "\n"}
        <AutoresizeTextarea
          bind:value={newInteractorSecret}
          placeholder="Interactor secret..."
          variant="interactor-secret"
          onsave={() => {
            postProviderMessage({
              type: "NEW_INTERACTOR_SECRET",
              uuid: testcase.uuid,
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
          oncopy={() => handleCopyStdio("INTERACTOR_SECRET")}
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
        oncopy={() => handleCopyStdio("STDIN")}
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
      oncopy={() => handleCopyStdio("STDERR")}
    />
    {#if testcase.mode !== "interactive" || (testcase.interactorSecret !== "" && testcase.interactorSecret !== "\n")}
      <AutoresizeTextarea
        value={testcase.stdout}
        readonly
        placeholder="Output..."
        oncopy={() => handleCopyStdio("STDOUT")}
      />
    {/if}
  {/if}
{/if}
