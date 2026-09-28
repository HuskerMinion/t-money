//! §89 — matching an incoming statement row against one already in the
//! register.
//!
//! The dedupe that came before this (§13, §84) is exact: same account, same
//! date, same amount, same payee string. A bank that posts a day later than
//! you wrote the check, or writes `SAFEWAY #1234 ANYTOWN US` where you wrote
//! `Safeway`, defeats it and the row comes in twice. This module scores the
//! near misses so the user can confirm them instead of cleaning up after.
//!
//! **The amount is a hard gate.** Two rows are never candidates unless the
//! cents are equal to the cent. Everything else — the date distance, the
//! payee, the check number — only moves a score inside that gate. Money is
//! `i64` cents here as everywhere; nothing in this file is fuzzy about it.

use chrono::NaiveDate;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Above this the best candidate is ticked for the user; they can untick it.
pub const LIKELY: f32 = 0.70;
/// Below this a candidate is not worth showing at all.
pub const POSSIBLE: f32 = 0.40;
/// How many candidates one incoming row may offer.
const MAX_CANDIDATES: usize = 3;

/// Tokens that appear in bank descriptions and identify nothing. Dropping
/// them is what lets `POS DEBIT SAFEWAY 1234` meet `Safeway`.
const NOISE: &[&str] = &[
    "pos", "purchase", "debit", "credit", "card", "checkcard", "payment", "pmt", "recurring", "ach",
    "web", "ppd", "ccd", "tel", "dda", "eft", "des", "ref", "id", "authorized", "auth", "on", "the",
    "of", "and", "transaction", "withdrawal", "deposit", "online", "bill", "billpay", "co", "inc",
    "llc", "ltd", "corp", "visa", "mastercard", "amex", "xxxx", "xx", "store", "sq", "tst", "pending",
];

/// A payee reduced to the part that identifies it: lower case, punctuation
/// gone, tokens carrying a digit gone (store numbers, terminal ids, dates),
/// single letters gone, boilerplate gone.
///
/// If that leaves nothing — a description that was all numbers — the letters
/// and digits of the original are used, so two identical raw strings still
/// score as identical rather than both collapsing to empty.
pub fn normalize_payee(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut out: Vec<&str> = Vec::new();
    for token in lower.split(|c: char| !c.is_alphanumeric()) {
        if token.len() < 2 {
            continue;
        }
        if token.chars().any(|c| c.is_ascii_digit()) {
            continue;
        }
        if NOISE.contains(&token) {
            continue;
        }
        out.push(token);
    }
    if out.is_empty() {
        return lower.chars().filter(|c| c.is_alphanumeric()).collect();
    }
    out.join(" ")
}

/// Dice coefficient over character trigrams of the spaceless string. This is
/// what recognizes `wal mart` as `walmart`, which whole-token overlap cannot.
fn trigram_dice(a: &str, b: &str) -> f32 {
    let grams = |s: &str| -> HashSet<[char; 3]> {
        let chars: Vec<char> = s.chars().filter(|c| !c.is_whitespace()).collect();
        let mut set = HashSet::new();
        if chars.len() < 3 {
            return set;
        }
        for w in chars.windows(3) {
            set.insert([w[0], w[1], w[2]]);
        }
        set
    };
    let (ga, gb) = (grams(a), grams(b));
    if ga.is_empty() || gb.is_empty() {
        return 0.0;
    }
    let shared = ga.intersection(&gb).count() as f32;
    2.0 * shared / (ga.len() + gb.len()) as f32
}

