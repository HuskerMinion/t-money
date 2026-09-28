//! Turning a recurrence rule into dates.
//!
//! This module is pure: dates in, dates out, no database and no clock beyond
//! what the caller passes. That is deliberate. Every bug a scheduled-bills
//! feature has ever had lives here — the 31st in February, the fortnight that
//! drifts a day a year, the occurrence that lands on the boundary of the
//! window and gets counted twice — and pure functions are the only ones that
//! can be tested exhaustively.
//!
//! The rule is stored (`recurrences`), the occurrences are NOT. Asking for a
//! window recomputes them, so a horizon change is a query parameter and there
//! is nothing to regenerate or keep in step.

use chrono::{Datelike, Duration, NaiveDate, Weekday};

/// How often a recurrence repeats. `interval_n` multiplies it: 2 with
/// `Weekly` is fortnightly, 3 with `Monthly` is quarterly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freq {
    Once,
    Weekly,
    /// Twice a month, on `start_date`'s day and `second_day` — the pattern
    /// most salaries actually follow, and one a monthly rule cannot express.
    SemiMonthly,
    Monthly,
    Yearly,
}

impl Freq {
    pub fn parse(s: &str) -> Result<Self, String> {
        Ok(match s {
            "once" => Freq::Once,
            "weekly" => Freq::Weekly,
            "semi_monthly" => Freq::SemiMonthly,
            "monthly" => Freq::Monthly,
            "yearly" => Freq::Yearly,
            other => return Err(format!("unknown frequency {other:?}")),
        })
    }
}

/// What to do when an occurrence lands on a weekend.
///
/// No holiday calendar, deliberately: holidays are jurisdiction-specific and
/// would need maintaining every year, and a stale holiday table gives wrong
/// dates with the same confidence as a right one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WeekendRule {
    None,
    /// Move to the preceding Friday — how most direct debits behave.
    Before,
    /// Move to the following Monday.
    After,
}

impl WeekendRule {
    pub fn parse(s: &str) -> Result<Self, String> {
        Ok(match s {
            "none" => WeekendRule::None,
            "before" => WeekendRule::Before,
            "after" => WeekendRule::After,
            other => return Err(format!("unknown weekend rule {other:?}")),
        })
    }
}

/// The rule, with everything the generator needs and nothing it does not.
#[derive(Debug, Clone)]
pub struct Rule {
    pub freq: Freq,
    pub interval_n: u32,
    pub start: NaiveDate,
    pub end: Option<NaiveDate>,
    pub second_day: Option<u32>,
    pub weekend_rule: WeekendRule,
}

/// The last day of the month `y`-`m`.
fn last_day_of_month(y: i32, m: u32) -> u32 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .map(|d| d.day())
        .unwrap_or(28)
}

/// `y`-`m`-`day`, clamped to the end of the month.
///
/// **This is the classic bug in this kind of code.** A bill due on the 31st
/// has no 31st in February; the answer is the 28th (or 29th), not "skip
/// February" and not "the 3rd of March". Clamping also has to be done from the
/// ORIGINAL day each time — anchoring on the clamped date would walk a
/// month-end bill backwards to the 28th forever.
fn clamped(y: i32, m: u32, day: u32) -> Option<NaiveDate> {
    let d = day.min(last_day_of_month(y, m));
    NaiveDate::from_ymd_opt(y, m, d)
}

/// Add `n` months to (`y`, `m`), returning the new year and month.
pub fn add_months(y: i32, m: u32, n: i64) -> (i32, u32) {
    let zero = y as i64 * 12 + (m as i64 - 1) + n;
    ((zero.div_euclid(12)) as i32, (zero.rem_euclid(12) + 1) as u32)
}

/// Shift off a weekend, if the rule says to.
fn apply_weekend(date: NaiveDate, rule: WeekendRule) -> NaiveDate {
    match (rule, date.weekday()) {
        (WeekendRule::None, _) => date,
        (WeekendRule::Before, Weekday::Sat) => date - Duration::days(1),
        (WeekendRule::Before, Weekday::Sun) => date - Duration::days(2),
        (WeekendRule::After, Weekday::Sat) => date + Duration::days(2),
        (WeekendRule::After, Weekday::Sun) => date + Duration::days(1),
        _ => date,
    }
}

