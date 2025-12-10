import { observable } from "@legendapp/state";
import { observer } from "@legendapp/state/react";
import { useCallback, useEffect } from "react";
import * as v from "valibot";

import { Status, Stdio } from "~shared/enums";
import { TestcaseSchema } from "~shared/schemas";
import { BLUE_COLOR } from "~webview/components";
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

function submitTimeLimit() {
  postProviderMessage({
    type: ProviderMessageType.TL,
    limit: Number(state$.newTimeLimit.get()),
  });
}

const App = observer(function App() {
  useEffect(() => postProviderMessage({ type: ProviderMessageType.LOADED }), []);

  const handleNext = useCallback(() => postProviderMessage({ type: ProviderMessageType.NEXT }), []);

  const handleTimeLimitChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    state$.newTimeLimit.set(Number(event.target.value));
  }, []);

  const handleTimeLimitKeyUp = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      submitTimeLimit();
    }
  }, []);

  return (
    state$.show.get() && (
      <div className="flex flex-col h-screen">
        <div className="flex-1 overflow-auto">
          {Array.from(state$.testcases.get().entries()).map(([id]) => (
            <Testcase key={id} id={id} testcase$={state$.testcases.get(id)!} />
          ))}
          <button
            type="button"
            className="ml-6 text-base leading-tight bg-zinc-600 px-3 shrink-0 display-font"
            onClick={handleNext}
          >
            next test
          </button>
        </div>
        <div className="m-6 flex gap-x-2 items-center my-3 bg-zinc-800">
          <button
            type="button"
            className="text-base leading-tight px-3 w-fit display-font"
            style={{ backgroundColor: BLUE_COLOR }}
          >
            time limit
          </button>
          <input
            type="number"
            className="appearance-none bg-transparent border-none focus:outline-none text-base leading-tight display-font w-fit"
            value={state$.newTimeLimit.get()}
            onChange={handleTimeLimitChange}
            onKeyUp={handleTimeLimitKeyUp}
          />
          <span className="text-base leading-tight display-font w-fit">ms</span>
          <button
            type="button"
            className="text-base leading-tight px-3 w-fit display-font"
            style={{ backgroundColor: BLUE_COLOR }}
            onClick={submitTimeLimit}
          >
            set
          </button>
        </div>
      </div>
    )
  );
});

export default App;
