import type { Signal } from "@preact/signals";
import { useCallback, useLayoutEffect, useRef } from "preact/hooks";

interface Props {
  input: Signal<string>;
  onKeyUp: (event: KeyboardEvent) => void;
}

export default function App({ input, onKeyUp }: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    // biome-ignore lint/style/noNonNullAssertion: Reference is guaranteed to be set
    textarea.current!.style.height = "inherit";
    // biome-ignore lint/style/noNonNullAssertion: Reference is guaranteed to be set
    textarea.current!.style.height = `${textarea.current!.scrollHeight}px`;
  }, [input.value]);

  const handleInput = useCallback((event: Event) => {
    const target = event.currentTarget as HTMLTextAreaElement;
    input.value = target.value;
  }, []);

  return (
    <textarea
      ref={textarea}
      class="text-base"
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
      onInput={handleInput}
      onKeyUp={onKeyUp}
      placeholder="Input here..."
    />
  );
}