/// Every occurrence of `rule` whose **due date** falls in `[from, to]`,
/// inclusive at both ends, oldest first.
///
/// The weekend shift is applied to the generated date and the SHIFTED date is
/// what the window is tested against — that is the date the money actually
/// moves, which is what a forecast is about. It also means a rule can produce
/// a date just outside its own start/end bounds after shifting, which is
/// correct: a bill due Sunday the 1st and paid Friday the 30th is still that
/// bill.
pub fn occurrences(rule: &Rule, from: NaiveDate, to: NaiveDate) -> Vec<NaiveDate> {
    let mut out = Vec::new();
    if to < from || rule.interval_n == 0 {
        return out;
    }
    // A generous cap: nothing legitimate produces this many dates in a window
    // a person would ask for, and it stops a malformed rule spinning forever.
    const MAX: usize = 2_000;

    let step = rule.interval_n as i64;
    let push = |raw: NaiveDate, out: &mut Vec<NaiveDate>| {
        if let Some(end) = rule.end {
            if raw > end {
                return;
            }
        }
        if raw < rule.start {
            return;
        }
        let d = apply_weekend(raw, rule.weekend_rule);
        if d >= from && d <= to {
            out.push(d);
        }
    };

    match rule.freq {
        Freq::Once => push(rule.start, &mut out),

        Freq::Weekly => {
            let period = Duration::days(7 * step);
            // Jump most of the way rather than stepping from the start date,
            // which for a decade-old fortnightly rule is thousands of hops.
            let mut d = rule.start;
            if d < from {
                let days = (from - d).num_days();
                let periods = days / (7 * step);
                d += Duration::days(periods * 7 * step);
            }
            // Back off one period so a weekend shift cannot skip the first
            // occurrence in the window.
            d -= period;
            while d <= to + period && out.len() < MAX {
                push(d, &mut out);
                d += period;
            }
        }

        Freq::Monthly | Freq::Yearly => {
            let months_per = if rule.freq == Freq::Yearly { 12 * step } else { step };
            let day = rule.start.day();
            let (mut y, mut m) = (rule.start.year(), rule.start.month());
            // Skip ahead to the window, then back one period for the same
            // reason as above.
            let ahead = (from.year() as i64 * 12 + from.month() as i64 - 1)
                - (y as i64 * 12 + m as i64 - 1);
            if ahead > months_per {
                let jumps = ahead / months_per;
                let (ny, nm) = add_months(y, m, jumps * months_per);
                y = ny;
                m = nm;
            }
            let (py, pm) = add_months(y, m, -months_per);
            y = py;
            m = pm;
            while out.len() < MAX {
                if let Some(d) = clamped(y, m, day) {
                    if apply_weekend(d, rule.weekend_rule) > to && d > to {
                        break;
                    }
                    push(d, &mut out);
                }
                let (ny, nm) = add_months(y, m, months_per);
                y = ny;
                m = nm;
                if NaiveDate::from_ymd_opt(y, m, 1).map(|d| d > to + Duration::days(31)) != Some(false) {
                    break;
                }
            }
        }

        Freq::SemiMonthly => {
            // Two days a month. `interval_n` is ignored: "twice a month every
            // two months" is not a thing anyone means.
            let mut days = vec![rule.start.day()];
            if let Some(sd) = rule.second_day {
                if sd != rule.start.day() {
                    days.push(sd);
                }
            }
            days.sort_unstable();
            let (mut y, mut m) = (from.year(), from.month());
            // Start a month early so a weekend shift into the window is caught.
            let (py, pm) = add_months(y, m, -1);
            y = py;
            m = pm;
            while out.len() < MAX {
                for &day in &days {
                    if let Some(d) = clamped(y, m, day) {
                        push(d, &mut out);
                    }
                }
                let (ny, nm) = add_months(y, m, 1);
                y = ny;
                m = nm;
                // §180: keep going while next month's 1st could still be
                // pulled back into the window. `WeekendRule::Before` moves a
                // Sunday the 1st two days earlier, so a window ending on
                // Friday 27 February must still generate 1 March — stopping
                // at `d > to` silently dropped that payday from the forecast.
                // Two days is the largest backward shift; months past it only
                // generate dates `push` throws away.
                if NaiveDate::from_ymd_opt(y, m, 1).map(|d| d > to + Duration::days(2)) != Some(false) {
                    break;
                }
            }
            out.sort_unstable();
        }
    }
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").expect("date")
    }

    fn rule(freq: Freq, start: &str) -> Rule {
        Rule {
            freq,
            interval_n: 1,
            start: d(start),
            end: None,
            second_day: None,
            weekend_rule: WeekendRule::None,
        }
    }

    fn dates(r: &Rule, from: &str, to: &str) -> Vec<String> {
        occurrences(r, d(from), d(to))
            .into_iter()
            .map(|x| x.to_string())
            .collect()
    }

    // ── monthly, and the month-end case that breaks these generators ─────

    #[test]
    fn monthly_repeats_on_the_same_day() {
        let r = rule(Freq::Monthly, "2026-01-15");
        assert_eq!(
            dates(&r, "2026-01-01", "2026-04-30"),
            ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"]
        );
    }

    #[test]
    fn a_bill_due_on_the_31st_lands_on_the_last_day_of_short_months() {
        // THE classic bug. February has no 31st: the answer is the 28th, not
        // "skip February" and not "the 3rd of March".
        let r = rule(Freq::Monthly, "2026-01-31");
        assert_eq!(
            dates(&r, "2026-01-01", "2026-05-31"),
            ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]
        );
    }

    #[test]
    fn clamping_does_not_walk_a_month_end_bill_backwards() {
        // The follow-on bug: if March anchored on February's clamped 28th, the
        // bill would be stuck on the 28th forever after one short month.
        let r = rule(Freq::Monthly, "2026-01-31");
        let got = dates(&r, "2026-02-01", "2026-03-31");
        assert_eq!(got, ["2026-02-28", "2026-03-31"]);
    }

    #[test]
    fn the_29th_of_february_is_honored_in_a_leap_year() {
        let r = rule(Freq::Monthly, "2026-01-29");
        assert_eq!(
            dates(&r, "2028-01-01", "2028-03-31"),
            ["2028-01-29", "2028-02-29", "2028-03-29"]
        );
        assert_eq!(dates(&r, "2027-02-01", "2027-02-28"), ["2027-02-28"]);
    }

    #[test]
    fn every_n_months_is_quarterly() {
        let mut r = rule(Freq::Monthly, "2026-01-10");
        r.interval_n = 3;
        assert_eq!(
            dates(&r, "2026-01-01", "2026-12-31"),
            ["2026-01-10", "2026-04-10", "2026-07-10", "2026-10-10"]
        );
    }

    // ── weekly / fortnightly ─────────────────────────────────────────────

    #[test]
    fn weekly_lands_on_the_same_weekday() {
        let r = rule(Freq::Weekly, "2026-09-03"); // a Thursday
        let got = dates(&r, "2026-09-01", "2026-09-30");
        assert_eq!(got, ["2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24"]);
        for s in &got {
            assert_eq!(d(s).weekday(), Weekday::Thu);
        }
    }

    #[test]
    fn fortnightly_does_not_drift() {
        // The other classic: a fortnightly rule implemented as "twice monthly"
        // gains a day a year. Every gap must be exactly 14 days, even across
        // a year boundary.
        let mut r = rule(Freq::Weekly, "2026-01-02");
        r.interval_n = 2;
        let got = occurrences(&r, d("2026-01-01"), d("2027-12-31"));
        assert!(got.len() > 45);
        for w in got.windows(2) {
            assert_eq!((w[1] - w[0]).num_days(), 14, "{:?} -> {:?}", w[0], w[1]);
        }
    }

    #[test]
    fn a_long_running_rule_is_cheap_to_query_far_in_the_future() {
        // Stepping from the start date would be thousands of hops; the
        // generator jumps most of the way. This asserts the ANSWER is right
        // after the jump, which is what the optimization risks.
        let mut r = rule(Freq::Weekly, "2010-01-01"); // a Friday
        r.interval_n = 2;
        let got = dates(&r, "2026-09-01", "2026-09-30");
        for s in &got {
            assert_eq!(d(s).weekday(), Weekday::Fri);
            // Every occurrence is a whole number of fortnights from the start.
            assert_eq!((d(s) - d("2010-01-01")).num_days() % 14, 0);
        }
        assert!(!got.is_empty());
    }

    // ── twice monthly ────────────────────────────────────────────────────

    #[test]
    fn semi_monthly_pays_on_both_days() {
        // The pattern most salaries follow, and one a monthly rule cannot
        // express.
        let mut r = rule(Freq::SemiMonthly, "2026-01-01");
        r.second_day = Some(15);
        assert_eq!(
            dates(&r, "2026-01-01", "2026-02-28"),
            ["2026-01-01", "2026-01-15", "2026-02-01", "2026-02-15"]
        );
    }

    #[test]
    fn semi_monthly_clamps_its_second_day_too() {
        let mut r = rule(Freq::SemiMonthly, "2026-01-15");
        r.second_day = Some(31);
        assert_eq!(
            dates(&r, "2026-02-01", "2026-02-28"),
            ["2026-02-15", "2026-02-28"]
        );
    }

    #[test]
    fn semi_monthly_catches_next_months_payday_shifted_back_into_the_window() {
        // §180. 1 March 2026 is a Sunday, so with "the Friday before" it is
        // paid Friday 27 February — inside a February window even though the
        // month it belongs to starts after the window ends.
        let mut r = rule(Freq::SemiMonthly, "2026-01-01");
        r.second_day = Some(15);
        r.weekend_rule = WeekendRule::Before;
        assert_eq!(d("2026-03-01").weekday(), Weekday::Sun);
        assert_eq!(
            dates(&r, "2026-02-01", "2026-02-28"),
            ["2026-02-13", "2026-02-27"]
        );
    }

    // ── weekends ─────────────────────────────────────────────────────────

    #[test]
    fn a_weekend_bill_can_move_to_the_friday_before() {
        // 2026-11-01 is a Sunday.
        let mut r = rule(Freq::Monthly, "2026-11-01");
        r.weekend_rule = WeekendRule::Before;
        assert_eq!(dates(&r, "2026-10-01", "2026-11-30"), ["2026-10-30"]);
        assert_eq!(d("2026-10-30").weekday(), Weekday::Fri);
    }

    #[test]
    fn or_to_the_monday_after() {
        let mut r = rule(Freq::Monthly, "2026-11-01");
        r.weekend_rule = WeekendRule::After;
        assert_eq!(dates(&r, "2026-11-01", "2026-11-30"), ["2026-11-02"]);
        assert_eq!(d("2026-11-02").weekday(), Weekday::Mon);
    }

    #[test]
    fn a_weekend_shift_can_pull_an_occurrence_into_the_window() {
        // The bill is due Sunday 1 November and paid Friday 30 October, so it
        // belongs to October's forecast. Generating strictly inside the window
        // would miss it — the money moves on the shifted date.
        let mut r = rule(Freq::Monthly, "2026-11-01");
        r.weekend_rule = WeekendRule::Before;
        assert_eq!(dates(&r, "2026-10-25", "2026-10-31"), ["2026-10-30"]);
    }

    #[test]
    fn weekdays_are_left_alone_by_every_rule() {
        for wr in [WeekendRule::None, WeekendRule::Before, WeekendRule::After] {
            let mut r = rule(Freq::Monthly, "2026-09-15"); // a Tuesday
            r.weekend_rule = wr;
            assert_eq!(dates(&r, "2026-09-01", "2026-09-30"), ["2026-09-15"]);
        }
    }

    // ── bounds ───────────────────────────────────────────────────────────

    #[test]
    fn a_one_off_appears_once_and_only_in_its_window() {
        let r = rule(Freq::Once, "2026-09-20");
        assert_eq!(dates(&r, "2026-09-01", "2026-09-30"), ["2026-09-20"]);
        assert!(dates(&r, "2026-10-01", "2026-10-31").is_empty());
    }

    #[test]
    fn nothing_is_generated_before_the_start_or_after_the_end() {
        let mut r = rule(Freq::Monthly, "2026-03-10");
        r.end = Some(d("2026-05-31"));
        assert_eq!(
            dates(&r, "2026-01-01", "2026-12-31"),
            ["2026-03-10", "2026-04-10", "2026-05-10"]
        );
    }

    #[test]
    fn the_window_is_inclusive_at_both_ends() {
        // Off-by-one here shows up as a bill that vanishes on the day it is
        // due, or one counted in two adjacent forecasts.
        let r = rule(Freq::Monthly, "2026-09-10");
        assert_eq!(dates(&r, "2026-09-10", "2026-09-10"), ["2026-09-10"]);
        assert!(dates(&r, "2026-09-11", "2026-10-09").is_empty());
    }

    #[test]
    fn an_inverted_window_yields_nothing_rather_than_looping() {
        let r = rule(Freq::Monthly, "2026-01-01");
        assert!(occurrences(&r, d("2026-12-31"), d("2026-01-01")).is_empty());
    }

    #[test]
    fn a_zero_interval_is_refused_rather_than_hanging() {
        let mut r = rule(Freq::Weekly, "2026-01-01");
        r.interval_n = 0;
        assert!(occurrences(&r, d("2026-01-01"), d("2026-12-31")).is_empty());
    }

    #[test]
    fn ninety_days_of_a_monthly_bill_is_three_or_four_occurrences() {
        // The horizon the user asked for, end to end.
        let r = rule(Freq::Monthly, "2026-01-15");
        let got = occurrences(&r, d("2026-09-03"), d("2026-09-03") + Duration::days(90));
        assert!(matches!(got.len(), 3..=4), "got {got:?}");
    }

    #[test]
    fn every_generated_date_is_unique() {
        // A duplicate is money counted twice in the forecast.
        let mut r = rule(Freq::SemiMonthly, "2026-01-15");
        r.second_day = Some(15); // same day twice — must not double up
        let got = occurrences(&r, d("2026-01-01"), d("2026-06-30"));
        let mut sorted = got.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(got.len(), sorted.len(), "duplicate dates in {got:?}");
    }

    #[test]
    fn parsing_rejects_what_the_schema_does_not_allow() {
        assert!(Freq::parse("daily").is_err());
        assert!(WeekendRule::parse("nearest").is_err());
        assert_eq!(Freq::parse("semi_monthly").unwrap(), Freq::SemiMonthly);
        assert_eq!(WeekendRule::parse("before").unwrap(), WeekendRule::Before);
    }
}
