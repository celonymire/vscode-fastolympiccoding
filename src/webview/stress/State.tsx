import type { Signal } from "@preact/signals";
import { useCallback } from "preact/hooks";

import { Status } from "~shared/types";
import { ArrowSvgOutwards, BLUE_COLOR, RED_COLOR } from "~webview/components";

interface Props {
  data: Signal<string>;
  status: Status;
  id: number;
  onView: (id: number) => void;
  onAdd: (id: number) => void;
}

const from = ["Generator", "Solution", "Good Solution"];

export default function State({ data, status, id, onView, onAdd }: Props) {
  const handleAdd = useCallback(() => onAdd(id), [id, onAdd]);
  const handleView = useCallback(() => onView(id), [id, onView]);

  switch (status) {
    case Status.COMPILING:
      return (
        <div class="container mx-auto mb-6">
          <div class="flex flex-row">
            <div class="w-6 shrink-0" />
            <div class="flex justify-start gap-x-2 bg-zinc-800 grow">
              <p class="text-base leading-tight bg-zinc-600 px-3 w-fit display-font">
                {from[id]}
              </p>
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
            <ArrowSvgOutwards color="#FFFFFF" />
            <div class="grow">
              <p class="text-base leading-tight bg-zinc-600 px-3 w-fit display-font">
                {from[id]}
              </p>
              <pre class="text-base display-font">{data}</pre>
            </div>
          </div>
        </div>
      );
    default:
      return (
        <div class="container mx-auto mb-6">
          <div class="flex flex-row">
            <div class="w-6 shrink-0" />
            <div class="flex justify-start gap-x-2 bg-zinc-800 grow">
              <p class="text-base leading-tight bg-zinc-600 px-3 w-fit display-font">
                {from[id]}
              </p>
              {[Status.RE, Status.CE, Status.WA, Status.TL].includes(
                status,
              ) && (
                <p
                  class="text-base leading-tight px-3 w-fit display-font"
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
                  class="text-base leading-tight px-3 w-fit display-font"
                  style={{ background: BLUE_COLOR }}
                  onClick={handleAdd}
                >
                  add testcase
                </button>
              )}
            </div>
          </div>
          <div class="flex flex-row">
            <ArrowSvgOutwards color="#FFFFFF" onClick={handleView} />
            <pre class="text-base display-font">{data}</pre>
          </div>
        </div>
      );
  }
}
