import type { Observable } from "@legendapp/state";
import { observer, Memo } from "@legendapp/state/react";
import { useCallback } from "react";

import { Status } from "~shared/enums";
import AutoresizeTextarea from "../AutoresizeTextarea";
import { getStatusColor } from "~webview/utils";

export interface IState {
  data: string;
  status: Status;
}

interface Props {
  state$: Observable<IState>;
  id: number;
  onView: (id: number) => void;
  onAdd: (id: number) => void;
}

const from = ["Generator", "Solution", "Good Solution"];
const placeholders = ["Generator input...", "Solution output...", "Accepted output..."];

const State = observer(function State({ state$, id, onView, onAdd }: Props) {
  const status = state$.status.get();
  const statusColor = getStatusColor(status);

  const handleAdd = useCallback(() => onAdd(id), [id, onAdd]);
  const handleExpand = useCallback(() => onView(id), [id, onView]);

  switch (status) {
    case Status.COMPILING:
      return (
        <div className="state-container">
          <div className="state-toolbar">
            <div className="state-toolbar-left">
              <strong
                className="state-toolbar-text-bubble"
                style={{ backgroundColor: statusColor }}
              >
                {from[id]}
              </strong>
              <strong
                className="state-toolbar-text-bubble"
                style={{ backgroundColor: statusColor }}
              >
                COMPILING
              </strong>
              <div className="state-toolbar-icon state-toolbar-icon-exclude-highlight">
                <div className="codicon codicon-loading codicon-modifier-spin"></div>
              </div>
            </div>
          </div>
        </div>
      );
    case Status.RUNNING:
      return (
        <>
          <div className="state-container">
            <div className="state-toolbar">
              <div className="state-toolbar-left">
                <strong
                  className="state-toolbar-text-bubble"
                  style={{ backgroundColor: statusColor }}
                >
                  {from[id]}
                </strong>
                <div className="state-toolbar-icon state-toolbar-icon-exclude-highlight">
                  <div className="codicon codicon-loading codicon-modifier-spin"></div>
                </div>
              </div>
            </div>
            <AutoresizeTextarea
              input$={state$.data}
              readonly
              placeholder={placeholders[id]}
              onExpand={handleExpand}
            />
          </div>
        </>
      );
    case Status.CE:
      return (
        <div className="state-container">
          <div className="state-toolbar">
            <div className="state-toolbar-left">
              <strong
                className="state-toolbar-text-bubble"
                style={{ backgroundColor: getStatusColor(Status.NA) }}
              >
                {from[id]}
              </strong>
              <strong
                className="state-toolbar-text-bubble"
                style={{ backgroundColor: statusColor }}
              >
                Compile Error
              </strong>
            </div>
          </div>
        </div>
      );
    case Status.WA:
    case Status.RE:
    case Status.TL:
      const statusText =
        status === Status.WA
          ? "Wrong Answer"
          : status === Status.RE
            ? "Runtime Error"
            : "Time Limit Exceeded";

      return (
        <div className="state-container">
          <div className="state-toolbar">
            <div className="state-toolbar-left">
              <strong
                className="state-toolbar-text-bubble"
                style={{ backgroundColor: getStatusColor(Status.NA) }}
              >
                {from[id]}
              </strong>
              <strong
                className="state-toolbar-text-bubble"
                style={{ backgroundColor: statusColor }}
              >
                {statusText}
              </strong>
            </div>
            <div className="state-toolbar-right">
              <div className="state-toolbar-icon" onClick={handleAdd}>
                <div className="codicon codicon-insert"></div>
              </div>
            </div>
          </div>
          <AutoresizeTextarea
            input$={state$.data}
            readonly
            placeholder={placeholders[id]}
            onExpand={handleExpand}
          />
        </div>
      );
    default:
      return (
        <div className="state-container">
          <div className="state-toolbar">
            <div className="state-toolbar-left">
              <strong
                className="state-toolbar-text-bubble"
                style={{ backgroundColor: getStatusColor(Status.NA) }}
              >
                {from[id]}
              </strong>
            </div>
          </div>
          <AutoresizeTextarea
            input$={state$.data}
            readonly
            placeholder={placeholders[id]}
            onExpand={handleExpand}
          />
        </div>
      );
  }
});

export default State;
