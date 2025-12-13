import { observable } from "@legendapp/state";
import { observer } from "@legendapp/state/react";
import { useCallback, useEffect } from "react";
import * as v from "valibot";

import { Status, Stdio } from "~shared/enums";
import { TestcaseSchema } from "~shared/schemas";
import {
  DeleteMessageSchema,
  InitialStateSchema,
  NewMessageSchema,
  ProviderMessageType,
  SetMessageSchema,
  ShowMessageSchema,
  StdioMessageSchema,
  WebviewMessage,
  WebviewMessageType,
} from "~shared/judge-messages";
import { postProviderMessage } from "./message";
import Testcase from "./Testcase";

type IShowMessage = v.InferOutput<typeof ShowMessageSchema>;
type IStdioMessage = v.InferOutput<typeof StdioMessageSchema>;
type ITestcase = v.InferOutput<typeof TestcaseSchema>;

const state$ = observable({
  testcases: new Map<number, ITestcase>(),
  newTimeLimit: 0,
  show: true,
});

window.addEventListener("message", (msg: MessageEvent<WebviewMessage>) => {
  switch (msg.data.type) {
    case WebviewMessageType.NEW:
      handleNew(msg.data);
      break;
    case WebviewMessageType.SET:
      handleSet(msg.data);
      break;
    case WebviewMessageType.STDIO:
      handleStdio(msg.data);
      break;
    case WebviewMessageType.DELETE:
      handleDelete(msg.data);
      break;
    case WebviewMessageType.SAVE_ALL:
      handleSaveAll();
      break;
    case WebviewMessageType.SHOW:
      handleShow(msg.data);
      break;
    case WebviewMessageType.INITIAL_STATE:
      handleInitialState(msg.data);
      break;
  }
});

function handleNew({ id }: v.InferOutput<typeof NewMessageSchema>) {
  const testcases = state$.testcases.get();
  if (!testcases.has(id)) {
    state$.testcases.set(id, {
      stdin: "",
      stderr: "",
      stdout: "",
      acceptedStdout: "",
      elapsed: 0,
      status: Status.NA,
      shown: true,
      toggled: false,
      skipped: false,
    });
  }
}

function handleSet({ id, property, value }: v.InferOutput<typeof SetMessageSchema>) {
  const testcase$ = state$.testcases.get(id);
  if (testcase$) {
    (testcase$ as unknown as Record<string, { set: (v: unknown) => void }>)[property].set(value);
  }
}

function handleStdio({ id, data, stdio }: IStdioMessage) {
  const testcase$ = state$.testcases.get(id);
  if (!testcase$) return;
  switch (stdio) {
    case Stdio.STDIN:
      testcase$.stdin.set((prev) => prev + data);
      break;
    case Stdio.STDERR:
      testcase$.stderr.set((prev) => prev + data);
      break;
    case Stdio.STDOUT:
      testcase$.stdout.set((prev) => prev + data);
      break;
    case Stdio.ACCEPTED_STDOUT:
      testcase$.acceptedStdout.set((prev) => prev + data);
      break;
  }
}

function handleDelete({ id }: v.InferOutput<typeof DeleteMessageSchema>) {
  state$.testcases.delete(id);
}

function handleSaveAll() {
  for (const [id, testcase] of state$.testcases.get()) {
    if (testcase.status === Status.EDITING) {
      const stdin = testcase.stdin;
      const acceptedStdout = testcase.acceptedStdout;
      // the extension host will send shortened version of both of these
      const testcase$ = state$.testcases.get(id);
      if (testcase$) {
        testcase$.stdin.set("");
        testcase$.acceptedStdout.set("");
      }
      postProviderMessage({
        type: ProviderMessageType.SAVE,
        id,
        stdin,
        acceptedStdout,
      });
    }
  }
}

function handleShow({ visible }: IShowMessage) {
  state$.show.set(visible);
}

function handleInitialState({ timeLimit }: v.InferOutput<typeof InitialStateSchema>) {
  state$.newTimeLimit.set(timeLimit);
}

function handleNewTestcase() {
  postProviderMessage({ type: ProviderMessageType.NEXT });
}

const App = observer(function App() {
  const show = state$.show.get();

  useEffect(() => postProviderMessage({ type: ProviderMessageType.LOADED }), []);

  if (show) {
    return (
      <div className="testcase-container">
        {Array.from(state$.testcases.get().entries()).map(([id]) => (
          <Testcase key={id} id={id} testcase$={state$.testcases.get(id)!} />
        ))}
        <button
          type="button"
          className="text-button new-testcase-button"
          onClick={handleNewTestcase}
        >
          <div className="codicon codicon-add"></div>
          New Testcase
        </button>
      </div>
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
