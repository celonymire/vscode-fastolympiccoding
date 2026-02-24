<script lang="ts">
  import type { Status, Stdio } from "../../shared/enums";
  import type { StateId } from "../../shared/schemas";
  import AutoresizeTextarea from "../AutoresizeTextarea.svelte";

  interface IState {
    stdin: string;
    stdout: string;
    stderr: string;
    status: Status;
  }

  interface Props {
    state: IState;
    id: StateId;
    interactiveMode: boolean;
    placeholder: string;
    shown: boolean;
    onView: (id: StateId, stdio: Stdio) => void;
    onCopy: (id: StateId, stdio: Stdio) => void;
  }

  let { state, id, interactiveMode, placeholder, shown, onView, onCopy }: Props = $props();

  function handleViewStdin() {
    onView(id, "STDIN");
  }

  function handleViewStdout() {
    onView(id, "STDOUT");
  }

  function handleViewStderr() {
    onView(id, "STDERR");
  }

  function handleCopyStdin() {
    onCopy(id, "STDIN");
  }

  function handleCopyStdout() {
    onCopy(id, "STDOUT");
  }

  function handleCopyStderr() {
    onCopy(id, "STDERR");
  }

  const status = $derived(state.status);
</script>

{#if shown}
  {#if status === "RUNNING"}
    <AutoresizeTextarea
      value={state.stdin}
      readonly
      hiddenOnEmpty
      onexpand={handleViewStdin}
      oncopy={handleCopyStdin}
    />
    <AutoresizeTextarea
      value={state.stderr}
      readonly
      hiddenOnEmpty
      onexpand={handleViewStderr}
      oncopy={handleCopyStderr}
      variant="stderr"
    />
    <AutoresizeTextarea
      value={state.stdout}
      readonly
      {placeholder}
      onexpand={handleViewStdout}
      oncopy={handleCopyStdout}
    />
  {:else if status === "CE"}
    <AutoresizeTextarea
      value={state.stderr}
      readonly
      hiddenOnEmpty
      onexpand={handleViewStderr}
      oncopy={handleCopyStderr}
      variant="stderr"
    />
    <AutoresizeTextarea
      value={state.stdout}
      readonly
      hiddenOnEmpty
      onexpand={handleViewStdout}
      oncopy={handleCopyStdout}
    />
  {:else}
    <AutoresizeTextarea
      value={state.stdin}
      readonly
      hiddenOnEmpty
      onexpand={handleViewStdin}
      oncopy={handleCopyStdin}
    />
    <AutoresizeTextarea
      value={state.stderr}
      readonly
      hiddenOnEmpty
      onexpand={handleViewStderr}
      oncopy={handleCopyStderr}
      variant="stderr"
    />
    <AutoresizeTextarea
      value={state.stdout}
      readonly
      {placeholder}
      onexpand={handleViewStdout}
      oncopy={handleCopyStdout}
      variant={id === "Generator" && interactiveMode ? "interactor-secret" : "default"}
    />
  {/if}
{/if}

<style>
</style>
