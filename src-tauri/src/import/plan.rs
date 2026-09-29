//! What a plan statement's memo means.
//!
//! A 401(k) or 403(b) export is not a brokerage statement. The plan
//! administrator writes only the share side: a `Buy` for every payroll
//! contribution with no record of the money arriving, a `ShrsOut` for every
//! quarterly fee, a `Buy` again for a reinvested dividend. Imported literally
//! that leaves the account's cash deeply negative — the shares were bought
//! with money the file never provided — and the fees vanish, because a share
//! removal moves no cash and carries no category.
//!
//! What tells the rows apart is the **memo**: `Contribution`, `Dividends`,
//! `Fees`, `Withdrawals` in a typical plan's file. No two administrators
//! word those the same, so the wording is guessed and then confirmed by the
//! user rather than hard-coded.

use serde::{Deserialize, Serialize};

/// What one memo's rows should become.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Treatment {
    /// Exactly what the file says (what every import did before treatments existed).
    AsIs,
    /// A buy paid for by money that never passed through a tracked account —
    /// payroll deferral, employer match. The buy is written, and a deposit
    /// for the same amount on the same day beside it, so the cash nets to
    /// zero and the year's contributions are a number you can report on.
    Contribution,
    /// A buy that is really a reinvested distribution: same shares, but the
    /// money is income the plan earned, not money that arrived. Becomes
    /// `reinvest_dividend`, which books the income and moves no cash.
    Reinvest,
    /// Shares taken to pay a fee. Becomes a sell of those shares (so the lots
    /// close properly and the cash arrives) plus an expense row for the same
    /// amount, so the fee is in the spending reports where it belongs.
    Fee,
    /// A sell whose proceeds left the plan. The sell is written, and a
    /// withdrawal beside it, so the cash does not pile up as a balance the
    /// account does not have.
    Withdrawal,
}

impl Treatment {
    pub fn label(self) -> &'static str {
        match self {
            Treatment::AsIs => "Leave as it is",
            Treatment::Contribution => "Contribution",
            Treatment::Reinvest => "Reinvested dividend",
            Treatment::Fee => "Fee",
            Treatment::Withdrawal => "Withdrawal",
        }
    }

    /// The category the extra cash row lands in when the user names none, and
    /// the side of the tree to create it on. `Reinvest` books its income
    /// through the ordinary investment path (Dividend Income), so it has none
    /// of its own.
    pub fn default_category(self) -> Option<(&'static str, &'static str)> {
        match self {
            // Deliberately its own income category rather than a child of
            // Wages & Salary: a deferral is not taxable wages, and a child
            // would inherit that parent's tax line.
            Treatment::Contribution => Some(("Retirement Contributions", "income")),
            Treatment::Fee => Some(("Investment Fees", "expense")),
            Treatment::Withdrawal => Some(("Retirement Income : Plan Withdrawal", "income")),
            _ => None,
        }
    }
}

/// The treatments that make sense for a row of this activity. A share
/// removal cannot be a contribution; a buy cannot be a fee.
pub fn allowed_for(activity: &str) -> Vec<Treatment> {
    match activity {
        "buy" => vec![Treatment::AsIs, Treatment::Contribution, Treatment::Reinvest],
        "remove_shares" => vec![Treatment::AsIs, Treatment::Fee],
        "sell" => vec![Treatment::AsIs, Treatment::Withdrawal, Treatment::Fee],
        _ => vec![Treatment::AsIs],
    }
}

/// The guess, from the words administrators actually use. Conservative: a
/// memo that says nothing recognizable is left alone, because inventing a
/// contribution that is not there is worse than leaving the user to say so.
pub fn guess(memo: &str, activity: &str) -> Treatment {
    let m = memo.trim().to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| m.contains(n));
    match activity {
        // Dividends first: "dividend reinvestment contribution" is a
        // reinvestment, whatever else it says.
        "buy" if has(&["div", "distribution reinvest", "reinvest"]) => Treatment::Reinvest,
        "buy" if has(&["contrib", "deferral", "defer", "match", "employer", "employee", "payroll", "rollover", "salary"]) => {
            Treatment::Contribution
        }
        "remove_shares" if has(&["fee", "expense", "charge", "admin", "recordkeep", "wrap"]) => Treatment::Fee,
        "sell" if has(&["fee", "expense", "charge", "admin", "recordkeep", "wrap"]) => Treatment::Fee,
        "sell" if has(&["withdraw", "distribution", "payout", "disburse", "loan", "rollout"]) => Treatment::Withdrawal,
        _ => Treatment::AsIs,
    }
}

/// A memo being counted up as the preview walks the file.
pub struct MemoGroupSeed {
    pub memo: String,
    pub action: String,
    pub activity: String,
    pub count: u32,
    pub gross_cents: i64,
    pub shares_micro: i64,
}

