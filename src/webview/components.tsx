import type { FunctionComponent } from "preact";
import { useCallback } from "preact/hooks";

export const GRAY_COLOR = "#52525C";
export const GREEN_COLOR = "#475B45";
export const RED_COLOR = "#6C4549";
export const BLUE_COLOR = "#4C6179";

interface ArrowSvgPropsGeneric extends ArrowSvgProps {
  d: string;
}
interface ArrowSvgProps {
  color: string;
  onClick?: () => unknown;
}

const ArrowSvg: FunctionComponent<ArrowSvgPropsGeneric> = ({
  d,
  color,
  onClick,
}: ArrowSvgPropsGeneric) => {
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === "Enter") onClick?.();
  }, [onClick]);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      class="w-4 h-4 mr-2 mt-1 shrink-0"
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      <title>Arrow</title>
      <path fill={color} fillRule="evenodd" d={d} clipRule="evenodd" />
    </svg>
  );
};

export const ArrowSvgInwards = ({ color, onClick }: ArrowSvgProps) => (
  <ArrowSvg
    d="M2 8a.75.75 0 0 1 .75-.75h8.69L8.22 4.03a.75.75 0 0 1 1.06-1.06l4.5 4.5a.75.75 0 0 1 0 1.06l-4.5 4.5a.75.75 0 0 1-1.06-1.06l3.22-3.22H2.75A.75.75 0 0 1 2 8Z"
    color={color}
    onClick={onClick}
  />
);
export const ArrowSvgOutwards = ({ color, onClick }: ArrowSvgProps) => (
  <ArrowSvg
    d="M14 8a.75.75 0 0 1-.75.75H4.56l3.22 3.22a.75.75 0 1 1-1.06 1.06l-4.5-4.5a.75.75 0 0 1 0-1.06l4.5-4.5a.75.75 0 0 1 1.06 1.06L4.56 7.25h8.69A.75.75 0 0 1 14 8Z"
    color={color}
    onClick={onClick}
  />
);
