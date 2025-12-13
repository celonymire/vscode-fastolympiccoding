import { observable } from "@legendapp/state";
import { For, observer } from "@legendapp/state/react";
import { useEffect } from "react";
import * as v from "valibot";

import { Status } from "~shared/enums";
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
import State, { IState } from "./State";

type IShowMessage = v.InferOutput<typeof ShowMessageSchema>;
type IStdioMessage = v.InferOutput<typeof StdioMessageSchema>;

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
  const show = state$.showView.get();

  useEffect(() => postProviderMessage({ type: ProviderMessageType.LOADED }), []);

  if (show) {
    return (
      <For each={state$.items}>
        {(item$, index) => (
          <State key={index} id={Number(index)} state$={item$} onView={expand} onAdd={add} />
        )}
      </For>
    );
  }

  return (
    <div id="empty-state">
      <div className="codicon codicon-symbol-event" style={{ fontSize: 150 }}></div>
      <p>Open a file to get started</p>
    </div>
  );
});

export default App;
