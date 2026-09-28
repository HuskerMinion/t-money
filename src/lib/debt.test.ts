import { describe, expect, it } from "vitest";
import { amortize, formatAprBp, monthAfter, monthInterest, parseAprBp, paymentFor, plan } from "./debt";

describe("the debt planner's arithmetic (§55)", () => {
  it("computes a month's interest in whole cents, half away from zero", () => {
    expect(monthInterest(100_000, 1200)).toBe(1_000); // $1,000 at 12% → $10
    expect(monthInterest(1_742_200, 650)).toBe(9_437); // 17,422 × 6.5% / 12 = 94.369…
    expect(monthInterest(0, 650)).toBe(0);
    expect(monthInterest(100, 0)).toBe(0);
  });

  it("amortizes a loan payment by payment", () => {
    // $1,000 at 12%, $100 a month: 11 months, $58.98 interest (checked by hand, month by month).
    const a = amortize(100_000, 1200, 10_000);
    expect(a.months).toBe(11);
    expect(a.total_interest_cents).toBe(5_898);
    expect(a.total_paid_cents).toBe(105_898);
    expect(a.schedule[0]).toEqual({ month: 1, interest_cents: 1_000, principal_cents: 9_000, balance_cents: 91_000 });
    expect(a.schedule[a.schedule.length - 1].balance_cents).toBe(0);
    // The last payment is only what is left.
    expect(a.schedule[10].principal_cents + a.schedule[10].interest_cents).toBeLessThan(10_000);
  });

  it("says so when a payment never gets ahead of the interest", () => {
    expect(amortize(100_000, 1200, 1_000).never).toBe(true);
    expect(amortize(100_000, 1200, 1_000).months).toBeNull();
    expect(amortize(0, 1200, 1_000).months).toBe(0);
  });

  it("finds the payment for a deadline, to the cent", () => {
    const p = paymentFor(100_000, 1200, 12)!;
    expect(p).toBe(8_885); // the standard 12-month payment on $1,000 at 12% is $88.85
    expect(amortize(100_000, 1200, p).months).toBe(12);
    expect(amortize(100_000, 1200, p - 1).months).toBe(13);
    expect(paymentFor(100_000, 0, 4)).toBe(25_000);
    expect(paymentFor(0, 1200, 4)).toBe(0);
    expect(paymentFor(100_000, 1200, 0)).toBeNull();
  });

  it("plans every debt with one budget, highest rate first, rolling payments over", () => {
    const debts = [
      { id: "visa", name: "Visa", balance_cents: 50_000, apr_bp: 2199, min_payment_cents: 2_500 },
      { id: "truck", name: "Truck loan", balance_cents: 200_000, apr_bp: 650, min_payment_cents: 15_000 },
    ];
    const p = plan(debts, 30_000, "highest_rate");
    expect(p.problem).toBeNull();
    expect(p.minimums_cents).toBe(17_500);
    const visa = p.debts.find((d) => d.id === "visa")!;
    const truck = p.debts.find((d) => d.id === "truck")!;
    // Month 1: truck gets its $150 minimum, Visa gets the other $150 (min + extra).
    expect(p.timeline[0].payments).toEqual({ visa: 15_000, truck: 15_000 });
    // Visa is gone first, then the whole $300 goes on the truck.
    expect(visa.paid_off_month).toBeLessThan(truck.paid_off_month!);
    const after = p.timeline[visa.paid_off_month!];
    expect(after.payments.truck).toBe(30_000);
    expect(p.months).toBe(truck.paid_off_month);
    expect(p.timeline[p.timeline.length - 1].total_balance_cents).toBe(0);
    expect(p.total_interest_cents).toBe(visa.interest_cents + truck.interest_cents);

    // The snowball pays the smaller balance first regardless of rate.
    const s = plan([{ ...debts[0], apr_bp: 100 }, debts[1]], 30_000, "smallest_balance");
    expect(s.debts.find((d) => d.id === "visa")!.paid_off_month).toBeLessThan(s.debts.find((d) => d.id === "truck")!.paid_off_month!);
    // Cheapest order costs less interest than the snowball when the rates say so.
    const cheap = plan(debts, 30_000, "highest_rate");
    const snow = plan(debts, 30_000, "smallest_balance");
    expect(cheap.total_interest_cents).toBeLessThanOrEqual(snow.total_interest_cents);
  });

  it("refuses a budget under the minimums or one that never wins", () => {
    const debts = [{ id: "a", name: "A", balance_cents: 100_000, apr_bp: 2400, min_payment_cents: 1_000 }];
    expect(plan(debts, 500, "highest_rate").problem).toMatch(/below the minimum/);
    expect(plan(debts, 1_000, "highest_rate").problem).toMatch(/never gets ahead/);
    expect(plan([], 1_000, "highest_rate").months).toBe(0);
  });

  it("reads and writes rates and names the payoff month", () => {
    expect(parseAprBp("6.5")).toBe(650);
    expect(parseAprBp("21.99%")).toBe(2199);
    expect(parseAprBp("7")).toBe(700);
    expect(parseAprBp("abc")).toBeNull();
    expect(parseAprBp("6.555")).toBeNull();
    expect(formatAprBp(650)).toBe("6.5%");
    expect(formatAprBp(2199)).toBe("21.99%");
    expect(formatAprBp(700)).toBe("7%");
    expect(monthAfter("2026-09-06", 11)).toBe("Aug 2027");
  });
});