impl MemoGroupSeed {
    /// Finish it: the guess, what may be chosen, and the category the guess
    /// would use.
    pub fn into_group(self) -> MemoGroup {
        let guess = guess(&self.memo, &self.activity);
        MemoGroup {
            default_category: guess.default_category().map(|(p, _)| p.to_string()),
            guess,
            allowed: allowed_for(&self.activity),
            memo: self.memo,
            action: self.action,
            activity: self.activity,
            count: self.count,
            gross_cents: self.gross_cents,
            shares_micro: self.shares_micro,
        }
    }
}

/// One memo as it appears in the file, with what it would become.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoGroup {
    /// The memo text, trimmed. Empty for rows that carry none.
    pub memo: String,
    /// The file's own word — `Buy`, `ShrsOut` — shown so the user can tell
    /// two identical memos on different actions apart.
    pub action: String,
    /// The activity it maps to today.
    pub activity: String,
    pub count: u32,
    pub gross_cents: i64,
    pub shares_micro: i64,
    pub guess: Treatment,
    pub allowed: Vec<Treatment>,
    /// The category the guess would use, for the dialog to show and edit.
    pub default_category: Option<String>,
}

/// The user's answer for one memo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoRule {
    pub memo: String,
    /// Which action's rows this rule is for; empty applies to any.
    #[serde(default)]
    pub activity: String,
    pub treatment: Treatment,
    /// A category path (`Parent : Child`). None takes the treatment's default.
    #[serde(default)]
    pub category: Option<String>,
}

/// The rule for a row, matched on memo and activity. An exact activity match
/// wins over a rule that names none.
pub fn rule_for<'a>(rules: &'a [MemoRule], memo: &str, activity: &str) -> Option<&'a MemoRule> {
    let m = memo.trim();
    rules
        .iter()
        .find(|r| r.memo.trim().eq_ignore_ascii_case(m) && r.activity == activity)
        .or_else(|| rules.iter().find(|r| r.memo.trim().eq_ignore_ascii_case(m) && r.activity.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_words_administrators_use_are_recognized() {
        assert_eq!(guess("Contribution", "buy"), Treatment::Contribution);
        assert_eq!(guess("EMPLOYEE DEFERRAL", "buy"), Treatment::Contribution);
        assert_eq!(guess("Employer Match", "buy"), Treatment::Contribution);
        assert_eq!(guess("Salary Deferral", "buy"), Treatment::Contribution);
        assert_eq!(guess("Dividends", "buy"), Treatment::Reinvest);
        assert_eq!(guess("Fees", "remove_shares"), Treatment::Fee);
        assert_eq!(guess("Recordkeeping Fee", "remove_shares"), Treatment::Fee);
        assert_eq!(guess("Withdrawals", "sell"), Treatment::Withdrawal);
        assert_eq!(guess("In-Service Distribution", "sell"), Treatment::Withdrawal);
    }

    #[test]
    fn a_memo_that_says_nothing_recognizable_is_left_alone() {
        assert_eq!(guess("", "buy"), Treatment::AsIs);
        assert_eq!(guess("Change in Market Value", "buy"), Treatment::AsIs);
        assert_eq!(guess("Rebalance", "buy"), Treatment::AsIs);
        // A fee word on an action where it cannot mean a fee.
        assert_eq!(guess("Fees", "buy"), Treatment::AsIs);
        // A contribution word on a share removal.
        assert_eq!(guess("Contribution", "remove_shares"), Treatment::AsIs);
    }

    #[test]
    fn a_dividend_reinvested_as_a_contribution_is_a_reinvestment() {
        // Both words present; the distribution is what it actually is.
        assert_eq!(guess("Dividend reinvestment contribution", "buy"), Treatment::Reinvest);
    }

    #[test]
    fn only_the_treatments_that_can_apply_are_offered() {
        assert_eq!(allowed_for("buy"), vec![Treatment::AsIs, Treatment::Contribution, Treatment::Reinvest]);
        assert_eq!(allowed_for("remove_shares"), vec![Treatment::AsIs, Treatment::Fee]);
        assert_eq!(allowed_for("split"), vec![Treatment::AsIs]);
    }

    #[test]
    fn a_rule_naming_the_action_beats_one_that_does_not() {
        let rules = vec![
            MemoRule { memo: "Fees".into(), activity: String::new(), treatment: Treatment::AsIs, category: None },
            MemoRule { memo: "Fees".into(), activity: "remove_shares".into(), treatment: Treatment::Fee, category: None },
        ];
        assert_eq!(rule_for(&rules, "Fees", "remove_shares").unwrap().treatment, Treatment::Fee);
        assert_eq!(rule_for(&rules, "fees  ", "sell").unwrap().treatment, Treatment::AsIs);
        assert!(rule_for(&rules, "Contribution", "buy").is_none());
    }
}
