//! Exchange rates, and turning an account's amounts into the file's home
//! currency.
//!
//! A rate is home-currency units per one unit of another currency, in
//! millionths, from a date on. Each rate records the home currency it was
//! quoted in (`quote`); only rates quoted in the current home currency are
//! used, so changing the home currency never reads an old rate as a new one. Converting an amount uses the latest rate on or before its day; a day
//! before the first rate uses the first rate, so every amount in a currency
//! that has any rate at all converts. A currency in use with NO rate is
//! refused where it would start (a new account, a currency change), and
//! `missing_rates` reports it if one slips through.
//!
//! All of it is integer arithmetic, rounded half away from zero — in Rust
//! (`to_home`) and in SQL (`to_home_sql!`) alike, so a total the sidebar shows
//! and the same total in a report cannot differ by a cent.

use crate::currency;
use crate::models::ExchangeRate;
use rusqlite::{params, Connection, OptionalExtension};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::{Decimal, RoundingStrategy};
use std::str::FromStr;

/// One unit, in millionths.
pub const MICRO: i64 = 1_000_000;

/// The largest rate accepted: a thousand home units per unit, far above any
/// pair of currencies on the list.
pub const MAX_RATE_MICRO: i64 = 1_000 * MICRO;

/// The largest amount, in hundredths, that a transfer or rate conversion
/// accepts: the largest whole number the frontend can hold exactly.
pub const MAX_CENTS: i64 = 9_007_199_254_740_991;

/// The rate in force for `currency` on `date`, as an SQL expression over the
/// column names given: the home currency is `MICRO`; a currency with no rate
/// quoted in the home currency is NULL.
#[macro_export]
macro_rules! rate_sql {
    ($cur:literal, $date:literal) => {
        concat!(
            "(CASE WHEN ", $cur, " = ", $crate::home_sql!(), " THEN 1000000 ELSE COALESCE(",
            "(SELECT xr.rate_micro FROM exchange_rates xr WHERE xr.currency = ", $cur,
            " AND xr.quote = ", $crate::home_sql!(),
            " AND xr.date <= ", $date, " ORDER BY xr.date DESC LIMIT 1), ",
            "(SELECT xr.rate_micro FROM exchange_rates xr WHERE xr.currency = ", $cur,
            " AND xr.quote = ", $crate::home_sql!(),
            " ORDER BY xr.date ASC LIMIT 1)) END)"
        )
    };
}

/// `$amt` hundredths at `$rate` millionths of a home unit each, in home cents,
/// rounded half away from zero. SQLite's integer division truncates toward
/// zero, which is what makes the two branches symmetric. NULL when the rate
/// is NULL.
///
/// The amount is split at a million before it is multiplied: `amt * rate`
/// in one piece passes the i64 range for a large amount, and SQLite then
/// quietly switches to floating point, which no reader of the column accepts.
/// Split, the product stays exact for any amount the app can store.
#[macro_export]
macro_rules! to_home_sql {
    ($amt:literal, $rate:literal) => {
        concat!(
            "(CASE WHEN ", $amt, " >= 0 THEN (", $amt, " / 1000000) * ", $rate,
            " + ((", $amt, " % 1000000) * ", $rate, " + 500000) / 1000000",
            " ELSE -(((-", $amt, ") / 1000000) * ", $rate,
            " + (((-", $amt, ") % 1000000) * ", $rate, " + 500000) / 1000000) END)"
        )
    };
}

/// `$amt` hundredths of currency `$cur` on day `$date`, in home cents: the
/// two macros above, put together. The rate lookup is an index seek and runs
/// only for an amount in a currency other than the home one.
#[macro_export]
macro_rules! to_home_at_sql {
    ($amt:literal, $cur:literal, $date:literal) => {
        concat!(
            "(CASE WHEN ", $amt, " >= 0 THEN (", $amt, " / 1000000) * ", $crate::rate_sql!($cur, $date),
            " + ((", $amt, " % 1000000) * ", $crate::rate_sql!($cur, $date), " + 500000) / 1000000",
            " ELSE -(((-", $amt, ") / 1000000) * ", $crate::rate_sql!($cur, $date),
            " + (((-", $amt, ") % 1000000) * ", $crate::rate_sql!($cur, $date), " + 500000) / 1000000) END)"
        )
    };
}