/// 0.0 (nothing in common) to 1.0 (the same name once normalized).
///
/// Three views, best one wins: shared whole words, one name containing the
/// other, and trigram overlap for the spelling differences.
pub fn similarity(a: &str, b: &str) -> f32 {
    let (na, nb) = (normalize_payee(a), normalize_payee(b));
    if na.is_empty() || nb.is_empty() {
        return 0.0;
    }
    if na == nb {
        return 1.0;
    }
    let ta: Vec<&str> = na.split(' ').collect();
    let tb: Vec<&str> = nb.split(' ').collect();
    let shared = ta.iter().filter(|t| tb.contains(t)).count() as f32;
    let word_dice = 2.0 * shared / (ta.len() + tb.len()) as f32;
    // Containment is judged without the spaces, so `WAL MART SUPERCENTER`
    // holds `Walmart`. Four characters at least, or every three-letter
    // merchant would contain every other one.
    let (sa, sb): (String, String) = (na.replace(' ', ""), nb.replace(' ', ""));
    let containment = if sa.len().min(sb.len()) >= 4 && (sa.contains(&sb) || sb.contains(&sa)) { 0.85 } else { 0.0 };
    word_dice.max(containment).max(trigram_dice(&na, &nb))
}

/// A transaction already in the register, as the review dialog shows it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExistingRow {
    pub id: String,
    pub date: String,
    pub payee: String,
    pub amount_cents: i64,
    pub category_name: Option<String>,
    pub notes: Option<String>,
    pub check_number: Option<String>,
    pub cleared_state: String,
    /// It already carries a bank id, so it probably came from a statement
    /// rather than from the user's typing — a weaker thing to match onto.
    pub has_fitid: bool,
    pub is_transfer: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchCandidate {
    pub existing: ExistingRow,
    pub score: f32,
    /// Signed: negative when the register row is earlier than the file row.
    pub day_gap: i64,
    /// Plain words for why this is a candidate, shown under the pair.
    pub why: String,
}

/// One row of the file as the importer will read it, with whatever it might
/// already be in the register.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncomingRow {
    /// Position in the parsed file — the key the decisions come back under.
    pub index: usize,
    pub date: String,
    pub payee: String,
    pub amount_cents: i64,
    pub check_number: Option<String>,
    pub candidates: Vec<MatchCandidate>,
    /// The best candidate scored above `LIKELY`: ticked by default.
    pub likely: bool,
}

/// §159 — a row that would be written with NO category: the file gave none
/// and no payee rule caught it. Listed so the review can ask, instead of the
/// row landing as "Uncategorized" and being found weeks later in a report.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UncategorizedRow {
    pub index: usize,
    pub date: String,
    pub payee: String,
    pub amount_cents: i64,
}

/// What `preview_import` found. Writes nothing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportMatchPreview {
    pub account_id: String,
    pub account_name: String,
    /// Rows the file yielded, readable ones only.
    pub total_rows: u32,
    /// Exact duplicates by the old rule — skipped without asking, as before.
    pub duplicates: u32,
    /// Rows the parser could not read at all.
    pub unreadable: u32,
    /// Rows with no candidate: they import untouched and are not listed.
    pub new_rows: u32,
    /// Only the rows worth a decision.
    pub rows: Vec<IncomingRow>,
    /// §159 — new rows (no candidate, not a duplicate) that would be written
    /// with no category. A subset of `new_rows`, by count.
    #[serde(default)]
    pub uncategorized: Vec<UncategorizedRow>,
    pub window_days: u32,
    /// §90: the distinct memos on the file's investment rows, empty for an
    /// ordinary bank file. What a plan statement's wording means.
    #[serde(default)]
    pub memo_groups: Vec<super::plan::MemoGroup>,
}

/// The user's answer for one incoming row. `action` is `new`, `skip` or
/// `match`; `match` carries the register row it belongs to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowDecision {
    pub index: usize,
    pub action: String,
    #[serde(default)]
    pub existing_id: Option<String>,
    /// §159 — a category chosen in the review for a row the file and the
    /// payee rules left without one. Only read for a row written as new.
    #[serde(default)]
    pub category_id: Option<String>,
}

