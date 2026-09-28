// Currency display: red accounting-paren style for negatives, green for
// explicit positives. All input is integer cents.
import { formatMoney } from "../lib/format";

interface MoneyProps {
  cents: number;
  /** Force a sign/color treatment. */
  tone?: "auto" | "positive" | "neutral";
  className?: string;
}

export default function Money({ cents, tone = "auto", className = "" }: MoneyProps) {
  let cls = "";
  if (tone === "positive") cls = "money-pos";
  else if (tone === "neutral") cls = "";
  else cls = cents < 0 ? "money-neg" : "";
  return <span className={`${cls} ${className}`.trim()}>{formatMoney(cents)}</span>;
}