/// Every recurrence with its amount in the home currency as `home_cents`, at
/// today's rate — a schedule is about money still to come. Use as a table:
/// `FROM {RECURRENCES_HOME} r`.
pub const RECURRENCES_HOME: &str = concat!(
    "(SELECT rr.*, CASE WHEN COALESCE(ra.currency, ", crate::home_sql!(), ") = ", crate::home_sql!(),
    " THEN rr.amount_cents ELSE ",
    crate::to_home_at_sql!("rr.amount_cents", "ra.currency", "date('now', 'localtime')"),
    " END AS home_cents FROM recurrences rr LEFT JOIN accounts ra ON ra.id = rr.account_id)"
);

/// `cents` at `rate_micro`, in home cents — the Rust twin of `to_home_sql!`.
pub fn to_home(cents: i64, rate_micro: i64) -> i64 {
    if rate_micro == MICRO {
        return cents;
    }
    let p = (cents as i128).abs() * rate_micro as i128;
    let v = ((p + (MICRO / 2) as i128) / MICRO as i128).min(i64::MAX as i128) as i64;
    if cents < 0 { -v } else { v }
}

/// The file's home currency. A stored value that is not a supported code
/// reads as the default — exactly as `home_sql!` reads it in SQL.
pub fn home_currency(conn: &Connection) -> Result<String, String> {
    let v: Option<String> = conn
        .query_row("SELECT value FROM app_settings WHERE key = ?1", params![currency::HOME_KEY], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(v.and_then(|c| currency::find(&c).map(|c| c.code)).unwrap_or(currency::DEFAULT_HOME).to_string())
}

/// The name of the home currency, for a sentence: "US dollars", "euros".
pub fn home_name(conn: &Connection) -> Result<String, String> {
    let code = home_currency(conn)?;
    Ok(currency::find(&code).map(|c| c.name).unwrap_or(currency::DEFAULT_HOME).to_string())
}

/// Make `code` the file's home currency.
///
/// `relabel` says the accounts kept in the old home currency were really in
/// the new one all along — a file set up as dollars that has only ever held
/// euros. They are relabeled, amounts untouched. Refused when an account is
/// already kept in the new currency: its transfers with a relabeled account
/// would then be one currency with two different amounts.
///
/// Without `relabel` those accounts keep their currency and become foreign
/// ones, converted at a rate. Refused while an investment account is among
/// them, since investment accounts are kept in the home currency.
///
/// Rates quoted in the old home currency stay in the file but are not used;
/// the new home currency needs its own (`missing_rates` lists what is left).
pub fn set_home_currency(conn: &Connection, code: &str, relabel: bool) -> Result<(), String> {
    let new = currency::validate(code)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let old = home_currency(&tx)?;
    if old == new {
        // Nothing to change — but a stored value that was not a code at all
        // is written over, so the file says what it means.
        tx.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
              WHERE app_settings.value <> excluded.value",
            params![currency::HOME_KEY, new],
        )
        .map_err(|e| e.to_string())?;
        return tx.commit().map_err(|e| e.to_string());
    }
    if relabel {
        let clash: bool = tx
            .query_row("SELECT EXISTS (SELECT 1 FROM accounts WHERE currency = ?1)", params![new], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if clash {
            return Err(format!(
                "Some accounts are already kept in {new}, so the {old} accounts cannot be relabeled as {new}: transfers between them would no longer add up. Change the home currency without relabeling instead."
            ));
        }
        tx.execute("UPDATE accounts SET currency = ?2, updated_at = datetime('now') WHERE currency = ?1", params![old, new])
            .map_err(|e| e.to_string())?;
    } else {
        let invest: Option<String> = tx
            .query_row(
                "SELECT name FROM accounts WHERE currency = ?1
                   AND type IN ('investment', 'retirement', 'employee_stock_option', 'watch') LIMIT 1",
                params![old],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(name) = invest {
            return Err(format!(
                "{name} is an investment account, and investment accounts are kept in the home currency. Relabel the {old} accounts as {new}, or move the investments out first."
            ));
        }
    }
    tx.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        params![currency::HOME_KEY, new],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// The rate in force for `currency` on `date` (YYYY-MM-DD); `Some(MICRO)` for
/// the home currency, `None` for a currency with no rate at all.
pub fn rate_on(conn: &Connection, currency: &str, date: &str) -> Result<Option<i64>, String> {
    if currency == home_currency(conn)? {
        return Ok(Some(MICRO));
    }
    conn.query_row(
        concat!("SELECT ", rate_sql!("?1", "?2")),
        params![currency, date],
        |r| r.get::<_, Option<i64>>(0),
    )
    .map_err(|e| e.to_string())
}

/// Today's rate for every currency an account is kept in, the home currency
/// always.
pub fn rates_today(conn: &Connection) -> Result<std::collections::HashMap<String, i64>, String> {
    let today = chrono::Local::now().date_naive().to_string();
    let home = home_currency(conn)?;
    let mut out = std::collections::HashMap::new();
    out.insert(home.clone(), MICRO);
    for c in currencies_in_use(conn)? {
        if let Some(r) = rate_on_in(conn, &home, &c, &today)? {
            out.insert(c, r);
        }
    }
    Ok(out)
}

/// `rate_on` with the home currency already read by the caller, for a loop:
/// the lookup is prepared once and the home code is bound, not re-read.
pub fn rate_on_in(conn: &Connection, home: &str, currency: &str, date: &str) -> Result<Option<i64>, String> {
    if currency == home {
        return Ok(Some(MICRO));
    }
    let mut st = conn
        .prepare_cached(
            "SELECT COALESCE(
                 (SELECT rate_micro FROM exchange_rates WHERE currency = ?1 AND quote = ?3 AND date <= ?2 ORDER BY date DESC LIMIT 1),
                 (SELECT rate_micro FROM exchange_rates WHERE currency = ?1 AND quote = ?3 ORDER BY date ASC LIMIT 1))",
        )
        .map_err(|e| e.to_string())?;
    st.query_row(params![currency, date, home], |r| r.get::<_, Option<i64>>(0)).map_err(|e| e.to_string())
}

/// Every currency other than the home one that an account is kept in.
pub fn currencies_in_use(conn: &Connection) -> Result<Vec<String>, String> {
    let mut st = conn
        .prepare(concat!("SELECT DISTINCT currency FROM accounts WHERE currency <> ", crate::home_sql!(), " ORDER BY currency"))
        .map_err(|e| e.to_string())?;
    let v = st
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(v)
}

/// Currencies an account is kept in that have no rate at all — whose amounts
/// therefore cannot be converted. Empty in a healthy file.
pub fn missing_rates(conn: &Connection) -> Result<Vec<String>, String> {
    let mut st = conn
        .prepare(
            concat!(
                "SELECT DISTINCT a.currency FROM accounts a
                  WHERE a.currency <> ", crate::home_sql!(), "
                    AND NOT EXISTS (SELECT 1 FROM exchange_rates r
                                     WHERE r.currency = a.currency AND r.quote = ", crate::home_sql!(), ")
                  ORDER BY a.currency"
            ),
        )
        .map_err(|e| e.to_string())?;
    let v = st
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(v)
}

/// A typed rate ("1.0875", "0.0542") as millionths. Refuses anything that is
/// not a positive number, has more than six decimals, or is above
/// `MAX_RATE_MICRO`.
pub fn parse_rate(text: &str) -> Result<i64, String> {
    let t = text.trim();
    let d = Decimal::from_str(t).map_err(|_| format!("\"{t}\" is not a rate"))?;
    if d <= Decimal::ZERO {
        return Err("A rate must be more than zero.".to_string());
    }
    if d.scale() > 6 {
        return Err("A rate can have at most six decimal places.".to_string());
    }
    decimal_to_micro(d)
}

/// A fetched rate, rounded to millionths.
pub fn decimal_to_micro(d: Decimal) -> Result<i64, String> {
    let micro = (d * Decimal::from(MICRO))
        .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
        .to_i64()
        .ok_or_else(|| "that rate is out of range".to_string())?;
    if micro <= 0 {
        return Err("that rate rounds to zero".to_string());
    }
    if micro > MAX_RATE_MICRO {
        return Err("A rate above 1,000 per unit is not accepted.".to_string());
    }
    Ok(micro)
}

fn check_date(date: &str) -> Result<(), String> {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| format!("\"{date}\" is not a date (YYYY-MM-DD)"))
}

/// Record a rate for `currency` from `date` on, quoted in the home currency,
/// replacing one already on that day — except that a fetched rate never
/// replaces one the user typed for the same day. Returns whether the rate was
/// stored. `source` is "manual" or "fetched".
pub fn set_rate(conn: &Connection, currency: &str, date: &str, rate_micro: i64, source: &str) -> Result<bool, String> {
    let home = home_currency(conn)?;
    set_rate_quoted(conn, currency, &home, date, rate_micro, source)
}

/// `set_rate` for a rate quoted in `quote`, which must still be the home
/// currency: a fetch that started before the home currency changed would
/// otherwise store a dollar rate as a pound one.
pub fn set_rate_quoted(conn: &Connection, currency: &str, quote: &str, date: &str, rate_micro: i64, source: &str) -> Result<bool, String> {
    let code = currency::validate(currency)?;
    let home = home_currency(conn)?;
    if quote != home {
        return Err(format!("the home currency changed from {quote} to {home} while the rate was being fetched; fetch it again"));
    }
    if code == home {
        return Err(format!("{code} is the home currency; it has no exchange rate."));
    }
    check_date(date)?;
    if rate_micro <= 0 || rate_micro > MAX_RATE_MICRO {
        return Err("That rate is out of range.".to_string());
    }
    if !matches!(source, "manual" | "fetched") {
        return Err(format!("unknown rate source {source}"));
    }
    let n = conn
        .execute(
            "INSERT INTO exchange_rates (currency, quote, date, rate_micro, source) VALUES (?1, ?5, ?2, ?3, ?4)
             ON CONFLICT (currency, quote, date) DO UPDATE SET rate_micro = excluded.rate_micro, source = excluded.source
              WHERE excluded.source = 'manual' OR exchange_rates.source = 'fetched'",
            params![code, date, rate_micro, source, home],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Refuse when an account's currency has no rate at all: a total built from
/// it would leave that account's money out without saying so. The app keeps
/// this from happening (`delete_rate`, `create_account_in`); this is the
/// backstop for every screen that adds money in the home currency.
pub fn require_rates(conn: &Connection) -> Result<(), String> {
    let missing = missing_rates(conn)?;
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "There is no exchange rate for {} in {}. Add one under Settings → Money → Currencies, so those accounts can be counted in the home currency.",
            missing.join(", "),
            home_currency(conn)?
        ))
    }
}

