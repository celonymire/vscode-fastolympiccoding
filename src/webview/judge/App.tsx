import { signal, useComputed } from "@preact/signals";
import { useCallback, useEffect } from "preact/hooks";
import * as v from "valibot";

import { Status, Stdio, TestcaseSchema } from "~shared/types";
import { BLUE_COLOR } from "~webview/components";
import { observable } from "~external/observable";
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

const testcases = observable(new Map<number, ITestcase>());
const newTimeLimit = signal(0);
const show = signal(true);

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
  if (!testcases.get(id)) {
    testcases.set(id, {
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

function handleSet({
  id,
  property,
  value,
}: v.InferOutput<typeof SetMessageSchema>) {
  (testcases.get(id)![property] as unknown) = value;
}

function handleStdio({ id, data, stdio }: IStdioMessage) {
  switch (stdio) {
    case Stdio.STDIN:
      testcases.get(id)!.stdin += data;
      break;
    case Stdio.STDERR:
      testcases.get(id)!.stderr += data;
      break;
    case Stdio.STDOUT:
      testcases.get(id)!.stdout += data;
      break;
    case Stdio.ACCEPTED_STDOUT:
      testcases.get(id)!.acceptedStdout += data;
      break;
  }
}

function handleDelete({ id }: v.InferOutput<typeof DeleteMessageSchema>) {
  testcases.delete(id);
}

function handleSaveAll() {
  for (const [id, testcase] of testcases) {
    if (testcase.status === Status.EDITING) {
      const stdin = testcase.stdin;
      const acceptedStdout = testcase.acceptedStdout;
      // the extension host will send shortened version of both of these
      testcase.stdin = "";
      testcase.acceptedStdout = "";
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
  show.value = visible;
}

function handleInitialState({
  timeLimit,
}: v.InferOutput<typeof InitialStateSchema>) {
  newTimeLimit.value = timeLimit;
}

function submitTimeLimit() {
  postProviderMessage({
    type: ProviderMessageType.TL,
    limit: Number(newTimeLimit.value),
  });
}

export default function App() {
  useEffect(
    () => postProviderMessage({ type: ProviderMessageType.LOADED }),
    [],
  );

  const handleNext = useCallback(
    () => postProviderMessage({ type: ProviderMessageType.NEXT }),
    [],
  );

  const handleTimeLimitInput = useCallback((event: Event) => {
    const target = event.currentTarget as HTMLInputElement;
    newTimeLimit.value = Number(target.value);
  }, []);

  const handleTimeLimitKeyUp = useCallback((event: KeyboardEvent) => {
    if (event.key === "Enter") {
      submitTimeLimit();
    }
  }, []);

  const testcaseComponents = useComputed(() => {
    const components = [];
    for (const [id, testcase] of testcases.entries()) {
      components.push(<Testcase key={id} id={id} testcase={testcase} />);
    }
    return components;
  });

  return (
    show.value && (
      <div class="flex flex-col h-screen">
        <div class="flex-1 overflow-auto">
          {testcaseComponents}
          <button
            type="button"
            class="ml-6 text-base leading-tight bg-zinc-600 px-3 shrink-0 display-font"
            onClick={handleNext}
          >
            next test
          </button>
        </div>
        <div class="m-6 flex gap-x-2 items-center my-3 bg-zinc-800">
          <button
            type="button"
            class="text-base leading-tight px-3 w-fit display-font"
            style={{ backgroundColor: BLUE_COLOR }}
          >
            time limit
          </button>
          <input
            type="number"
            class="appearance-none bg-transparent border-none focus:outline-none text-base leading-tight display-font w-fit"
            value={newTimeLimit.value}
            onInput={handleTimeLimitInput}
            onKeyUp={handleTimeLimitKeyUp}
          />
          <span class="text-base leading-tight display-font w-fit">ms</span>
          <button
            type="button"
            class="text-base leading-tight px-3 w-fit display-font"
            style={{ backgroundColor: BLUE_COLOR }}
            onClick={submitTimeLimit}
          >
            set
          </button>
        </div>
      </div>
    )
  );
}
