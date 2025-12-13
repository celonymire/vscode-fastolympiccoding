import { observer, useObservable } from "@legendapp/state/react";
import type { Observable } from "@legendapp/state";
import * as v from "valibot";

import { TestcaseSchema } from "~shared/schemas";
import { Status, Stdio } from "~shared/enums";
import AutoresizeTextarea from "../AutoresizeTextarea";
import { useCallback } from "react";
import { Action, ProviderMessageType } from "~shared/judge-messages";
import { postProviderMessage } from "./message";
import { getStatusColor } from "~webview/utils";

type ITestcase = v.InferOutput<typeof TestcaseSchema>;

interface Props {
  id: number;
  testcase$: Observable<ITestcase>;
}

const Testcase = observer(function Testcase({ id, testcase$ }: Props) {
  const newStdin$ = useObservable("");

  const handleSave = useCallback(() => {
    const stdin = testcase$.stdin.get();
    const acceptedStdout = testcase$.acceptedStdout.get();
    // the extension host will send back shortened version of both of these
    testcase$.stdin.set("");
    testcase$.acceptedStdout.set("");
    postProviderMessage({
      type: ProviderMessageType.SAVE,
      id,
      stdin,
      acceptedStdout,
    });
  }, [testcase$, id]);

  const handleExpandStdio = useCallback(
    (stdio: Stdio) => postProviderMessage({ type: ProviderMessageType.VIEW, id, stdio }),
    [id]
  );

  const handleNewStdinKeyUp = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter") {
        postProviderMessage({
          type: ProviderMessageType.STDIN,
          id,
          data: newStdin$.peek(),
        });
        newStdin$.set("");
      }
    },
    [id, newStdin$]
  );

  const handleAction = useCallback(
    (action: Action) => {
      postProviderMessage({ type: ProviderMessageType.ACTION, id, action });
    },
    [id]
  );

  const handleRun = useCallback(() => {
    newStdin$.set("");
    handleAction(Action.RUN);
  }, [handleAction]);

  const handleEdit = useCallback(() => handleAction(Action.EDIT), [handleAction]);
  const handleDelete = useCallback(() => handleAction(Action.DELETE), [handleAction]);
  const handleAccept = useCallback(() => handleAction(Action.ACCEPT), [handleAction]);
  const handleDecline = useCallback(() => handleAction(Action.DECLINE), [handleAction]);
  const handleToggleVisibility = useCallback(
    () => handleAction(Action.TOGGLE_VISIBILITY),
    [handleAction]
  );
  const handleToggleSkip = useCallback(() => handleAction(Action.TOGGLE_SKIP), [handleAction]);
  const handleStop = useCallback(() => handleAction(Action.STOP), [handleAction]);
  const handleCompare = useCallback(() => handleAction(Action.COMPARE), [handleAction]);

  const status = testcase$.status.get();
  const visible = testcase$.shown.get();
  const skipped = testcase$.skipped.get();
  const toggled = testcase$.toggled.get();

  switch (status) {
    case Status.NA:
    case Status.AC:
    case Status.CE:
    case Status.WA:
    case Status.RE:
    case Status.TL:
      const statusColor = getStatusColor(status);

      return (
        <div className="testcase-container" style={{ opacity: skipped ? 0.5 : 1 }}>
          <div className="testcase-toolbar">
            <div className="testcase-toolbar-left">
              <strong className="testcase-elapsed" style={{ backgroundColor: statusColor }}>
                {testcase$.elapsed.get()}ms
              </strong>
              <div className="testcase-toolbar-icon" onClick={handleRun}>
                <div className="codicon codicon-run-below"></div>
              </div>
              <div className="testcase-toolbar-icon" onClick={handleEdit}>
                <div className="codicon codicon-edit"></div>
              </div>
              <div className="testcase-toolbar-icon" onClick={handleDelete}>
                <div className="codicon codicon-trash"></div>
              </div>
              <div className="testcase-toolbar-icon" onClick={handleToggleVisibility}>
                <div className={`codicon ${visible ? "codicon-eye-closed" : "codicon-eye"}`}></div>
              </div>
              <div className="testcase-toolbar-icon" onClick={handleToggleSkip}>
                <div
                  className={`codicon ${skipped ? "codicon-debug-connected" : "codicon-debug-disconnect"}`}
                ></div>
              </div>
            </div>
            <div className="testcase-toolbar-right">
              {(status === Status.NA || status === Status.WA) && (
                <div className="testcase-toolbar-icon" onClick={handleAccept}>
                  <div className="codicon codicon-pass"></div>
                </div>
              )}
              {status === Status.AC && (
                <div className="testcase-toolbar-icon" onClick={handleDecline}>
                  <div className="codicon codicon-close"></div>
                </div>
              )}
              {status == Status.WA && (
                <div className="testcase-toolbar-icon" onClick={handleCompare}>
                  <div className="codicon codicon-diff-single"></div>
                </div>
              )}
            </div>
          </div>
          {!skipped && visible && !(status === Status.AC && !toggled) && (
            <>
              <AutoresizeTextarea
                input$={testcase$.stdin}
                readonly
                hiddenOnEmpty
                placeholder="Stdin..."
                onExpand={() => handleExpandStdio(Stdio.STDIN)}
              />
              <AutoresizeTextarea
                input$={testcase$.stderr}
                readonly
                hiddenOnEmpty
                placeholder="Stderr..."
                variant="stderr"
                onExpand={() => handleExpandStdio(Stdio.STDERR)}
              />
              <AutoresizeTextarea
                input$={testcase$.stdout}
                readonly
                hiddenOnEmpty
                placeholder="Stdout..."
                onExpand={() => handleExpandStdio(Stdio.STDOUT)}
              />
              {status === Status.WA && (
                <AutoresizeTextarea
                  input$={testcase$.acceptedStdout}
                  readonly
                  hiddenOnEmpty
                  placeholder="Accepted stdout..."
                  variant="accepted"
                  onExpand={() => handleExpandStdio(Stdio.ACCEPTED_STDOUT)}
                />
              )}
            </>
          )}
        </div>
      );
    case Status.COMPILING:
      return (
        <div className="testcase-container">
          <div className="testcase-toolbar">
            <div className="testcase-toolbar-left">
              <strong>COMPILING</strong>
              <div className="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
                <div className="codicon codicon-loading codicon-modifier-spin"></div>
              </div>
            </div>
          </div>
        </div>
      );
    case Status.RUNNING:
      return (
        <div className="testcase-container">
          <div className="testcase-toolbar">
            <div className="testcase-toolbar-left">
              <div className="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
                <div className="codicon codicon-loading codicon-modifier-spin"></div>
              </div>
              <div className="testcase-toolbar-icon" onClick={handleStop}>
                <div className="codicon codicon-stop-circle"></div>
              </div>
            </div>
          </div>
          {visible && (
            <>
              <AutoresizeTextarea
                input$={testcase$.stdin}
                readonly
                hiddenOnEmpty
                placeholder="Stdin..."
                onExpand={() => handleExpandStdio(Stdio.STDIN)}
              />
              <AutoresizeTextarea
                input$={newStdin$}
                placeholder="New stdin..."
                onKeyUp={handleNewStdinKeyUp}
                variant="active"
              />
              <AutoresizeTextarea
                input$={testcase$.stderr}
                readonly
                hiddenOnEmpty
                placeholder="Stderr..."
                variant="stderr"
                onExpand={() => handleExpandStdio(Stdio.STDERR)}
              />
              <AutoresizeTextarea input$={testcase$.stdout} readonly placeholder="Stdout..." />
            </>
          )}
        </div>
      );
    case Status.EDITING:
      return (
        <div className="testcase-container">
          <div className="testcase-toolbar">
            <div className="testcase-toolbar-left">
              <div className="testcase-toolbar-icon testcase-toolbar-icon-exclude-highlight">
                <div className="codicon codicon-sync codicon-modifier-spin"></div>
              </div>
              <div className="testcase-toolbar-icon">
                <div className="codicon codicon-save" onClick={handleSave}></div>
              </div>
            </div>
          </div>
          <AutoresizeTextarea
            input$={testcase$.stdin}
            placeholder="Stdin..."
            onExpand={() => handleExpandStdio(Stdio.STDIN)}
          />
          <AutoresizeTextarea
            input$={testcase$.acceptedStdout}
            placeholder="Accepted stdout..."
            variant="accepted"
            onExpand={() => handleExpandStdio(Stdio.ACCEPTED_STDOUT)}
          />
        </div>
      );
    default:
      return <></>;
  }
});

export default Testcase;