/// An amount's size, checked: positive, and no larger than `MAX_CENTS`.
pub fn magnitude(cents: i64) -> Result<i64, String> {
    match cents.checked_abs() {
        Some(0) => Err("transfer amount must not be zero".to_string()),
        Some(m) if m <= MAX_CENTS => Ok(m),
        _ => Err("That amount is too large.".to_string()),
    }
}

/// Remove one rate. The last rate of a currency an account is kept in is
/// refused: without it that account's money could not be converted at all.
pub fn delete_rate(conn: &Connection, currency: &str, date: &str) -> Result<(), String> {
    let code = currency::validate(currency)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let home = home_currency(&tx)?;
    let (count, in_use): (i64, bool) = tx
        .query_row(
            "SELECT (SELECT COUNT(*) FROM exchange_rates WHERE currency = ?1 AND quote = ?2),
                    EXISTS (SELECT 1 FROM accounts WHERE currency = ?1)",
            params![code, home],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    if count <= 1 && in_use {
        return Err(format!(
            "This is the only {code} rate, and an account is kept in {code}. Add another rate first."
        ));
    }
    let n = tx
        .execute(
            "DELETE FROM exchange_rates WHERE currency = ?1 AND quote = ?3 AND date = ?2",
            params![code, date, home],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("That rate is not in the file.".to_string());
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Every rate quoted in the home currency, newest first within each currency.
pub fn list_rates(conn: &Connection) -> Result<Vec<ExchangeRate>, String> {
    let mut st = conn
        .prepare(concat!(
            "SELECT currency, date, rate_micro, source FROM exchange_rates WHERE quote = ",
            crate::home_sql!(),
            " ORDER BY currency, date DESC"
        ))
        .map_err(|e| e.to_string())?;
    let v = st
        .query_map([], |r| {
            Ok(ExchangeRate { currency: r.get(0)?, date: r.get(1)?, rate_micro: r.get(2)?, source: r.get(3)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(v)
}

/// Whether `currency` has at least one rate in the home currency. The home
/// currency always does.
pub fn has_rate(conn: &Connection, currency: &str) -> Result<bool, String> {
    if currency == home_currency(conn)? {
        return Ok(true);
    }
    conn.query_row(
        concat!("SELECT EXISTS (SELECT 1 FROM exchange_rates WHERE currency = ?1 AND quote = ", crate::home_sql!(), ")"),
        params![currency],
        |r| r.get(0),
    )
    .optional()
    .map(|v| v.unwrap_or(false))
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries::test_support::*;
    use crate::db::queries::create_account_in;

    #[test]
    fn rounding_is_half_away_from_zero_and_symmetric() {
        // 1 cent at 0.5 dollars a unit is half a cent: away from zero both ways.
        assert_eq!(to_home(1, 500_000), 1);
        assert_eq!(to_home(-1, 500_000), -1);
        assert_eq!(to_home(1, 499_999), 0);
        assert_eq!(to_home(10_000, 1_087_500), 10_875);
        assert_eq!(to_home(-10_000, 1_087_500), -10_875);
        assert_eq!(to_home(12_345, MICRO), 12_345);
        // A very large balance does not overflow.
        assert_eq!(to_home(9_000_000_000_000, MAX_RATE_MICRO), 9_000_000_000_000_000);
        assert_eq!(to_home(MAX_CENTS, 1_300_000), 11_709_359_031_163_288);
    }

    #[test]
    fn sql_and_rust_round_the_same_way() {
        let db = TestDb::new("fx-sql-rust");
        let c = db.conn();
        // The last two would pass the i64 range multiplied in one piece.
        for (cents, rate) in [(1i64, 500_000i64), (-1, 500_000), (3, 1_166_667), (-3, 1_166_667), (987_654_321, 54_321), (-987_654_321, 54_321), (0, 1_300_000), (1_999_999, 999_999), (MAX_CENTS, 1_300_000), (-MAX_CENTS, MAX_RATE_MICRO)] {
            let sql: i64 = c
                .query_row(&format!("SELECT {}", to_home_sql!("?1", "?2").replace("?1", &format!("({cents})")).replace("?2", &format!("({rate})"))), [], |r| r.get(0))
                .unwrap();
            assert_eq!(sql, to_home(cents, rate), "{cents} at {rate}");
        }
    }

    #[test]
    fn the_rate_in_force_is_the_latest_on_or_before_and_the_first_before_any() {
        let db = TestDb::new("fx-rate-on");
        let c = db.conn();
        assert_eq!(rate_on(&c, "EUR", "2026-01-01").unwrap(), None);
        set_rate(&c, "EUR", "2026-02-01", 1_080_000, "manual").unwrap();
        set_rate(&c, "EUR", "2026-03-01", 1_100_000, "manual").unwrap();
        assert_eq!(rate_on(&c, "EUR", "2026-01-15").unwrap(), Some(1_080_000), "before the first: the first");
        assert_eq!(rate_on(&c, "EUR", "2026-02-01").unwrap(), Some(1_080_000));
        assert_eq!(rate_on(&c, "EUR", "2026-02-28").unwrap(), Some(1_080_000));
        assert_eq!(rate_on(&c, "EUR", "2026-03-01").unwrap(), Some(1_100_000));
        assert_eq!(rate_on(&c, "EUR", "2027-01-01").unwrap(), Some(1_100_000));
        assert_eq!(rate_on(&c, "USD", "2026-01-01").unwrap(), Some(MICRO));
        assert_eq!(rate_on(&c, "GBP", "2026-03-01").unwrap(), None, "other currencies' rates do not leak");
        // A fetched rate does not replace one typed for the same day...
        assert!(!set_rate(&c, "EUR", "2026-03-01", 1_120_000, "fetched").unwrap());
        assert_eq!(rate_on(&c, "EUR", "2026-03-15").unwrap(), Some(1_100_000));
        // ...a typed one does, and a fetched one replaces a fetched one.
        assert!(set_rate(&c, "EUR", "2026-03-01", 1_120_000, "manual").unwrap());
        assert_eq!(rate_on(&c, "EUR", "2026-03-15").unwrap(), Some(1_120_000));
        set_rate(&c, "EUR", "2026-04-01", 1_130_000, "fetched").unwrap();
        assert!(set_rate(&c, "EUR", "2026-04-01", 1_140_000, "fetched").unwrap());
        assert_eq!(rate_on(&c, "EUR", "2026-04-01").unwrap(), Some(1_140_000));
        assert_eq!(list_rates(&c).unwrap().len(), 3);
    }

    #[test]
    fn bad_rates_and_codes_are_refused() {
        let db = TestDb::new("fx-refuse");
        let c = db.conn();
        assert!(set_rate(&c, "USD", "2026-01-01", MICRO, "manual").is_err());
        assert!(set_rate(&c, "JPY", "2026-01-01", 6_700, "manual").is_err());
        assert!(set_rate(&c, "EUR", "2026-13-01", MICRO, "manual").is_err());
        assert!(set_rate(&c, "EUR", "2026-01-01", 0, "manual").is_err());
        assert!(set_rate(&c, "EUR", "2026-01-01", MAX_RATE_MICRO + 1, "manual").is_err());
        assert!(set_rate(&c, "EUR", "2026-01-01", MICRO, "guessed").is_err());
        assert_eq!(parse_rate("1.0875").unwrap(), 1_087_500);
        assert_eq!(parse_rate(" 0.054321 ").unwrap(), 54_321);
        assert!(parse_rate("0").is_err());
        assert!(parse_rate("-1.1").is_err());
        assert!(parse_rate("1.0000001").is_err());
        assert!(parse_rate("abc").is_err());
        assert!(parse_rate("1001").is_err());
    }

    #[test]
    fn the_last_rate_of_a_currency_in_use_cannot_be_deleted() {
        let db = TestDb::new("fx-delete");
        let c = db.conn();
        set_rate(&c, "EUR", "2026-02-01", 1_080_000, "manual").unwrap();
        create_account_in(&c, "Euro Checking", "checking", 0, Some("2026-01-01"), "EUR").unwrap();
        assert!(delete_rate(&c, "EUR", "2026-02-01").is_err());
        set_rate(&c, "EUR", "2026-03-01", 1_100_000, "manual").unwrap();
        delete_rate(&c, "EUR", "2026-02-01").unwrap();
        assert!(delete_rate(&c, "EUR", "2026-02-01").is_err(), "already gone");
        assert_eq!(missing_rates(&c).unwrap(), Vec::<String>::new());
    }
}
