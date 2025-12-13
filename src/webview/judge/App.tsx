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
  showSettings: false,
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
    case WebviewMessageType.SETTINGS_TOGGLE:
      handleSettingsToggle();
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

function handleSettingsToggle() {
  state$.showSettings.set((prev) => !prev);
}

function handleNewTestcase() {
  postProviderMessage({ type: ProviderMessageType.NEXT });
}

function handleTimeLimit(e: React.KeyboardEvent) {
  if (e.key === "Enter") {
    handleSaveSettings();
  }
}

function handleSaveSettings() {
  handleSettingsToggle();

  const limit = state$.newTimeLimit.get();
  postProviderMessage({ type: ProviderMessageType.TL, limit });
}

const App = observer(function App() {
  const show = state$.show.get();
  const showSettings = state$.showSettings.get();

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    state$.newTimeLimit.set(Number(e.target.value));
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (
      !/\d/.test(e.key) &&
      !["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Tab"].includes(e.key)
    ) {
      e.preventDefault();
    }
  }, []);

  useEffect(() => postProviderMessage({ type: ProviderMessageType.LOADED }), []);

  if (show) {
    if (showSettings) {
      return (
        <>
          <div className="settings-section">
            <p className="settings-label">Time Limit</p>
            <input
              value={state$.newTimeLimit.get()}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onKeyUp={handleTimeLimit}
              className="settings-input"
            />
            <p className="settings-additional-info">Specify time limit in milliseconds</p>
          </div>
          <button type="button" className="text-button" onClick={handleSaveSettings}>
            Save
          </button>
        </>
      );
    } else {
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
  }

  return (
    <div id="empty-state">
      <div className="codicon codicon-symbol-event" style={{ fontSize: 150 }}></div>
      <p style={{ lineHeight: 1 }}>Open a file to get started</p>
    </div>
  );
});

export default App;
