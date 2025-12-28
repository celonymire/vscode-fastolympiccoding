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

  function handleNewStdinChange(value: string) {
    newStdin = value;
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
</style>
