import type { Signal } from "@preact/signals-react";
import { useSignals } from "@preact/signals-react/runtime";
import { useCallback, useLayoutEffect, useRef } from "react";

interface Props {
  input: Signal<string>;
  onKeyUp?: (event: KeyboardEvent) => void;
}

export default function AutoresizeTextarea({ input, onKeyUp }: Props) {
  useSignals();
  const textarea = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    textarea.current!.style.height = "inherit";
    textarea.current!.style.height = `${textarea.current!.scrollHeight}px`;
  }, [input.value]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      input.value = event.target.value;
    },
    [input]
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
      value={input.value}
      onChange={handleChange}
      onKeyUp={handleKeyUp}
      placeholder="Input here..."
    />
  );
}
