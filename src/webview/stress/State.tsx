import type { Observable } from "@legendapp/state";
import { observer, Memo } from "@legendapp/state/react";
import { useCallback } from "react";

import { Status } from "~shared/enums";
import { ArrowSvgOutwards, BLUE_COLOR, RED_COLOR } from "~webview/components";

interface Props {
  data$: Observable<string>;
  status: Status;
  id: number;
  onView: (id: number) => void;
  onAdd: (id: number) => void;
}

const from = ["Generator", "Solution", "Good Solution"];

const State = observer(function State({ data$, status, id, onView, onAdd }: Props) {
  const handleAdd = useCallback(() => onAdd(id), [id, onAdd]);
  const handleView = useCallback(() => onView(id), [id, onView]);

  switch (status) {
    case Status.COMPILING:
      return (
        <div className="container mx-auto mb-6">
          <div className="flex flex-row">
            <div className="w-6 shrink-0" />
            <div className="flex justify-start gap-x-2 bg-zinc-800 grow">
              <p className="text-base leading-tight bg-zinc-600 px-3 w-fit display-font">
                {from[id]}
              </p>
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
            <ArrowSvgOutwards color="#FFFFFF" />
            <div className="grow">
              <p className="text-base leading-tight bg-zinc-600 px-3 w-fit display-font">
                {from[id]}
              </p>
              <pre className="text-base display-font">
                <Memo>{() => data$.get()}</Memo>
              </pre>
            </div>
          </div>
        </div>
      );
    default:
      return (
        <div className="container mx-auto mb-6">
          <div className="flex flex-row">
            <div className="w-6 shrink-0" />
            <div className="flex justify-start gap-x-2 bg-zinc-800 grow">
              <p className="text-base leading-tight bg-zinc-600 px-3 w-fit display-font">
                {from[id]}
              </p>
              {[Status.RE, Status.CE, Status.WA, Status.TL].includes(status) && (
                <p
                  className="text-base leading-tight px-3 w-fit display-font"
                  style={{ backgroundColor: RED_COLOR }}
                >
                  {status === Status.CE
                    ? "CE"
                    : status === Status.RE
                      ? "RE"
                      : status === Status.WA
                        ? "WA"
                        : "TL"}
                </p>
              )}
              {(status === Status.RE || status === Status.WA) && (
                <button
                  type="button"
                  className="text-base leading-tight px-3 w-fit display-font"
                  style={{ background: BLUE_COLOR }}
                  onClick={handleAdd}
                >
                  add testcase
                </button>
              )}
            </div>
          </div>
          <div className="flex flex-row">
            <ArrowSvgOutwards color="#FFFFFF" onClick={handleView} />
            <pre className="text-base display-font">
              <Memo>{() => data$.get()}</Memo>
            </pre>
          </div>
        </div>
      );
  }
});

export default State;
