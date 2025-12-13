import { type Observable } from "@legendapp/state";
import { observer } from "@legendapp/state/react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

type Variant = "default" | "stderr" | "accepted" | "active";

function getVariantBorderColor(variant: Variant): string {
  switch (variant) {
    case "stderr":
      return "var(--vscode-terminal-ansiRed)";
    case "accepted":
      return "var(--vscode-terminal-ansiGreen)";
    case "active":
      return "var(--vscode-inputOption-activeBorder)";
    default:
      return "var(--vscode-editorWidget-border)";
  }
}

interface Props {
  input$: Observable<string>;
  readonly?: boolean;
  hiddenOnEmpty?: boolean;
  placeholder?: string;
  onKeyUp?: (event: React.KeyboardEvent) => void;
  onExpand?: () => void;
  variant?: Variant;
}

const AutoresizeTextarea = observer(function AutoresizeTextarea({
  input$,
  readonly,
  hiddenOnEmpty,
  placeholder,
  onKeyUp,
  onExpand,
  variant = "default",
}: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const value = input$.get() ?? "";
  const [isHovered, setIsHovered] = useState(false);

  useLayoutEffect(() => {
    if (textarea.current) {
      textarea.current!.style.height = "inherit";
      textarea.current!.style.height = `${textarea.current!.scrollHeight}px`;
    }
  });

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      input$.set(event.target.value);
    },
    [input$]
  );

  const handleKeyUp = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      onKeyUp?.(event);
    },
    [onKeyUp]
  );

  const handleExpand = useCallback(() => {
    console.log("expand");
    onExpand?.();
  }, [onExpand]);

  const handleMouseEnter = useCallback(() => {
    setIsHovered(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
  }, []);

  if (hiddenOnEmpty && (value === "" || value === "\n")) {
    return null;
  }

  const contentStyle = {
    whiteSpace: "pre-wrap" as const,
    border: `1px solid ${getVariantBorderColor(variant)}`,
    borderRadius: "2px" as const,
    boxSizing: "border-box" as const,
    background: "var(--vscode-editor-background)",
    width: "100%" as const,
    marginBottom: "3px" as const,
    fontFamily: "var(--vscode-editor-font-family)",
    fontSize: "var(--vscode-editor-font-size)",
    color: "var(--vscode-foreground)",
  };

  const expandButtonStyle = {
    position: "absolute" as const,
    top: "2px" as const,
    right: "2px" as const,
    border: "none" as const,
    background: "transparent" as const,
    color: "var(--vscode-foreground)",
    cursor: "pointer" as const,
    padding: "2px" as const,
    display: "flex" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    opacity: isHovered ? 1 : 0,
    transition: "opacity 120ms ease-in-out",
    pointerEvents: isHovered ? ("auto" as const) : ("none" as const),
  };

  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {readonly ? (
        <div
          style={{
            ...contentStyle,
            padding: "4px",
            color: value ? "var(--vscode-foreground)" : "var(--vscode-input-placeholderForeground)",
          }}
        >
          {value || placeholder}
        </div>
      ) : (
        <textarea
          ref={textarea}
          rows={1}
          style={{
            ...contentStyle,
            resize: "none",
            overflowY: "hidden",
            outline: "none",
          }}
          readOnly={readonly}
          value={value}
          onChange={handleChange}
          onKeyUp={handleKeyUp}
          placeholder={placeholder}
        />
      )}
      {!!onExpand && (
        <button
          type="button"
          aria-label="Expand"
          className="codicon codicon-screen-full"
          onClick={handleExpand}
          style={expandButtonStyle}
        />
      )}
    </div>
  );
});

export default AutoresizeTextarea;
