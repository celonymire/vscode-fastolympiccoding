import { observable } from "@legendapp/state";
import { observer } from "@legendapp/state/react";
import { useCallback, useEffect } from "react";
import * as v from "valibot";

import { Status } from "~shared/enums";
import { BLUE_COLOR, RED_COLOR } from "~webview/components";
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

const state$ = observable({
  items: [
    { data: "", status: Status.NA },
    { data: "", status: Status.NA },
    { data: "", status: Status.NA },
  ] as IState[],
  showView: true,
  running: false,
});

const expand = (id: number) => postProviderMessage({ type: ProviderMessageType.VIEW, id });
const add = (id: number) => postProviderMessage({ type: ProviderMessageType.ADD, id });
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

function handleStatus({ id, status }: v.InferOutput<typeof StatusMessageSchema>) {
  state$.items[id].status.set(status);
}

function handleStdio({ id, data }: IStdioMessage) {
  state$.items[id].data.set((prev) => prev + data);
}

function handleClear() {
  for (let i = 0; i < 3; i++) {
    state$.items[i].data.set("");
    state$.items[i].status.set(Status.NA);
  }
}

function handleShow({ visible }: IShowMessage) {
  state$.showView.set(visible);
}

function handleRunning({ value }: v.InferOutput<typeof RunningMessageSchema>) {
  state$.running.set(value);
}

const App = observer(function App() {
  useEffect(() => postProviderMessage({ type: ProviderMessageType.LOADED }), []);

  const handleStop = useCallback(() => postProviderMessage({ type: ProviderMessageType.STOP }), []);
  const handleRun = useCallback(() => postProviderMessage({ type: ProviderMessageType.RUN }), []);
  const handleClear = useCallback(() => clear(), []);
  const handleExpand = useCallback((id: number) => expand(id), []);
  const handleAdd = useCallback((id: number) => add(id), []);

  const renderButton = () => {
    if (state$.running.get())
      return (
        <button
          type="button"
          className="text-base leading-tight px-3 w-fit display-font"
          style={{ backgroundColor: RED_COLOR }}
          onClick={handleStop}
        >
          stop
        </button>
      );
    if (
      state$.items[0].status.get() === Status.COMPILING ||
      state$.items[1].status.get() === Status.COMPILING ||
      state$.items[2].status.get() === Status.COMPILING
    )
      return null;
    return (
      <button
        type="button"
        className="text-base leading-tight px-3 w-fit display-font"
        style={{ backgroundColor: BLUE_COLOR }}
        onClick={handleRun}
      >
        stress test
      </button>
    );
  };

  if (!state$.showView.get()) return null;

  return (
    <>
      <div className="container mx-auto mb-6">
        <div className="flex flex-row">
          <div className="w-6 shrink-0" />
          <div className="flex justify-start gap-x-2 bg-zinc-800 grow">
            {renderButton()}
            <button
              type="button"
              className="text-base leading-tight px-3 w-fit display-font"
              style={{ backgroundColor: BLUE_COLOR }}
              onClick={handleClear}
            >
              clear
            </button>
          </div>
        </div>
      </div>
      <State
        data$={state$.items[0].data}
        status={state$.items[0].status.get()}
        id={0}
        onView={handleExpand}
        onAdd={handleAdd}
      />
      <State
        data$={state$.items[1].data}
        status={state$.items[1].status.get()}
        id={1}
        onView={handleExpand}
        onAdd={handleAdd}
      />
      <State
        data$={state$.items[2].data}
        status={state$.items[2].status.get()}
        id={2}
        onView={handleExpand}
        onAdd={handleAdd}
      />
    </>
  );
});

export default App;
