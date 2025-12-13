<script lang="ts">
  import { onMount } from "svelte";
  import type * as v from "valibot";

  import { Status } from "~shared/enums";
  import {
    ProviderMessageType,
    type RunningMessageSchema,
    type ShowMessageSchema,
    type StatusMessageSchema,
    type StdioMessageSchema,
    type WebviewMessage,
    WebviewMessageType,
  } from "~shared/stress-messages";
  import { postProviderMessage } from "./message";
  import State from "./State.svelte";

  type IShowMessage = v.InferOutput<typeof ShowMessageSchema>;
  type IStdioMessage = v.InferOutput<typeof StdioMessageSchema>;

  interface IStateData {
    data: string;
    status: Status;
  }

  // Reactive state using Svelte 5 runes
  let items = $state<IStateData[]>([
    { data: "", status: Status.NA },
    { data: "", status: Status.NA },
    { data: "", status: Status.NA },
  ]);
  let showView = $state(true);
  let running = $state(false);

  function expand(id: number) {
    postProviderMessage({ type: ProviderMessageType.VIEW, id });
  }

  function add(id: number) {
    postProviderMessage({ type: ProviderMessageType.ADD, id });
  }

  function handleStatus({ id, status }: v.InferOutput<typeof StatusMessageSchema>) {
    items[id].status = status;
  }

  function handleStdio({ id, data }: IStdioMessage) {
    items[id].data += data;
  }

  function handleClear() {
    for (let i = 0; i < 3; i++) {
      items[i].data = "";
      items[i].status = Status.NA;
    }
  }

  function handleShow({ visible }: IShowMessage) {
    showView = visible;
  }

  function handleRunning({ value }: v.InferOutput<typeof RunningMessageSchema>) {
    running = value;
  }

  onMount(() => {
    const handleMessage = (event: MessageEvent<WebviewMessage>) => {
      switch (event.data.type) {
        case WebviewMessageType.STATUS:
          handleStatus(event.data);
          break;
        case WebviewMessageType.STDIO:
          handleStdio(event.data);
          break;
        case WebviewMessageType.CLEAR:
          handleClear();
          break;
        case WebviewMessageType.SHOW:
          handleShow(event.data);
          break;
        case WebviewMessageType.RUNNING:
          handleRunning(event.data);
          break;
      }
    };

    window.addEventListener("message", handleMessage);
    postProviderMessage({ type: ProviderMessageType.LOADED });

    return () => {
      window.removeEventListener("message", handleMessage);
    };
  });
</script>

{#if showView}
  {#each items as item, index (index)}
    <State id={index} state={item} onView={expand} onAdd={add} />
  {/each}
{:else}
  <div id="empty-state">
    <div class="codicon codicon-symbol-event empty-state-icon"></div>
    <p>Open a file to get started</p>
  </div>
{/if}

<style>
  #empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 100vh;
  }

  .empty-state-icon {
    font-size: 150px;
  }
</style>
