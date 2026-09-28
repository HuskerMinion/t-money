// One category picker, used everywhere a category is chosen outside the
// register's own entry row: the split grid, the reconcile dialogs, the payee
// default and the budget form.
//
// Two things it centralizes, both from §6.1e:
//   1. Options show the FULL name — "Auto : Fuel" — because a bare "Fuel"
//      appearing twice under different parents is unusable.
//   2. `kind` filters the list. Money never offers an income category for a
//      payment, and the split grid's spent/received answer is exactly that
//      filter. With no `kind` the two groups are shown grouped rather than as
//      one flat list.
//
// It is now a thin adapter over `CategoryCombo` rather than a `<select>`.
// A native select only jumps by first letter, which is useless against 96
// categories that mostly read "Parent : Child" — so the register's entry form
// grew a type-ahead combobox (§17) and every OTHER picker kept the select,
// which §18.5 flagged as an inconsistency users would notice. Keeping the name
// and the props here means all four call sites gained type-ahead at once, and
// the full-name and `kind` rules still live in exactly one file.
import type { CSSProperties } from "react";
import CategoryCombo, { type ComboItem } from "./CategoryCombo";
import type { Account, Category, CategoryKind } from "../lib/types";

/** §102 — how a transfer is spelled inside a category picker.
 *
 *  Money has no separate "transfer" control: you pick "Transfer : Savings" in
 *  the Category field and it writes the paired row for you. The register's
 *  entry row has always done that with a `transfer:<id>` value; the split grid
 *  could not, so a split line could never be a transfer even though the
 *  database, the Rust and the ledger have supported it since §94.
 *
 *  The prefix lives here now, with the picker that produces it, rather than
 *  privately in one component. */
export const TRANSFER_PREFIX = "transfer:";

/** The account a picker value names, or null when it names a category. */
export function transferTargetOf(value: string): string | null {
  return value.startsWith(TRANSFER_PREFIX) ? value.slice(TRANSFER_PREFIX.length) : null;
}

/** The picker value for a transfer to `accountId`. */
export function transferValue(accountId: string): string {
  return `${TRANSFER_PREFIX}${accountId}`;
}

interface Props {
  categories: readonly Category[];
  value: string;
  onChange: (id: string) => void;
  /** Restrict to one side of the tree. Omit to offer both, grouped. */
  kind?: CategoryKind;
  /** Accessible name — every picker on screen needs a distinct one. */
  label: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  /** Text for the empty choice. */
  noneLabel?: string;
  /** Offer "Add <what you typed>…". Omit to hide it. */
  onAddNew?: (query: string) => void;
  /** Accounts this picker may transfer to, grouped under "Transfer" after the
   *  categories. Omit — the default — and the picker offers categories only,
   *  which is right everywhere a transfer would be meaningless (a budget
   *  target, a payee's default category). */
  transferTargets?: readonly Account[];
}

/** Categories of one kind, in the order the backend returned them. */
export function ofKind(
  categories: readonly Category[],
  kind: CategoryKind
): Category[] {
  return categories.filter((c) => c.kind === kind);
}

/** The combo items for a picker: full names, filtered and grouped by `kind`.
 *  Exported because the grouping rule is the thing worth testing directly. */
export function categoryItems(
  categories: readonly Category[],
  kind?: CategoryKind,
  transferTargets: readonly Account[] = []
): ComboItem[] {
  const item = (c: Category, group?: string): ComboItem => ({
    value: c.id,
    label: c.full_name,
    group,
  });
  // Money's own spelling, and the register's: "Transfer : Savings", in its
  // own group at the end of the list.
  const transfers: ComboItem[] = transferTargets.map((a) => ({
    value: transferValue(a.id),
    label: `Transfer : ${a.name}`,
    group: "Transfer",
  }));
  if (kind) {
    // The kind is already decided, so a single heading would be noise — but
    // the transfers still need theirs, or they read as more categories.
    const cats = ofKind(categories, kind).map((c) => item(c, transfers.length ? "Category" : undefined));
    return [...cats, ...transfers];
  }
  return [
    ...ofKind(categories, "income").map((c) => item(c, "Income")),
    ...ofKind(categories, "expense").map((c) => item(c, "Expense")),
    ...transfers,
  ];
}

export default function CategorySelect({
  categories,
  value,
  onChange,
  kind,
  label,
  className = "aero-field",
  style,
  disabled = false,
  noneLabel = "(none)",
  onAddNew,
  transferTargets,
}: Props) {
  return (
    <CategoryCombo
      items={categoryItems(categories, kind, transferTargets)}
      value={value}
      onChange={onChange}
      label={label}
      className={className}
      style={style}
      disabled={disabled}
      placeholder={noneLabel}
      onAddNew={onAddNew}
    />
  );
}
