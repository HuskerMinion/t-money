//! Amount and date parsing for QIF/OFX imports.
//!
//! Amounts are decimal strings (`"123.45"`, `"-1,234.56"`). We parse them with
//! `rust_decimal` and convert to integer cents **exactly** — no `f64` anywhere.

use rust_decimal::prelude::{FromStr, ToPrimitive};
use rust_decimal::{Decimal, RoundingStrategy};

/// Parse a decimal amount string into integer cents.
///
/// Handles thousands separators and an optional sign. Returns `None` if the
/// string is not a valid decimal.
pub fn parse_amount_cents(s: &str) -> Option<i64> {
    let cleaned: String = s
        .trim()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ',')
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    let d = Decimal::from_str(&cleaned).ok()?;
    // Multiply by 100 and round to the nearest cent (handles 3+ decimal places).
    // Half-away-from-zero is the conventional money rounding (0.005 -> 1 cent).
    let cents = (d * Decimal::new(100, 0))
        .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero);
    cents.to_i64()
}

/// Parse a share count or a unit price into millionths (the stored unit), exactly.
/// `"12.3456"` → 12_345_600. Signs and thousands separators are accepted.
pub fn parse_micro(s: &str) -> Option<i64> {
    let cleaned: String = s
        .trim()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ',')
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    let d = Decimal::from_str(&cleaned).ok()?;
    (d * Decimal::new(1_000_000, 0))
        .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
        .to_i64()
}

/// Normalize a QIF date to `YYYY-MM-DD`.
///
/// Two shapes, because two things write QIF at us:
///
/// - `YYYY-MM-DD`, optionally with a time — the line format `qif.rs` has
///   always parsed, and what the demo data uses.
/// - `M/D/YYYY`, `MM/DD/YY` and `MM/DD'YY` — what Quicken, Money and bank
///   export buttons actually write. The apostrophe is QIF's own
///   century marker: `'` introduces 2000-2099, `/` a 19xx year.
///
/// Spaces inside the date (`" 8/ 3/2026"`) are QIF's column padding and are
/// ignored. A two-digit year without a marker follows the usual pivot: 00-68
/// is 20xx, 69-99 is 19xx.
pub fn normalize_qif_date(s: &str) -> Option<String> {
    let s = s.trim();

    // ISO first — it is unambiguous, and it is what we already emitted.
    // `get(..10)` rather than `[..10]`: a date with a multi-byte character in
    // it (a localized `D2026年08月03日`) would otherwise panic the import.
    // And the pieces are checked as a real calendar date, not just as the
    // right punctuation — `2026-13-45` used to be stored verbatim.
    if let Some(d) = s.get(..10) {
        if d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-' {
            return chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d")
                .ok()
                .map(|_| d.to_string());
        }
    }

    // Quicken-style. Split on / and ' alike, so `8/3'26` works.
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    let apostrophe = cleaned.contains('\'');
    let parts: Vec<&str> = cleaned.split(['/', '\'', '-']).collect();
    if parts.len() != 3 {
        return None;
    }
    let month: u32 = parts[0].parse().ok()?;
    let day: u32 = parts[1].parse().ok()?;
    let raw_year = parts[2];
    if !raw_year.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let year: i32 = match raw_year.len() {
        4 => raw_year.parse().ok()?,
        2 => {
            let y: i32 = raw_year.parse().ok()?;
            if apostrophe {
                2000 + y
            } else if y <= 68 {
                2000 + y
            } else {
                1900 + y
            }
        }
        _ => return None,
    };
    chrono::NaiveDate::from_ymd_opt(year, month, day)?;
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

/// Normalize an OFX date to `YYYY-MM-DD`.
///
/// OFX dates: `YYYYMMDD`, optionally followed by `HHMMSS[.SSS]` and a timezone
/// offset `+HHMM` / `-HHMM`.
pub fn normalize_ofx_date(s: &str) -> Option<String> {
    let s = s.trim();
    let d = s.get(..8)?;
    if !d.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let (y, m, day) = (&d[0..4], &d[4..6], &d[6..8]);
    chrono::NaiveDate::parse_from_str(d, "%Y%m%d").ok()?;
    Some(format!("{y}-{m}-{day}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts() {
        assert_eq!(parse_amount_cents("123.45"), Some(12345));
        assert_eq!(parse_amount_cents("-123.45"), Some(-12345));
        assert_eq!(parse_amount_cents("1,234.56"), Some(123456));
        assert_eq!(parse_amount_cents("0.005"), Some(1)); // rounds to nearest cent
        assert_eq!(parse_amount_cents("0.004"), Some(0));
        assert_eq!(parse_amount_cents("abc"), None);
        assert_eq!(parse_amount_cents(""), None);
    }

    #[test]
    fn dates() {
        assert_eq!(normalize_qif_date("2024-01-15"), Some("2024-01-15".into()));
        assert_eq!(
            normalize_qif_date("2024-01-15 10:30:00"),
            Some("2024-01-15".into())
        );
        assert_eq!(normalize_ofx_date("20240115"), Some("2024-01-15".into()));
        assert_eq!(
            normalize_ofx_date("20240115103000.123-0600"),
            Some("2024-01-15".into())
        );
    }
}

#[cfg(test)]
mod quicken_date_tests {
    use super::*;

    #[test]
    fn iso_dates_are_unchanged() {
        assert_eq!(normalize_qif_date("2026-08-03").as_deref(), Some("2026-08-03"));
        assert_eq!(
            normalize_qif_date("2026-08-03 10:30:00").as_deref(),
            Some("2026-08-03")
        );
    }

    #[test]
    fn quicken_slash_dates_are_read() {
        assert_eq!(normalize_qif_date("08/03/2026").as_deref(), Some("2026-08-03"));
        assert_eq!(normalize_qif_date("8/3/2026").as_deref(), Some("2026-08-03"));
    }

    #[test]
    fn column_padding_is_ignored() {
        // QIF pads to fixed columns: " 8/ 3/2026".
        assert_eq!(normalize_qif_date(" 8/ 3/2026").as_deref(), Some("2026-08-03"));
    }

    #[test]
    fn the_apostrophe_is_qifs_century_marker() {
        // `'` means 2000s. Reading it as 1926 would file the transaction a
        // hundred years off and quietly ruin every balance after it.
        assert_eq!(normalize_qif_date("08/03'26").as_deref(), Some("2026-08-03"));
    }

    #[test]
    fn a_bare_two_digit_year_pivots_at_68() {
        assert_eq!(normalize_qif_date("08/03/26").as_deref(), Some("2026-08-03"));
        assert_eq!(normalize_qif_date("08/03/99").as_deref(), Some("1999-08-03"));
    }

    #[test]
    fn nonsense_is_rejected_rather_than_coerced() {
        assert_eq!(normalize_qif_date("not a date"), None);
        assert_eq!(normalize_qif_date("13/45/2026"), None);
        assert_eq!(normalize_qif_date("08/03"), None);
        assert_eq!(normalize_qif_date(""), None);
    }
}
