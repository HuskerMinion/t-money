// Money's account taxonomy and its groupings, read off the real
// "Choose an account type" wizard in reference/. Kept in sync with the CHECK
// constraint in migration 0009.
//
// Money's step 1 offers "Bill payment service provider" as a fifth category —
// deliberately out of scope, so it is absent here and from the CHECK.
import type { AccountType } from "./types";

/** The four headings the Account List groups accounts under. */
export type AccountGroup =
  | "Bank Accounts"
  | "Credit Accounts"
  | "Investment Accounts"
  | "Other Accounts";

/** The wizard's step-1 categories. */
export type AccountCategory = "banking" | "credit" | "investment" | "other";

export interface AccountTypeInfo {
  value: AccountType;
  label: string;
  description: string;
  group: AccountGroup;
  /** Step-1 categories that offer this type. "other" offers everything. */
  categories: AccountCategory[];
}

export const ACCOUNT_TYPES: AccountTypeInfo[] = [
  {
    value: "bank",
    label: "Bank",
    description: "Use bank accounts to track general banking activity.",
    group: "Bank Accounts",
    categories: ["banking", "other"],
  },
  {
    value: "checking",
    label: "Checking",
    description:
      "Use checking accounts to track all your checking activity, including debit card transactions.",
    group: "Bank Accounts",
    categories: ["banking", "other"],
  },
  {
    value: "savings",
    label: "Savings",
    description: "Use savings accounts to track money you are setting aside.",
    group: "Bank Accounts",
    categories: ["banking", "other"],
  },
  {
    value: "credit",
    label: "Credit Card",
    description: "Use credit card accounts to track all your credit card activity.",
    group: "Credit Accounts",
    categories: ["credit", "other"],
  },
  {
    value: "line_of_credit",
    label: "Line of Credit",
    description: "Use line of credit accounts to track borrowing against a credit line.",
    group: "Credit Accounts",
    categories: ["credit", "other"],
  },
  {
    value: "employee_stock_option",
    label: "Employee Stock Option",
    description: "Use employee stock option accounts to track options granted by an employer.",
    group: "Investment Accounts",
    categories: ["investment", "other"],
  },
  {
    value: "investment",
    label: "Investment",
    description:
      "Use investment accounts to store individual investments such as stocks, bonds, mutual funds, CDs, or U.S. Savings Bonds. If you have an Education IRA, use an investment account, not a retirement account.",
    group: "Investment Accounts",
    categories: ["investment", "other"],
  },
  {
    value: "retirement",
    label: "Retirement",
    description: "Use retirement accounts to track 401(k), IRA and similar retirement savings.",
    group: "Investment Accounts",
    categories: ["investment", "other"],
  },
  {
    value: "watch",
    label: "Watch",
    description: "Use watch accounts to follow investments you do not own.",
    group: "Investment Accounts",
    categories: ["investment", "other"],
  },
  {
    value: "asset",
    label: "Asset",
    description: "Use asset accounts to track things you own that are not cash or investments.",
    group: "Other Accounts",
    categories: ["other"],
  },
  {
    value: "vehicle",
    label: "Car or other Vehicle",
    description: "Use vehicle accounts to track the value of a car or other vehicle.",
    group: "Other Accounts",
    categories: ["other"],
  },
  {
    value: "cash",
    label: "Cash",
    description: "Use cash accounts to track spending money that is not in a bank.",
    group: "Other Accounts",
    categories: ["other"],
  },
  {
    value: "home",
    label: "Home",
    description: "Use home accounts to track the value of a house or other property.",
    group: "Other Accounts",
    categories: ["other"],
  },
  {
    value: "home_equity_line_of_credit",
    label: "Home Equity Line of Credit",
    description: "Use a home equity line of credit account to track borrowing against your home.",
    group: "Other Accounts",
    categories: ["other"],
  },
  {
    value: "liability",
    label: "Liability",
    description: "Use liability accounts to track money you owe that is not a loan or credit card.",
    group: "Other Accounts",
    categories: ["other"],
  },
  {
    value: "loan",
    label: "Loan",
    description: "Use loan accounts to track money you have borrowed and are paying back.",
    group: "Other Accounts",
    categories: ["other"],
  },
  {
    value: "mortgage",
    label: "Mortgage",
    description: "Use mortgage accounts to track a home loan and its payments.",
    group: "Other Accounts",
    categories: ["other"],
  },
  {
    value: "other",
    label: "Other",
    description: "Use an other account for anything that does not fit the types above.",
    group: "Other Accounts",
    categories: ["other"],
  },
];

