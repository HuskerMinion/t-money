// A picker over the fixed tax-line list (§43). Empty = no line. A value not
// on the list (older files, hand-typed) is shown as its own option so it is
// never silently rewritten; "Other…" lets one be typed.
import { useState } from "react";
import { isKnownLine, TAX_FORMS, TAX_LINES } from "../lib/taxLines";

interface Props {
  value: string;
  onChange: (line: string) => void;
  id?: string;
  label?: string;
  className?: string;
  disabled?: boolean;
}

const OTHER = " other";

export default function TaxLinePicker({ value, onChange, id, label = "Tax line", className = "aero-field", disabled = false }: Props) {
  const [other, setOther] = useState(false);
  const custom = value !== "" && !isKnownLine(value);
  return (
    <span className="inline-flex items-center gap-1">
      <select
        id={id}
        className={className}
        aria-label={label}
        value={other ? OTHER : value}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setOther(true);
          } else {
            setOther(false);
            onChange(e.target.value);
          }
        }}
      >
        <option value="">(no tax line)</option>
        {custom && <option value={value}>{value}</option>}
        {TAX_FORMS.map((f) => (
          <optgroup key={f} label={f}>
            {TAX_LINES.filter((t) => t.form === f).map((t) => (
              <option key={t.line} value={t.line}>
                {t.line.slice(f.length + 1).trim()}
              </option>
            ))}
          </optgroup>
        ))}
        <option value={OTHER}>Other…</option>
      </select>
      {other && (
        <input
          className="aero-field"
          aria-label={`${label} (other)`}
          placeholder="Form: line"
          autoFocus
          defaultValue={custom ? value : ""}
          onBlur={(e) => {
            const v = e.target.value.trim();
            setOther(false);
            if (v) onChange(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      )}
    </span>
  );
}
