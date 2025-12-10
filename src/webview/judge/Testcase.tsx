import { useObservable, observer, Memo } from "@legendapp/state/react";
import type { Observable } from "@legendapp/state";
import { useCallback } from "react";
import type { FC } from "react";
import * as v from "valibot";

import { Status, Stdio } from "~shared/enums";
import { TestcaseSchema } from "~shared/schemas";
import {
  ArrowSvgInwards,
  ArrowSvgOutwards,
  BLUE_COLOR,
  GRAY_COLOR,
  GREEN_COLOR,
  RED_COLOR,
} from "~webview/components";
import { Action, ProviderMessageType } from "~shared/judge-messages";
import AutoresizeTextarea from "./AutoresizeTextarea";
import { postProviderMessage } from "./message";

type ITestcase = v.InferOutput<typeof TestcaseSchema>;

interface Props {
  id: number;
  testcase$: Observable<ITestcase>;
}
interface ActionButtonProps {
  id: number;
  action: Action;
  backgroundColor: string;
  text: string;
  className?: string;
  onClickPrePost?: () => unknown;
}
interface StatusButtonProps {
  id: number;
  status: Status;
}

const ActionButton: FC<ActionButtonProps> = ({
  id,
  action,
  backgroundColor,
  text,
  className,
  onClickPrePost,
}: ActionButtonProps) => {
  const handleClick = useCallback(() => {
    onClickPrePost?.();
    postProviderMessage({ type: ProviderMessageType.ACTION, id, action });
  }, [id, action, onClickPrePost]);

  return (
    <button
      type="button"
      className={`text-base leading-tight px-3 w-fit display-font ${className}`}
      style={{ backgroundColor }}
      onClick={handleClick}
    >
      {text}
    </button>
  );
};
const StatusButton: FC<StatusButtonProps> = ({ status, id }: StatusButtonProps) => {
  let color: string;
  let text: string;
  switch (status) {
    case Status.CE:
      color = RED_COLOR;
      text = "CE";
      break;
    case Status.RE:
      color = RED_COLOR;
      text = "RE";
      break;
    case Status.WA:
      color = RED_COLOR;
      text = "WA";
      break;
    case Status.AC:
      color = GREEN_COLOR;
      text = "AC";
      break;
    case Status.TL:
      color = RED_COLOR;
      text = "TL";
      break;
    default:
      color = GRAY_COLOR;
      text = "NA";
      break;
  }

  return (
    <ActionButton id={id} action={Action.TOGGLE_VISIBILITY} backgroundColor={color} text={text} />
  );
};