/** Money's step-1 radio list. */
export const ACCOUNT_CATEGORIES: { value: AccountCategory; label: string }[] = [
  { value: "banking", label: "Banking" },
  { value: "credit", label: "Credit card" },
  { value: "investment", label: "Investment" },
  { value: "other", label: "Other account type (such as loan, asset, or watch accounts)" },
];

/** The order the Account List renders its groups in. */
export const ACCOUNT_GROUPS: AccountGroup[] = [
  "Bank Accounts",
  "Credit Accounts",
  "Investment Accounts",
  "Other Accounts",
];

export function typesForCategory(category: AccountCategory): AccountTypeInfo[] {
  return ACCOUNT_TYPES.filter((t) => t.categories.includes(category));
}

export function typeInfo(value: string): AccountTypeInfo | undefined {
  return ACCOUNT_TYPES.find((t) => t.value === value);
}

export function groupFor(value: string): AccountGroup {
  return typeInfo(value)?.group ?? "Other Accounts";
}

export function labelFor(value: string): string {
  return typeInfo(value)?.label ?? value;
}

/** The kinds whose value is a judgment rather than a balance. These
 *  get **Update value**; a checking account's balance is the sum of its
 *  transactions and nobody appraises it. Mirrors `queries::is_valued_asset`. */
export function isValuedAsset(kind: string): boolean {
  return kind === "asset" || kind === "vehicle" || kind === "home" || kind === "other";
}

/** The kinds that amortize: a rate, a payment, and a balance that
 *  falls as it is paid. A credit card is a debt but not one of these — its
 *  balance is whatever was charged, not a schedule. */
export function isAmortizable(kind: string): boolean {
  return (
    kind === "loan" ||
    kind === "mortgage" ||
    kind === "home_equity_line_of_credit" ||
    kind === "liability" ||
    kind === "line_of_credit"
  );
}

/** The kinds that can be secured on an asset. */
export function isDebt(kind: string): boolean {
  return (
    kind === "loan" ||
    kind === "mortgage" ||
    kind === "home_equity_line_of_credit" ||
    kind === "liability" ||
    kind === "line_of_credit" ||
    kind === "credit"
  );
}

/** What the register's two amount columns are called.
 *
 *  Money's register splits one signed amount across two columns, and the
 *  wording is the account type's, not the app's. On a checking account you
 *  make a Payment and take a Deposit. On a MORTGAGE you do neither: a
 *  principal payment is a positive amount because it moves the debt toward
 *  zero, so it landed under a column headed "Deposit" — arithmetically right
 *  and absurd to read. A debt that amortizes says Increase and Decrease.
 *
 *  Deliberately NOT credit cards. Money calls those columns Charge and
 *  Payment, which is a different fix, and a card's balance is whatever was
 *  charged rather than a schedule being paid down. Everything else — banking,
 *  cash, investments, houses, vehicles — keeps Payment and Deposit.
 *
 *  The left column always holds NEGATIVE amounts and the right positive ones,
 *  so on a debt the left one is the balance growing. */
export function registerColumnLabels(kind: string): { payment: string; deposit: string } {
  return isAmortizable(kind)
    ? { payment: "Increase", deposit: "Decrease" }
    : { payment: "Payment", deposit: "Deposit" };
}

/** What an account is worth: its register balance, plus — for an investment
 *  or retirement account — its holdings at the latest prices. Every
 *  place that prints an account's balance prints this. */
export function accountWorth(a: { balance_cents: number; holdings_value_cents?: number }): number {
  return a.balance_cents + (a.holdings_value_cents ?? 0);
}

/** The accounts a picker offers: the open ones, plus any closed account
 *  the thing being edited already names.
 *
 *  A closed account is out of every picker for NEW work (N9) — money moving
 *  into an account you closed is a mistake, and the backend refuses it too.
 *  But a transfer written before the close still points there, and a picker
 *  that does not hold its own current value shows blank and saves it away.
 *  So the row, rule or payment being edited passes the ids it already uses,
 *  and those stay on offer — exactly the links the backend lets it keep. */
export function pickableAccounts<T extends { id: string; is_closed?: boolean }>(
  accounts: readonly T[],
  keep: readonly (string | null | undefined)[] = []
): T[] {
  return accounts.filter((a) => !a.is_closed || keep.includes(a.id));
}

/** A sort helper for every list of accounts: the accounts that have
 *  been placed (Favorites → Organize favorites…) come first, in their order;
 *  0 when neither has been placed, so the list's own order decides. */
export function placedFirst(a: { sort_order?: number | null }, b: { sort_order?: number | null }): number {
  const x = a.sort_order ?? null;
  const y = b.sort_order ?? null;
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x - y;
}
