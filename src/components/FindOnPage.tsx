// The box Ctrl+F lands in on a screen that is a table of named lines.
//
// It registers for `edit.find` at a higher priority than the shell's header
// search for exactly as long as it is on screen, so Ctrl+F on the Budget tab
// finds a budget line and Ctrl+F anywhere else still finds a transaction.
// Escape clears it and gives focus back to the page.
import { useRef } from "react";
import { useCommand } from "../lib/useCommand";

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** What a match is, for the placeholder: "category", say. */
  what: string;
}

export default function FindOnPage({ value, onChange, what }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  useCommand(
    "edit.find",
    () => {
      ref.current?.focus();
      ref.current?.select();
    },
    true,
    10
  );
  return (
    <span className="tm-find-on-page inline-flex items-center gap-1">
      <input
        ref={ref}
        className="aero-field"
        type="search"
        aria-label="Find on this page"
        placeholder={`Find a ${what} on this page`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onChange("");
            ref.current?.blur();
          }
        }}
        style={{ width: 200 }}
      />
      {value && (
        <button type="button" className="aero-btn !py-0 !px-2" aria-label="Clear find" onClick={() => onChange("")}>
          ✕
        </button>
      )}
    </span>
  );
}
