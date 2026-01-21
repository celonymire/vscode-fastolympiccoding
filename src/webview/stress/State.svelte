<script lang="ts">
  import type { Status, Stdio } from "../../shared/enums";
  import type { StateId } from "../../shared/stress-messages";
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
    onView: (id: StateId, stdio: Stdio) => void;
  }

  let { state, id, interactiveMode, placeholder, onView }: Props = $props();

  function handleViewStdin() {
    onView(id, "STDIN");
  }

  function handleViewStdout() {
    onView(id, "STDOUT");
  }

  function handleViewStderr() {
    onView(id, "STDERR");
  }

  const status = $derived(state.status);
</script>

{#if status === "RUNNING"}
  <AutoresizeTextarea value={state.stdin} readonly hiddenOnEmpty onexpand={handleViewStdin} />
  <AutoresizeTextarea
    value={state.stderr}
    readonly
    hiddenOnEmpty
    onexpand={handleViewStderr}
    variant="stderr"
  />
  <AutoresizeTextarea value={state.stdout} readonly {placeholder} onexpand={handleViewStdout} />
{:else if status === "CE"}
  <AutoresizeTextarea
    value={state.stderr}
    readonly
    hiddenOnEmpty
    onexpand={handleViewStderr}
    variant="stderr"
  />
  <AutoresizeTextarea value={state.stdout} readonly hiddenOnEmpty onexpand={handleViewStdout} />
{:else if status !== "COMPILING"}
  <AutoresizeTextarea value={state.stdin} readonly hiddenOnEmpty onexpand={handleViewStdin} />
  <AutoresizeTextarea
    value={state.stderr}
    readonly
    hiddenOnEmpty
    onexpand={handleViewStderr}
    variant="stderr"
  />
  <AutoresizeTextarea
    value={state.stdout}
    readonly
    {placeholder}
    onexpand={handleViewStdout}
    variant={id === "Generator" && interactiveMode ? "interactor-secret" : "default"}
  />
{/if}

<style>
</style>
