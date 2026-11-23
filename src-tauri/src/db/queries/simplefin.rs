//! The SimpleFIN accounts a file knows about, which T-Money account each one
//! fills, and the daily request budget. The credential is not here — it is
//! in Windows Credential Manager (see `commands::simplefin_*`).

use crate::models::SimplefinAccount;
use crate::simplefin::{AccountSet, DAILY_REQUESTS};
use rusqlite::{params, Connection, OptionalExtension};

const REQUESTS_KEY: &str = "simplefin.requests";
const CONNECTION_KEY: &str = "simplefin.connection";

/// The id naming this file's SimpleFIN entry in Credential Manager, if it
/// has ever been connected.
pub fn simplefin_connection_id(conn: &Connection) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM app_settings WHERE key = ?1", params![CONNECTION_KEY], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

/// A fresh id for a new connection. Fresh each time, so a connection made
/// after a disconnect never reuses an entry that might linger.
pub fn new_simplefin_connection_id(conn: &Connection) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        params![CONNECTION_KEY, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn list_simplefin_accounts(conn: &Connection) -> Result<Vec<SimplefinAccount>, String> {
    let mut st = conn
        .prepare(
            "SELECT s.sf_id, s.name, s.org,
                    COALESCE(s.currency, CASE WHEN s.currency_missing = 1 THEN s.currency_confirmed END),
                    s.balance_cents, s.balance_date, s.account_id, a.name, s.synced_through,
                    s.currency_missing, s.currency_confirmed
               FROM simplefin_accounts s LEFT JOIN accounts a ON a.id = s.account_id
              ORDER BY COALESCE(s.org, ''), s.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let v = st
        .query_map([], |r| {
            Ok(SimplefinAccount {
                sf_id: r.get(0)?,
                name: r.get(1)?,
                org: r.get(2)?,
                currency: r.get(3)?,
                balance_cents: r.get(4)?,
                balance_date: r.get(5)?,
                account_id: r.get(6)?,
                account_name: r.get(7)?,
                synced_through: r.get(8)?,
                currency_missing: r.get(9)?,
                currency_confirmed: r.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(v)
}

/// Record what the server reported: new accounts appear unlinked, known
/// ones get their name and balance refreshed, links are kept.
pub fn upsert_simplefin_accounts(conn: &Connection, set: &AccountSet) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for a in &set.accounts {
        tx.execute(
            "INSERT INTO simplefin_accounts (sf_id, name, org, currency, currency_missing, balance_cents, balance_date)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (sf_id) DO UPDATE SET name = excluded.name, org = excluded.org,
                currency = excluded.currency, currency_missing = excluded.currency_missing,
                balance_cents = excluded.balance_cents, balance_date = excluded.balance_date",
            params![a.id, a.name, a.org, a.currency, a.currency_missing, a.balance_cents, a.balance_date],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Link a SimpleFIN account to a T-Money account (`None` unlinks it).
/// Refused when the currencies differ or the account is already fed by
/// another one. A link to a different account starts its fetching afresh.
pub fn link_simplefin_account(conn: &Connection, sf_id: &str, account_id: Option<&str>) -> Result<(), String> {
    let (sf_name, sf_currency, missing, current): (String, Option<String>, bool, Option<String>) = conn
        .query_row(
            "SELECT name, COALESCE(currency, CASE WHEN currency_missing = 1 THEN currency_confirmed END), currency_missing, account_id
               FROM simplefin_accounts WHERE sf_id = ?1",
            params![sf_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That SimpleFIN account is not known to this file.".to_string())?;
    let Some(account_id) = account_id.filter(|a| !a.is_empty()) else {
        conn.execute("UPDATE simplefin_accounts SET account_id = NULL, synced_through = NULL WHERE sf_id = ?1", params![sf_id])
            .map_err(|e| e.to_string())?;
        return Ok(());
    };
    if current.as_deref() == Some(account_id) {
        return Ok(());
    }
    let (name, currency, kind, closed): (String, String, String, bool) = conn
        .query_row("SELECT name, currency, type, is_closed FROM accounts WHERE id = ?1", params![account_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That account is not in the file.".to_string())?;
    if closed {
        return Err(format!("{name} is closed. Reopen it first if the bank account is still in use."));
    }
    if matches!(kind.as_str(), "employee_stock_option" | "watch") {
        return Err(format!(
            "{name} tracks shares only. SimpleFIN reports amounts, not shares, so it cannot fill this kind of account."
        ));
    }
    if is_balance_only(&kind) && has_holdings(conn, account_id)? {
        return Err(format!(
            "{name} has holdings. SimpleFIN can keep an investment or retirement account's balance only when T-Money tracks no shares in it, so the two never mix. Link it to an investment or retirement account without holdings."
        ));
    }
    match sf_currency.as_deref() {
        Some(c) if c == currency => {}
        Some(c) => return Err(format!("{sf_name} is in {c} and {name} is kept in {currency}. Link it to an account kept in {c}.")),
        None if missing => {
            return Err(format!("SimpleFIN did not say what currency {sf_name} is in. Choose its currency first."))
        }
        None => return Err(format!("{sf_name} is not in a currency T-Money can account for.")),
    }
    let taken: Option<String> = conn
        .query_row("SELECT name FROM simplefin_accounts WHERE account_id = ?1 AND sf_id <> ?2", params![account_id, sf_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(other) = taken {
        return Err(format!("{name} is already filled from {other}. Unlink that one first."));
    }
    conn.execute(
        "UPDATE simplefin_accounts SET account_id = ?2, synced_through = NULL WHERE sf_id = ?1",
        params![sf_id, account_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// An investment or retirement account: SimpleFIN fills it with its balance
/// only, never transactions, and only while it holds no shares.
pub fn is_balance_only(kind: &str) -> bool {
    matches!(kind, "investment" | "retirement")
}

/// Whether T-Money tracks any shares in the account: any live row naming
/// a security.
pub fn has_holdings(conn: &Connection, account_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM transactions WHERE account_id = ?1 AND security_id IS NOT NULL AND is_void = 0)",
        params![account_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Say which currency a SimpleFIN account with a blank currency is in
/// (`None` forgets the choice). Only for one SimpleFIN left blank; a code
/// SimpleFIN gave is never overridden. Refused while it is linked to an
/// account kept in another currency.
pub fn confirm_simplefin_currency(conn: &Connection, sf_id: &str, code: Option<&str>) -> Result<(), String> {
    let (name, missing, account): (String, bool, Option<String>) = conn
        .query_row(
            "SELECT name, currency_missing, account_id FROM simplefin_accounts WHERE sf_id = ?1",
            params![sf_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That SimpleFIN account is not known to this file.".to_string())?;
    if !missing {
        return Err(format!("SimpleFIN already says what currency {name} is in."));
    }
    let code = match code.map(|c| c.trim().to_ascii_uppercase()).filter(|c| !c.is_empty()) {
        Some(c) if crate::currency::CURRENCIES.iter().any(|k| k.code == c) => Some(c),
        Some(c) => return Err(format!("{c} is not a currency T-Money keeps.")),
        None => None,
    };
    if let Some(account_id) = account {
        let kept: String = conn
            .query_row("SELECT currency FROM accounts WHERE id = ?1", params![account_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if code.as_deref() != Some(kept.as_str()) {
            return Err(format!("{name} is linked to an account kept in {kept}. Unlink it first to change its currency."));
        }
    }
    conn.execute("UPDATE simplefin_accounts SET currency_confirmed = ?2 WHERE sf_id = ?1", params![sf_id, code])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The date of the newest transaction SimpleFIN wrote into an account, or
/// None when it holds none. A range on the bank id, so the index serves it.
pub fn latest_feed_date(conn: &Connection, account_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT MAX(date) FROM transactions WHERE account_id = ?1 AND fitid >= 'sfin:' AND fitid < 'sfin;'",
        params![account_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

pub fn set_simplefin_synced(conn: &Connection, sf_id: &str, through: &str) -> Result<(), String> {
    conn.execute("UPDATE simplefin_accounts SET synced_through = ?2 WHERE sf_id = ?1", params![sf_id, through])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Forget every SimpleFIN account and the connection's id (on
/// disconnecting). Transactions already fetched stay in their registers. The
/// request count stays too: SimpleFIN is still counting.
pub fn clear_simplefin(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM simplefin_accounts", []).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM app_settings WHERE key = ?1", params![CONNECTION_KEY]).map_err(|e| e.to_string())?;
    Ok(())
}

const DAY_SECS: i64 = 86_400;

/// The times (Unix seconds) of the requests made in the 24 hours before
/// `now`. A rolling day, not a calendar one: twenty just before midnight and
/// twenty just after would be forty in an hour to SimpleFIN.
fn recent_requests(conn: &Connection, now: i64) -> Result<Vec<i64>, String> {
    let v: Option<String> = conn
        .query_row("SELECT value FROM app_settings WHERE key = ?1", params![REQUESTS_KEY], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(v.unwrap_or_default()
        .split_whitespace()
        .filter_map(|t| t.parse::<i64>().ok())
        // A time ahead of `now` means the clock was set back; it still
        // counts, or setting it back would hand out a fresh budget.
        .filter(|t| *t > now - DAY_SECS && *t <= now + DAY_SECS)
        .collect())
}

/// Requests made to SimpleFIN in the last 24 hours.
pub fn simplefin_requests_today(conn: &Connection, now: i64) -> Result<u32, String> {
    Ok(recent_requests(conn, now)?.len() as u32)
}

/// Count one request against the last 24 hours' budget, or refuse when it
/// is spent. Counted before the request is sent, so a failed request still
/// counts — the server counted it too.
pub fn take_simplefin_request(conn: &Connection, now: i64) -> Result<(), String> {
    take_simplefin_requests(conn, now, 1)
}

/// `take_simplefin_request` for `n` at once: all of them, or none, so a
/// fetch that needs two requests is never cut off after the first.
pub fn take_simplefin_requests(conn: &Connection, now: i64, n: u32) -> Result<(), String> {
    let mut times = recent_requests(conn, now)?;
    if times.len() as u32 + n > DAILY_REQUESTS {
        // The oldest one in the window is the next to fall out of it.
        let free_at = times.iter().min().copied().unwrap_or(now) + DAY_SECS;
        let wait_h = ((free_at - now) as f64 / 3600.0).ceil().max(1.0) as i64;
        return Err(format!(
            "T-Money has asked SimpleFIN {} times in the last 24 hours, which is as often as SimpleFIN allows an app. Try again in about {wait_h} hour{}.",
            times.len(),
            if wait_h == 1 { "" } else { "s" }
        ));
    }
    times.extend(std::iter::repeat_n(now, n as usize));
    let value = times.iter().map(i64::to_string).collect::<Vec<_>>().join(" ");
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        params![REQUESTS_KEY, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