const Testcase = observer(function Testcase({ id, testcase$ }: Props) {
  const viewStdio = useCallback(
    (stdio: Stdio) => postProviderMessage({ type: ProviderMessageType.VIEW, id, stdio }),
    [id]
  );

  const newStdin$ = useObservable("");

  const handlePreRun = useCallback(() => {
    // may be adding additional inputs, so clear out previous inputs
    newStdin$.set("");
  }, [newStdin$]);

  const handleNewStdinKeyUp = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        postProviderMessage({
          type: ProviderMessageType.STDIN,
          id,
          data: newStdin$.get(),
        });
        newStdin$.set("");
      }
    },
    [id, newStdin$]
  );

  const handleSave = useCallback(() => {
    const stdin = testcase$.stdin.get();
    const acceptedStdout = testcase$.acceptedStdout.get();
    // the extension host will send shortened version of both of these
    testcase$.stdin.set("");
    testcase$.acceptedStdout.set("");
    postProviderMessage({
      type: ProviderMessageType.SAVE,
      id,
      stdin,
      acceptedStdout,
    });
  }, [id, testcase$]);

  const StdinRow: FC = () => {
    const handleClick = useCallback(() => viewStdio(Stdio.STDIN), []);
    return (
      <div className="flex flex-row">
        <ArrowSvgInwards color="#FFFFFF" onClick={handleClick} />
        <pre className="text-base display-font">
          <Memo>{() => testcase$.stdin.get()}</Memo>
        </pre>
      </div>
    );
  };
  const StderrRow: FC = () => {
    const handleClick = useCallback(() => viewStdio(Stdio.STDERR), []);
    return (
      <div className="flex flex-row">
        <ArrowSvgOutwards color={RED_COLOR} onClick={handleClick} />
        <pre className="text-base display-font">
          <Memo>{() => testcase$.stderr.get()}</Memo>
        </pre>
      </div>
    );
  };
  const StdoutRow: FC = () => {
    const handleClick = useCallback(() => viewStdio(Stdio.STDOUT), []);
    return (
      <div className="flex flex-row">
        <ArrowSvgOutwards color="#FFFFFF" onClick={handleClick} />
        <pre className="text-base display-font">
          <Memo>{() => testcase$.stdout.get()}</Memo>
        </pre>
      </div>
    );
  };
  const AcceptedStdoutRow: FC = () => {
    const handleClick = useCallback(() => viewStdio(Stdio.ACCEPTED_STDOUT), []);
    return (
      <div className="flex flex-row">
        <ArrowSvgOutwards color={GREEN_COLOR} onClick={handleClick} />
        <pre className="text-base display-font">
          <Memo>{() => testcase$.acceptedStdout.get()}</Memo>
        </pre>
      </div>
    );
  };

  const status = testcase$.status.get();
  const skipped = testcase$.skipped.get();
  const shown = testcase$.shown.get();
  const toggled = testcase$.toggled.get();

  switch (status) {
    case Status.NA:
    case Status.WA:
    case Status.AC:
    case Status.RE:
    case Status.CE:
    case Status.TL:
      return (
        <div className={`container mx-auto mb-6 ${skipped && "fade"}`}>
          <div className="flex flex-row unfade">
            <div className="w-6 shrink-0" />
            <div className="flex justify-start gap-x-2 bg-zinc-800 grow unfade">
              <StatusButton id={id} status={status} />
              <ActionButton id={id} action={Action.EDIT} backgroundColor={GRAY_COLOR} text="edit" />
              <ActionButton
                id={id}
                action={Action.RUN}
                backgroundColor={BLUE_COLOR}
                text="run"
                onClickPrePost={handlePreRun}
              />
              <ActionButton
                id={id}
                action={Action.DELETE}
                backgroundColor={RED_COLOR}
                text="delete"
              />
              <p className="text-base leading-tight bg-zinc-600 px-3 w-fit display-font">
                <Memo>{() => testcase$.elapsed.get()}</Memo>ms
              </p>
              <ActionButton
                id={id}
                action={Action.TOGGLE_SKIP}
                backgroundColor="#000000"
                text={skipped ? "unskip" : "skip"}
                className="unfade"
              />
            </div>
          </div>
          {!skipped && shown && !(status === Status.AC && !toggled) && (
            <>
              <StdinRow />
              <StderrRow />
              <StdoutRow />
              {status === Status.WA && <AcceptedStdoutRow />}
              {(status === Status.WA || status === Status.NA) && (
                <div className="flex flex-row gap-x-2">
                  <div className="w-4 shrink-0" />
                  <ActionButton
                    id={id}
                    action={Action.ACCEPT}
                    backgroundColor={GREEN_COLOR}
                    text="accept"
                  />
                  {status === Status.WA && (
                    <ActionButton
                      id={id}
                      action={Action.COMPARE}
                      backgroundColor={BLUE_COLOR}
                      text="compare"
                    />
                  )}
                </div>
              )}
              {status === Status.AC && (
                <div className="flex flex-row">
                  <div className="w-6 shrink-0" />
                  <ActionButton
                    id={id}
                    action={Action.DECLINE}
                    backgroundColor={RED_COLOR}
                    text="decline"
                  />
                </div>
              )}
            </>
          )}
        </div>
      );
    case Status.COMPILING:
      return (
        <div className="container mx-auto mb-6">
          <div className="flex flex-row">
            <div className="w-6 shrink-0" />
            <div className="flex justify-start gap-x-2 bg-zinc-800 grow">
              <p className="text-base leading-tight bg-zinc-600 px-3 w-fit display-font">
                compiling
              </p>
            </div>
          </div>
        </div>
      );
    case Status.RUNNING:
      return (
        <div className="container mx-auto mb-6">
          <div className="flex flex-row">
            <div className="w-6 shrink-0" />
            <div className="flex justify-start gap-x-2 bg-zinc-800 grow">
              <ActionButton id={id} action={Action.STOP} backgroundColor={RED_COLOR} text="stop" />
            </div>
          </div>
          <StdinRow />
          <div className="flex flex-row">
            <div className="w-6 shrink-0" />
            <AutoresizeTextarea input$={newStdin$} onKeyUp={handleNewStdinKeyUp} />
          </div>
          <StderrRow />
          <StdoutRow />
        </div>
      );
    case Status.EDITING:
      return (
        <div className="container mx-auto mb-6">
          <div className="flex flex-row">
            <div className="w-6 shrink-0" />
            <div className="flex justify-start gap-x-2 bg-zinc-800 grow">
              <button
                type="button"
                className="text-base leading-tight px-3 w-fit display-font"
                style={{ backgroundColor: BLUE_COLOR }}
                onClick={handleSave}
              >
                save
              </button>
            </div>
          </div>
          <div className="flex flex-row">
            <ArrowSvgInwards color="#FFFFFF" />
            <AutoresizeTextarea input$={testcase$.stdin} />
          </div>
          <div className="flex flex-row">
            <ArrowSvgOutwards color={GREEN_COLOR} />
            <AutoresizeTextarea input$={testcase$.acceptedStdout} />
          </div>
        </div>
      );
  }
});

export default Testcase;
