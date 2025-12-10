import type { Observable } from "@legendapp/state";
import { observer } from "@legendapp/state/react";
import { useCallback, useLayoutEffect, useRef } from "react";

interface Props {
  input$: Observable<string>;
  onKeyUp?: (event: KeyboardEvent) => void;
}

const AutoresizeTextarea = observer(function AutoresizeTextarea({ input$, onKeyUp }: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const value = input$.get();

  useLayoutEffect(() => {
    textarea.current!.style.height = "inherit";
    textarea.current!.style.height = `${textarea.current!.scrollHeight}px`;
  }, [value]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      input$.set(event.target.value);
    },
    [input$]
  );

  const handleKeyUp = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      onKeyUp?.(event.nativeEvent);
    },
    [onKeyUp]
  );

  return (
    <textarea
      ref={textarea}
      className="text-base"
      rows={1}
      style={{
        whiteSpace: "pre-line",
        resize: "none",
        border: "none",
        background: "none",
        width: "100%",
        overflowY: "hidden",
      }}
      value={value}
      onChange={handleChange}
      onKeyUp={handleKeyUp}
      placeholder="Input here..."
    />
  );
});

export default AutoresizeTextarea;
