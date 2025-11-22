import { batch, signal, useComputed } from "@preact/signals";
import { useCallback, useEffect } from "preact/hooks";
import * as v from "valibot";

import { Status } from "~shared/enums";
import { BLUE_COLOR, RED_COLOR } from "~webview/components";
import { observable, type PreactObservable } from "../../external/observable";
import {
  ProviderMessageType,
  RunningMessageSchema,
  ShowMessageSchema,
  StatusMessageSchema,
  StdioMessageSchema,
  WebviewMessage,
  WebviewMessageType,
} from "~shared/stress-messages";
import { postProviderMessage } from "./message";
import State from "./State";

type IShowMessage = v.InferOutput<typeof ShowMessageSchema>;
type IStdioMessage = v.InferOutput<typeof StdioMessageSchema>;

interface IState {
  data: string;
  status: Status;
}

const state: PreactObservable<IState[]> = observable([
  { data: "", status: Status.NA },
  { data: "", status: Status.NA },
  { data: "", status: Status.NA },
]);
const showView = signal(true);
const running = signal(false);

const expand = (id: number) =>
  postProviderMessage({ type: ProviderMessageType.VIEW, id });
const add = (id: number) =>
  postProviderMessage({ type: ProviderMessageType.ADD, id });
const clear = () => postProviderMessage({ type: ProviderMessageType.CLEAR });

window.addEventListener("message", (event: MessageEvent<WebviewMessage>) => {
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
});

function handleStatus({
  id,
  status,
}: v.InferOutput<typeof StatusMessageSchema>) {
  state[id].status = status;
}

function handleStdio({ id, data }: IStdioMessage) {
  state[id].data += data;
}

function handleClear() {
  batch(() => {
    for (let i = 0; i < 3; i++) {
      state[i].data = "";
      state[i].status = Status.NA;
    }
  });
}

function handleShow({ visible }: IShowMessage) {
  showView.value = visible;
}

function handleRunning({ value }: v.InferOutput<typeof RunningMessageSchema>) {
  running.value = value;
}

export default function App() {
  useEffect(
    () => postProviderMessage({ type: ProviderMessageType.LOADED }),
    [],
  );

  const handleStop = useCallback(
    () => postProviderMessage({ type: ProviderMessageType.STOP }),
    [],
  );
  const handleRun = useCallback(
    () => postProviderMessage({ type: ProviderMessageType.RUN }),
    [],
  );
  const handleClear = useCallback(() => clear(), []);
  const handleExpand = useCallback((id: number) => expand(id), []);
  const handleAdd = useCallback((id: number) => add(id), []);

  const button = useComputed(() => {
    if (running.value)
      return (
        <button
          type="button"
          class="text-base leading-tight px-3 w-fit display-font"
          style={{ backgroundColor: RED_COLOR }}
          onClick={handleStop}
        >
          stop
        </button>
      );
    if (
      state[0].status === Status.COMPILING ||
      state[1].status === Status.COMPILING ||
      state[2].status === Status.COMPILING
    )
      return;
    return (
      <button
        type="button"
        class="text-base leading-tight px-3 w-fit display-font"
        style={{ backgroundColor: BLUE_COLOR }}
        onClick={handleRun}
      >
        stress test
      </button>
    );
  });

  return (
    <>
      {showView.value && (
        <>
          <div class="container mx-auto mb-6">
            <div class="flex flex-row">
              <div class="w-6 shrink-0" />
              <div class="flex justify-start gap-x-2 bg-zinc-800 grow">
                {button}
                <button
                  type="button"
                  class="text-base leading-tight px-3 w-fit display-font"
                  style={{ backgroundColor: BLUE_COLOR }}
                  onClick={handleClear}
                >
                  clear
                </button>
              </div>
            </div>
          </div>
          <State
            data={state[0].$data!}
            status={state[0].status}
            id={0}
            onView={handleExpand}
            onAdd={handleAdd}
          />
          <State
            data={state[1].$data!}
            status={state[1].status}
            id={1}
            onView={handleExpand}
            onAdd={handleAdd}
          />
          <State
            data={state[2].$data!}
            status={state[2].status}
            id={2}
            onView={handleExpand}
            onAdd={handleAdd}
          />
        </>
      )}
    </>
  );
}