fn parse_day(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// Score one pairing. Amount equality is assumed — the query enforces it.
fn score_pair(
    day_gap: i64,
    window_days: u32,
    payee_sim: f32,
    check_equal: bool,
    existing: &ExistingRow,
) -> (f32, String) {
    let window = window_days.max(1) as f32;
    let gap = day_gap.unsigned_abs() as f32;
    let mut why: Vec<String> = Vec::new();

    // The date does not add to the score, it discounts it: a pairing five
    // days out has to be much more convincing in every other way than the
    // same day's. Additive date credit was the first cut, and it let a
    // different merchant at the same amount a week away stay on screen.
    let date_factor = 1.0 - 0.5 * (gap / (window as f32 + 1.0)).min(1.0);
    let mut score = (0.25 + 0.55 * payee_sim) * date_factor;
    if day_gap == 0 {
        // Same amount on the same day is worth a look even when the
        // description shares nothing — banks rewrite them beyond recognition.
        score += 0.06;
    }
    why.push(match day_gap {
        0 => "same day".to_string(),
        1 | -1 => "1 day apart".to_string(),
        d => format!("{} days apart", d.abs()),
    });

    if payee_sim >= 0.99 {
        why.push("same name".to_string());
    } else if payee_sim > 0.0 {
        why.push(format!("name {}% alike", (payee_sim * 100.0).round() as i32));
    } else {
        why.push("a different name".to_string());
    }

    if check_equal {
        // Decisive on its own, and deliberately outside the date discount: a
        // check number identifies the transaction, and a check taking a
        // week to clear says nothing against the pairing. The bank often
        // prints nothing but "CHECK 1043", which shares no words at all with
        // the payee the user wrote.
        score += 0.50;
        why.push(format!("check {} matches", existing.check_number.clone().unwrap_or_default()));
    }
    match existing.cleared_state.as_str() {
        // Not yet cleared: exactly the row you type ahead of the statement.
        "" => {
            score += 0.10;
            why.push("not cleared yet".to_string());
        }
        "R" => {
            score -= 0.05;
            why.push("already reconciled".to_string());
        }
        _ => {}
    }
    if existing.has_fitid {
        score -= 0.15;
        why.push("already came from a statement".to_string());
    }
    (score.clamp(0.0, 1.0), why.join(", "))
}

/// Every register row that could be this file row, best first.
///
/// `taken` holds ids already claimed by an earlier row of the same file, so
/// two identical rows in one statement cannot both point at one register row.
#[allow(clippy::too_many_arguments)]
pub fn candidates_for(
    conn: &Connection,
    account_id: &str,
    date: &str,
    amount_cents: i64,
    payee: &str,
    check_number: Option<&str>,
    window_days: u32,
    taken: &HashSet<String>,
) -> Result<Vec<MatchCandidate>, String> {
    let Some(day) = parse_day(date) else {
        return Ok(Vec::new());
    };
    let from = (day - chrono::Duration::days(window_days as i64)).format("%Y-%m-%d").to_string();
    let to = (day + chrono::Duration::days(window_days as i64)).format("%Y-%m-%d").to_string();

    let mut st = conn
        .prepare(
            "SELECT t.id, t.date, t.payee, t.amount_cents, c.name, t.notes, t.check_number,
                    t.cleared_state, t.fitid IS NOT NULL, t.transfer_id IS NOT NULL
               FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
              WHERE t.account_id = ?1 AND t.amount_cents = ?2
                AND t.date BETWEEN ?3 AND ?4
                AND t.is_void = 0 AND t.activity IS NULL
              ORDER BY t.date, t.rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map(params![account_id, amount_cents, from, to], |r| {
            Ok(ExistingRow {
                id: r.get(0)?,
                date: r.get(1)?,
                payee: r.get(2)?,
                amount_cents: r.get(3)?,
                category_name: r.get(4)?,
                notes: r.get(5)?,
                check_number: r.get(6)?,
                cleared_state: r.get(7)?,
                has_fitid: r.get::<_, i64>(8)? != 0,
                is_transfer: r.get::<_, i64>(9)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut out: Vec<MatchCandidate> = Vec::new();
    for existing in rows {
        if taken.contains(&existing.id) {
            continue;
        }
        let Some(existing_day) = parse_day(&existing.date) else { continue };
        let day_gap = (existing_day - day).num_days();
        let sim = similarity(payee, &existing.payee);
        let check_equal = match (check_number, existing.check_number.as_deref()) {
            (Some(a), Some(b)) => !a.trim().is_empty() && a.trim() == b.trim(),
            _ => false,
        };
        let (score, why) = score_pair(day_gap, window_days, sim, check_equal, &existing);
        if score < POSSIBLE {
            continue;
        }
        out.push(MatchCandidate { existing, score, day_gap, why });
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(MAX_CANDIDATES);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bank_description_reduces_to_the_name_that_identifies_it() {
        assert_eq!(normalize_payee("SAFEWAY #1234 ANYTOWN US"), "safeway anytown us");
        assert_eq!(normalize_payee("POS DEBIT CARD 8842 SAFEWAY"), "safeway");
        assert_eq!(normalize_payee("Safeway"), "safeway");
        assert_eq!(normalize_payee("FRESH MARKET FUEL 62"), "fresh market fuel");
        // All digits and boilerplate: the raw characters, so two identical
        // descriptions still look identical rather than both looking empty.
        assert_eq!(normalize_payee("POS 4411 2231"), "pos44112231");
    }

    #[test]
    fn similarity_sees_through_store_numbers_spacing_and_extra_words() {
        assert!(similarity("SAFEWAY #1234 ANYTOWN US", "Safeway") > 0.8);
        assert!(similarity("WAL MART SUPERCENTER", "Walmart") > 0.8, "spacing must not hide a merchant");
        assert!(similarity("CITY POWER & LIGHT-CPL", "City Power & Light") > 0.7);
        assert_eq!(similarity("Safeway", "safeway"), 1.0);
        // Different merchants must not look alike just because both are short.
        assert!(similarity("Costco", "Chipotle") < 0.4);
        assert!(similarity("Dr. Watson DVM", "Netflix") < 0.3);
    }

    #[test]
    fn the_score_prefers_a_close_date_a_like_name_and_a_row_you_typed() {
        let typed = ExistingRow {
            id: "a".into(),
            date: "2026-09-02".into(),
            payee: "Safeway".into(),
            amount_cents: -4_250,
            category_name: None,
            notes: None,
            check_number: None,
            cleared_state: String::new(),
            has_fitid: false,
            is_transfer: false,
        };
        let (near, _) = score_pair(1, 3, similarity("SAFEWAY #1234", "Safeway"), false, &typed);
        assert!(near >= LIKELY, "a day apart with the same merchant should be likely: {near}");

        // The case this whole section exists for: the bank's long description
        // against the short name the user typed, one day out.
        let (real, why) = score_pair(1, 3, similarity("SAFEWAY #1234 ANYTOWN US", "Safeway"), false, &typed);
        assert!(real >= LIKELY, "the real-world pairing must tick itself: {real} ({why})");

        // Same everything, but the register row already came from a bank feed
        // and is reconciled — a much weaker thing to match onto.
        let mut settled = typed.clone();
        settled.has_fitid = true;
        settled.cleared_state = "R".into();
        let (weak, _) = score_pair(1, 3, similarity("SAFEWAY #1234", "Safeway"), false, &settled);
        assert!(weak < near);

        // A different merchant at the same amount, five days out, is not
        // worth showing at all.
        let other = ExistingRow { payee: "Chipotle".into(), ..typed.clone() };
        let (far, _) = score_pair(5, 3, similarity("SAFEWAY #1234", "Chipotle"), false, &other);
        assert!(far < POSSIBLE, "unrelated names should fall below POSSIBLE: {far}");
    }

    #[test]
    fn a_matching_check_number_carries_a_pairing_on_its_own() {
        let check = ExistingRow {
            id: "a".into(),
            date: "2026-08-28".into(),
            payee: "Anytown Plumbing".into(),
            amount_cents: -68_000,
            category_name: None,
            notes: None,
            check_number: Some("1043".into()),
            cleared_state: String::new(),
            has_fitid: false,
            is_transfer: false,
        };
        // The bank prints nothing but "CHECK 1043"; the names share nothing.
        let sim = similarity("CHECK 1043", "Anytown Plumbing");
        let (with_check, why) = score_pair(4, 7, sim, true, &check);
        let (without, _) = score_pair(4, 7, sim, false, &check);
        assert!(with_check >= LIKELY, "check number should carry it: {with_check}");
        assert!(without < with_check);
        assert!(why.contains("check 1043 matches"), "{why}");
    }
}
