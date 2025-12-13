import { type Observable } from "@legendapp/state";
import { observer } from "@legendapp/state/react";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";

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
  variant?: Variant;
}

const AutoresizeTextarea = observer(function AutoresizeTextarea({
  input$,
  readonly,
  hiddenOnEmpty,
  placeholder,
  onKeyUp,
  variant = "default",
}: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const value = input$.get() ?? "";

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

  if (hiddenOnEmpty && (value === "" || value === "\n")) {
    return null;
  }

  return (
    <textarea
      ref={textarea}
      rows={1}
      style={{
        whiteSpace: "pre-wrap",
        resize: "none",
        border: `1px solid ${getVariantBorderColor(variant)}`,
        borderRadius: "2px",
        boxSizing: "border-box",
        background: "var(--vscode-editor-background)",
        width: "100%",
        marginBottom: "3px",
        overflowY: "hidden",
        outline: "none",
        fontFamily: "var(--vscode-editor-font-family)",
        fontSize: "var(--vscode-editor-font-size)",
        color: "var(--vscode-foreground)",
      }}
      readOnly={readonly}
      value={value}
      onChange={handleChange}
      onKeyUp={handleKeyUp}
      placeholder={placeholder}
    />
  );
});

export default AutoresizeTextarea;
