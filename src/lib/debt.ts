// Money's Debt Reduction Planner and Mini-Debt Reduction Planner (§55), as
// arithmetic. Everything is integer: balances and payments in cents, rates
// in basis points (6.5% = 650), months whole. Interest for a month is
// round(balance × apr / 12), the way a card or loan statement computes it;
// BigInt keeps the product exact.
//
// What the planner answers:
//   amortize   — one debt, a payment: how many months, how much interest.
//   paymentFor — one debt, a deadline: the payment that gets there.
//   plan       — every debt, one monthly budget, highest rate first (the
//                cheapest order) or smallest balance first (the snowball):
//                minimums on everything, the rest onto the first in line,
//                each payoff rolling its payment onto the next.

export interface Debt {
  id: string;
  name: string;
  /** What is owed, positive. */
  balance_cents: number;
  apr_bp: number;
  /** The required monthly payment. */
  min_payment_cents: number;
}

export interface ScheduleRow {
  month: number;
  interest_cents: number;
  principal_cents: number;
  balance_cents: number;
}

export interface Amortization {
  /** Months until the balance is zero; null when the payment never gets there. */
  months: number | null;
  total_interest_cents: number;
  total_paid_cents: number;
  schedule: ScheduleRow[];
  /** The payment does not even cover the first month's interest. */
  never: boolean;
}

/** Safety stop: 100 years of months. */
const MAX_MONTHS = 1200;

/** round(balance × apr_bp / 120_000): a month's interest, half away from zero. */
export function monthInterest(balanceCents: number, aprBp: number): number {
  if (balanceCents <= 0 || aprBp <= 0) return 0;
  const n = BigInt(balanceCents) * BigInt(aprBp);
  const d = 120_000n;
  return Number((n + d / 2n) / d);
}

export function amortize(balanceCents: number, aprBp: number, paymentCents: number): Amortization {
  const schedule: ScheduleRow[] = [];
  let balance = Math.max(0, balanceCents);
  let interestTotal = 0;
  let paid = 0;
  if (balance === 0) return { months: 0, total_interest_cents: 0, total_paid_cents: 0, schedule, never: false };
  const firstInterest = monthInterest(balance, aprBp);
  if (paymentCents <= firstInterest) {
    return { months: null, total_interest_cents: 0, total_paid_cents: 0, schedule, never: true };
  }
  let month = 0;
  while (balance > 0 && month < MAX_MONTHS) {
    month++;
    const interest = monthInterest(balance, aprBp);
    const due = balance + interest;
    const payment = Math.min(paymentCents, due);
    const principal = payment - interest;
    balance = due - payment;
    interestTotal += interest;
    paid += payment;
    schedule.push({ month, interest_cents: interest, principal_cents: principal, balance_cents: balance });
  }
  return {
    months: balance === 0 ? month : null,
    total_interest_cents: interestTotal,
    total_paid_cents: paid,
    schedule,
    never: false,
  };
}

/** The smallest whole-cent payment that clears the balance within `months`. */
export function paymentFor(balanceCents: number, aprBp: number, months: number): number | null {
  if (balanceCents <= 0) return 0;
  if (months <= 0) return null;
  // Bounds: the whole balance in one month at most; interest-only is never enough.
  let lo = monthInterest(balanceCents, aprBp) + 1;
  let hi = balanceCents + monthInterest(balanceCents, aprBp);
  if (amortize(balanceCents, aprBp, hi).months! > months) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const m = amortize(balanceCents, aprBp, mid).months;
    if (m !== null && m <= months) hi = mid;
    else lo = mid + 1;
  }
  return hi;
}

export type PlanOrder = "highest_rate" | "smallest_balance";

export interface PlanDebt extends Debt {
  paid_off_month: number | null;
  interest_cents: number;
}

export interface PlanMonth {
  month: number;
  /** Payment to each debt this month, by id. */
  payments: Record<string, number>;
  balances: Record<string, number>;
  total_balance_cents: number;
}

export interface Plan {
  order: PlanOrder;
  budget_cents: number;
  /** Sum of the minimums — the budget must cover at least this. */
  minimums_cents: number;
  months: number | null;
  total_interest_cents: number;
  debts: PlanDebt[];
  timeline: PlanMonth[];
  /** The budget is below the minimums, or never gets ahead of the interest. */
  problem: string | null;
}

export function plan(debts: readonly Debt[], budgetCents: number, order: PlanOrder): Plan {
  const live = debts.filter((d) => d.balance_cents > 0);
  const minimums = live.reduce((n, d) => n + d.min_payment_cents, 0);
  const out: Plan = { order, budget_cents: budgetCents, minimums_cents: minimums, months: null, total_interest_cents: 0, debts: live.map((d) => ({ ...d, paid_off_month: null, interest_cents: 0 })), timeline: [], problem: null };
  if (live.length === 0) {
    out.months = 0;
    return out;
  }
  if (budgetCents < minimums) {
    out.problem = `The budget is below the minimum payments (${minimums} cents a month).`;
    return out;
  }
  const rank = [...out.debts].sort((a, b) => (order === "highest_rate" ? b.apr_bp - a.apr_bp || a.balance_cents - b.balance_cents : a.balance_cents - b.balance_cents || b.apr_bp - a.apr_bp));
  const balance: Record<string, number> = Object.fromEntries(live.map((d) => [d.id, d.balance_cents]));
  let month = 0;
  while (month < MAX_MONTHS && rank.some((d) => balance[d.id] > 0)) {
    month++;
    // Interest first, then minimums on everything still owed, then the
    // rest of the budget onto the first debt in line, spilling over.
    const interest: Record<string, number> = {};
    for (const d of rank) {
      interest[d.id] = monthInterest(balance[d.id], d.apr_bp);
      balance[d.id] += interest[d.id];
      d.interest_cents += interest[d.id];
      out.total_interest_cents += interest[d.id];
    }
    let left = budgetCents;
    const payments: Record<string, number> = {};
    for (const d of rank) {
      if (balance[d.id] <= 0) continue;
      const p = Math.min(d.min_payment_cents, balance[d.id], left);
      payments[d.id] = p;
      balance[d.id] -= p;
      left -= p;
    }
    for (const d of rank) {
      if (left <= 0) break;
      if (balance[d.id] <= 0) continue;
      const p = Math.min(balance[d.id], left);
      payments[d.id] = (payments[d.id] ?? 0) + p;
      balance[d.id] -= p;
      left -= p;
    }
    for (const d of rank) {
      if (balance[d.id] === 0 && d.paid_off_month === null) d.paid_off_month = month;
    }
    const total = rank.reduce((n, d) => n + balance[d.id], 0);
    out.timeline.push({ month, payments, balances: { ...balance }, total_balance_cents: total });
    if (month > 1 && total >= out.timeline[month - 2].total_balance_cents) {
      out.problem = "The budget never gets ahead of the interest.";
      return out;
    }
  }
  out.months = rank.every((d) => balance[d.id] === 0) ? month : null;
  return out;
}

/** "6.5" → 650; up to two decimals; null when it is not a rate. */
export function parseAprBp(input: string): number | null {
  const m = /^\s*(\d+)(?:\.(\d{0,2}))?\s*%?\s*$/.exec(input.replace(/,/g, ""));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export function formatAprBp(bp: number): string {
  const s = `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, "0")}`;
  return s.replace(/\.?0+$/, "") + "%";
}

/** The month `n` months after an ISO date, as "Mon YYYY". */
export function monthAfter(iso: string, n: number): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}
