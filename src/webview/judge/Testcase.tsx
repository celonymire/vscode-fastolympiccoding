import { useSignal } from "@preact/signals";
import { useCallback } from "preact/hooks";
import type { FunctionComponent } from "preact";
import * as v from "valibot";

import { Status, Stdio, TestcaseSchema } from "~shared/types";
import {
  ArrowSvgInwards,
  ArrowSvgOutwards,
  BLUE_COLOR,
  GRAY_COLOR,
  GREEN_COLOR,
  RED_COLOR,
} from "~webview/components";
import type { PreactObservable } from "../../external/observable";
import { Action, ProviderMessageType } from "~shared/judge-messages";
import AutoresizeTextarea from "./AutoresizeTextarea";
import { postProviderMessage } from "./message";

type ITestcase = v.InferOutput<typeof TestcaseSchema>;

interface Props {
  id: number;
  testcase: PreactObservable<ITestcase>;
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

const ActionButton: FunctionComponent<ActionButtonProps> = ({
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
      class={`text-base leading-tight px-3 w-fit display-font ${className}`}
      style={{ backgroundColor }}
      onClick={handleClick}
    >
      {text}
    </button>
  );
};
const StatusButton: FunctionComponent<StatusButtonProps> = ({
  status,
  id,
}: StatusButtonProps) => {
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
    <ActionButton
      id={id}
      action={Action.TOGGLE_VISIBILITY}
      backgroundColor={color}
      text={text}
    />
  );
};

export default function Testcase({ id, testcase }: Props) {
  const viewStdio = useCallback(
    (stdio: Stdio) =>
      postProviderMessage({ type: ProviderMessageType.VIEW, id, stdio }),
    [id]
  );

  const newStdin = useSignal("");

  const handlePreRun = useCallback(() => {
    // may be adding additional inputs, so clear out previous inputs
    newStdin.value = "";
  }, []);

  const handleNewStdinKeyUp = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        postProviderMessage({
          type: ProviderMessageType.STDIN,
          id,
          data: newStdin.value,
        });
        newStdin.value = "";
      }
    },
    [id, newStdin]
  );

  const handleSave = useCallback(() => {
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
  }, [id, testcase]);

  const StdinRow: FunctionComponent = () => {
    const handleClick = useCallback(() => viewStdio(Stdio.STDIN), [viewStdio]);
    return (
      <div class="flex flex-row">
        <ArrowSvgInwards color="#FFFFFF" onClick={handleClick} />
        <pre class="text-base display-font">{testcase.$stdin}</pre>
      </div>
    );
  };
  const StderrRow: FunctionComponent = () => {
    const handleClick = useCallback(() => viewStdio(Stdio.STDERR), [viewStdio]);
    return (
      <div class="flex flex-row">
        <ArrowSvgOutwards color={RED_COLOR} onClick={handleClick} />
        <pre class="text-base display-font">{testcase.$stderr}</pre>
      </div>
    );
  };
  const StdoutRow: FunctionComponent = () => {
    const handleClick = useCallback(() => viewStdio(Stdio.STDOUT), [viewStdio]);
    return (
      <div class="flex flex-row">
        <ArrowSvgOutwards color="#FFFFFF" onClick={handleClick} />
        <pre class="text-base display-font">{testcase.$stdout}</pre>
      </div>
    );
  };
  const AcceptedStdoutRow: FunctionComponent = () => {
    const handleClick = useCallback(
      () => viewStdio(Stdio.ACCEPTED_STDOUT),
      [viewStdio]
    );
    return (
      <div class="flex flex-row">
        <ArrowSvgOutwards color={GREEN_COLOR} onClick={handleClick} />
        <pre class="text-base display-font">{testcase.$acceptedStdout}</pre>
      </div>
    );
  };

  switch (testcase.status) {
    case Status.NA:
    case Status.WA:
    case Status.AC:
    case Status.RE:
    case Status.CE:
    case Status.TL:
      return (
        <div className={`container mx-auto mb-6 ${testcase.skipped && "fade"}`}>
          <div class="flex flex-row unfade">
            <div class="w-6 shrink-0" />
            <div class="flex justify-start gap-x-2 bg-zinc-800 grow unfade">
              <StatusButton id={id} status={testcase.status} />
              <ActionButton
                id={id}
                action={Action.EDIT}
                backgroundColor={GRAY_COLOR}
                text="edit"
              />
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
              <p class="text-base leading-tight bg-zinc-600 px-3 w-fit display-font">
                {testcase.$elapsed}ms
              </p>
              <ActionButton
                id={id}
                action={Action.TOGGLE_SKIP}
                backgroundColor="#000000"
                text={testcase.skipped ? "unskip" : "skip"}
                className="unfade"
              />
            </div>
          </div>
          {!testcase.skipped &&
            testcase.shown &&
            !(testcase.status === Status.AC && !testcase.toggled) && (
              <>
                <StdinRow />
                <StderrRow />
                <StdoutRow />
                {testcase.status === Status.WA && <AcceptedStdoutRow />}
                {(testcase.status === Status.WA ||
                  testcase.status === Status.NA) && (
                  <div class="flex flex-row gap-x-2">
                    <div class="w-4 shrink-0" />
                    <ActionButton
                      id={id}
                      action={Action.ACCEPT}
                      backgroundColor={GREEN_COLOR}
                      text="accept"
                    />
                    {testcase.status === Status.WA && (
                      <ActionButton
                        id={id}
                        action={Action.COMPARE}
                        backgroundColor={BLUE_COLOR}
                        text="compare"
                      />
                    )}
                  </div>
                )}
                {testcase.status === Status.AC && (
                  <div class="flex flex-row">
                    <div class="w-6 shrink-0" />
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
        <div class="container mx-auto mb-6">
          <div class="flex flex-row">
            <div class="w-6 shrink-0" />
            <div class="flex justify-start gap-x-2 bg-zinc-800 grow">
              <p class="text-base leading-tight bg-zinc-600 px-3 w-fit display-font">
                compiling
              </p>
            </div>
          </div>
        </div>
      );
    case Status.RUNNING:
      return (
        <div class="container mx-auto mb-6">
          <div class="flex flex-row">
            <div class="w-6 shrink-0" />
            <div class="flex justify-start gap-x-2 bg-zinc-800 grow">
              <ActionButton
                id={id}
                action={Action.STOP}
                backgroundColor={RED_COLOR}
                text="stop"
              />
            </div>
          </div>
          <StdinRow />
          <div class="flex flex-row">
            <div class="w-6 shrink-0" />
            <AutoresizeTextarea
              input={newStdin}
              onKeyUp={handleNewStdinKeyUp}
            />
          </div>
          <StderrRow />
          <StdoutRow />
        </div>
      );
    case Status.EDITING:
      return (
        <div class="container mx-auto mb-6">
          <div class="flex flex-row">
            <div class="w-6 shrink-0" />
            <div class="flex justify-start gap-x-2 bg-zinc-800 grow">
              <button
                type="button"
                class="text-base leading-tight px-3 w-fit display-font"
                style={{ backgroundColor: BLUE_COLOR }}
                onClick={handleSave}
              >
                save
              </button>
            </div>
          </div>
          <div class="flex flex-row">
            <ArrowSvgInwards color="#FFFFFF" />
            <AutoresizeTextarea input={testcase.$stdin!} />
          </div>
          <div class="flex flex-row">
            <ArrowSvgOutwards color={GREEN_COLOR} />
            <AutoresizeTextarea input={testcase.$acceptedStdout!} />
          </div>
        </div>
      );
  }
}
