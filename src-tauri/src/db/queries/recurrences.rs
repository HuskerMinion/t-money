//! Scheduled bills and income (migration 0019): occurrences, entering them, and
//! the cash forecast.

use crate::models::{
    CashForecast, DetectedCharge, ForecastPoint, NewRecurrence, Occurrence, Recurrence,
    Transaction,
};
use crate::schedule::{self, Freq, Rule, WeekendRule};
use chrono::{Duration, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;
use super::*;

// ---------------------------------------------------------------------------
// Scheduled bills and income (migration 0019)
// ---------------------------------------------------------------------------

const RECURRENCE_SELECT: &str = r#"
    SELECT r.id, r.payee, r.amount_cents, r.account_id, a.name,
           r.category_id,
           CASE WHEN c.id IS NULL THEN NULL
                WHEN c.parent_id IS NULL THEN c.name
                ELSE pc.name || ' : ' || c.name END,
           r.freq, r.interval_n, r.start_date, r.end_date, r.second_day,
           r.weekend_rule, r.notes, r.is_active, r.updated_at,
           r.transfer_account_id, ta.name, r.goal_id, g.name
      FROM recurrences r
      LEFT JOIN accounts a    ON a.id = r.account_id
      LEFT JOIN accounts ta   ON ta.id = r.transfer_account_id
      LEFT JOIN goals g       ON g.id = r.goal_id
      LEFT JOIN categories c  ON c.id = r.category_id
      LEFT JOIN categories pc ON pc.id = c.parent_id
"#;

fn map_recurrence(row: &Row) -> rusqlite::Result<Recurrence> {
    Ok(Recurrence {
        id: row.get(0)?,
        payee: row.get(1)?,
        amount_cents: row.get(2)?,
        account_id: row.get(3)?,
        account_name: row.get(4)?,
        category_id: row.get(5)?,
        category_name: row.get(6)?,
        freq: row.get(7)?,
        interval_n: row.get(8)?,
        start_date: row.get(9)?,
        end_date: row.get(10)?,
        second_day: row.get(11)?,
        weekend_rule: row.get(12)?,
        notes: row.get(13)?,
        is_active: row.get::<_, i64>(14)? != 0,
        updated_at: row.get(15)?,
        transfer_account_id: row.get(16)?,
        transfer_account_name: row.get(17)?,
        goal_id: row.get(18)?,
        goal_name: row.get(19)?,
    })
}

pub fn list_recurrences(conn: &Conn) -> Result<Vec<Recurrence>, String> {
    let sql = format!("{RECURRENCE_SELECT} ORDER BY r.is_active DESC, r.payee COLLATE NOCASE");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let out = stmt
        .query_map([], map_recurrence)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn get_recurrence(conn: &Conn, id: &str) -> Result<Recurrence, String> {
    let sql = format!("{RECURRENCE_SELECT} WHERE r.id = ?1");
    conn.query_row(&sql, params![id], map_recurrence)
        .map_err(|e| e.to_string())
}

/// Validate and store a rule. The frequency and weekend rule are parsed here
/// as well as CHECKed by the schema, so a bad value fails with a sentence
/// rather than a constraint error.
pub fn create_recurrence(conn: &Conn, r: &NewRecurrence) -> Result<Recurrence, String> {
    validate_recurrence(conn, r)?;
    // §181 — a new scheduled transfer may not start or end in a closed account.
    if let (Some(to), Some(from)) = (
        r.transfer_account_id.as_deref().filter(|t| !t.is_empty()),
        r.account_id.as_deref().filter(|f| !f.is_empty()),
    ) {
        refuse_new_link_to_closed(conn, &[to, from])?;
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO recurrences
             (id, payee, amount_cents, account_id, category_id, freq, interval_n,
              start_date, end_date, second_day, weekend_rule, notes, transfer_account_id, goal_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            id, r.payee.trim(), r.amount_cents, r.account_id, r.category_id, r.freq,
            r.interval_n, r.start_date, r.end_date, r.second_day, r.weekend_rule, r.notes,
            r.transfer_account_id, r.goal_id
        ],
    )
    .map_err(|e| e.to_string())?;
    get_recurrence(conn, &id)
}

pub fn update_recurrence(conn: &Conn, id: &str, r: &NewRecurrence) -> Result<Recurrence, String> {
    validate_recurrence(conn, r)?;
    // §181 — the same for an edit, but only for an account the rule did not
    // already name: a schedule written before its account was closed can
    // still be edited (to stop it, say) without being refused.
    if let (Some(to), Some(from)) = (
        r.transfer_account_id.as_deref().filter(|t| !t.is_empty()),
        r.account_id.as_deref().filter(|f| !f.is_empty()),
    ) {
        let before = get_recurrence(conn, id).ok();
        let had = |a: &str| {
            before
                .as_ref()
                .is_some_and(|b| b.transfer_account_id.as_deref() == Some(a) || b.account_id.as_deref() == Some(a))
        };
        let new: Vec<&str> = [to, from].into_iter().filter(|a| !had(a)).collect();
        refuse_new_link_to_closed(conn, &new)?;
    }
    let n = conn
        .execute(
            "UPDATE recurrences
                SET payee = ?2, amount_cents = ?3, account_id = ?4, category_id = ?5,
                    freq = ?6, interval_n = ?7, start_date = ?8, end_date = ?9,
                    second_day = ?10, weekend_rule = ?11, notes = ?12,
                    transfer_account_id = ?13, goal_id = ?14,
                    updated_at = datetime('now')
              WHERE id = ?1",
            params![
                id, r.payee.trim(), r.amount_cents, r.account_id, r.category_id, r.freq,
                r.interval_n, r.start_date, r.end_date, r.second_day, r.weekend_rule, r.notes,
                r.transfer_account_id, r.goal_id
            ],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("scheduled item {id} not found"));
    }
    get_recurrence(conn, id)
}

fn validate_recurrence(conn: &Conn, r: &NewRecurrence) -> Result<(), String> {
    if r.payee.trim().is_empty() {
        return Err("give the scheduled item a payee".to_string());
    }
    if r.amount_cents == 0 {
        return Err("a scheduled item needs an amount".to_string());
    }
    // A scheduled transfer (§57): money leaves account_id for
    // transfer_account_id, so it needs both, different, and a negative amount.
    if let Some(to) = r.transfer_account_id.as_deref().filter(|t| !t.is_empty()) {
        let Some(from) = r.account_id.as_deref().filter(|f| !f.is_empty()) else {
            return Err("a scheduled transfer needs the account the money comes from".to_string());
        };
        if from == to {
            return Err("a transfer needs two different accounts".to_string());
        }
        if r.amount_cents > 0 {
            return Err("a scheduled transfer is money out of the first account — enter it as money out".to_string());
        }
        get_account(conn, to).map_err(|_| "the receiving account does not exist".to_string())?;
        if let Some(g) = r.goal_id.as_deref().filter(|g| !g.is_empty()) {
            let goal = get_goal(conn, g)?;
            if goal.account_id.as_deref() != Some(to) {
                return Err(format!("the goal \"{}\" does not watch the receiving account", goal.name));
            }
        }
    } else if r.goal_id.as_deref().is_some_and(|g| !g.is_empty()) {
        return Err("a goal can only be tagged on a scheduled transfer".to_string());
    }
    Freq::parse(&r.freq)?;
    WeekendRule::parse(&r.weekend_rule)?;
    if r.interval_n < 1 {
        return Err("the interval must be at least 1".to_string());
    }
    parse_date(&r.start_date)?;
    if let Some(e) = &r.end_date {
        let end = parse_date(e)?;
        if end < parse_date(&r.start_date)? {
            return Err("the end date is before the start date".to_string());
        }
    }
    Ok(())
}

pub(super) fn parse_date(s: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| format!("{s:?} is not a date"))
}

pub fn delete_recurrence(conn: &Conn, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM recurrences WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_recurrence_active(conn: &Conn, id: &str, active: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE recurrences SET is_active = ?2, updated_at = datetime('now') WHERE id = ?1",
        params![id, active as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn rule_of(r: &Recurrence) -> Result<Rule, String> {
    Ok(Rule {
        freq: Freq::parse(&r.freq)?,
        interval_n: r.interval_n.max(1) as u32,
        start: parse_date(&r.start_date)?,
        end: r.end_date.as_deref().map(parse_date).transpose()?,
        second_day: r.second_day.map(|d| d as u32),
        weekend_rule: WeekendRule::parse(&r.weekend_rule)?,
    })
}

/// Every occurrence between `from` and `to`, resolved against what actually
/// happened, oldest first.
///
/// Status precedence — this is the whole design:
///
/// 1. **An explicit action wins.** The user clicked Paid or Skipped on that
///    occurrence, and nothing may second-guess it.
/// 2. **Otherwise, auto-match against the register.** A bill the user paid by
///    hand must stop nagging, and must not be projected on top of the real
///    transaction that already moved the money.
/// 3. Otherwise it is `due`, or `overdue` once its date has passed.
///
/// Matching ignores the AMOUNT on purpose: utilities vary every month, so
/// requiring an exact figure would fail for precisely the bills that vary.
/// Account + payee + a date window is the reliable signal. Each transaction
/// can satisfy at most one occurrence, so two months of rent cannot both match
/// the same payment.
pub fn occurrences_between(
    conn: &Conn,
    from: NaiveDate,
    to: NaiveDate,
    today: NaiveDate,
) -> Result<Vec<Occurrence>, String> {
    /// How far either side of the due date a real transaction may sit and
    /// still be the same bill.
    const MATCH_WINDOW_DAYS: i64 = 7;

    let mut out: Vec<Occurrence> = Vec::new();
    // A transaction may satisfy only one occurrence.
    let mut claimed: std::collections::HashSet<String> = std::collections::HashSet::new();

    for r in list_recurrences(conn)?.into_iter().filter(|r| r.is_active) {
        let rule = rule_of(&r)?;
        for due in schedule::occurrences(&rule, from, to) {
            let due_s = due.to_string();

            // 1. An explicit action wins.
            let explicit: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT status, transaction_id FROM recurrence_exceptions
                      WHERE recurrence_id = ?1 AND due_date = ?2",
                    params![r.id, due_s],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;

            let (status, txn_id, actual) = match explicit {
                Some((status, txn_id)) => {
                    let actual = match &txn_id {
                        Some(t) => amount_of_transaction(conn, t)?,
                        None => None,
                    };
                    if let Some(t) = &txn_id {
                        claimed.insert(t.clone());
                    }
                    (status, txn_id, actual)
                }
                None => {
                    // 2. Auto-match.
                    let lo = (due - Duration::days(MATCH_WINDOW_DAYS)).to_string();
                    let hi = (due + Duration::days(MATCH_WINDOW_DAYS)).to_string();
                    let found: Vec<(String, i64)> = {
                        let mut stmt = conn
                            .prepare(
                                "SELECT t.id, t.amount_cents FROM transactions t
                                  WHERE t.is_void = 0
                                    AND t.date BETWEEN ?1 AND ?2
                                    AND (?4 IS NULL OR t.account_id = ?4)
                                    AND CASE WHEN ?6 IS NULL
                                             THEN lower(trim(t.payee)) = lower(trim(?3))
                                             -- A scheduled transfer (§57): a transfer row to the
                                             -- right account, under the rule's name or the plain one.
                                             ELSE t.amount_cents < 0
                                                  AND (lower(trim(t.payee)) = lower(trim(?3)) OR t.payee = 'Transfer Money')
                                                  AND EXISTS (SELECT 1 FROM transactions p
                                                               WHERE p.id = t.transfer_id AND p.account_id = ?6)
                                        END
                                  ORDER BY abs(julianday(t.date) - julianday(?5)), t.rowid",
                            )
                            .map_err(|e| e.to_string())?;
                        let rows = stmt
                            .query_map(params![lo, hi, r.payee, r.account_id, due_s, r.transfer_account_id], |row| {
                                Ok((row.get(0)?, row.get(1)?))
                            })
                            .map_err(|e| e.to_string())?
                            .collect::<Result<Vec<_>, _>>()
                            .map_err(|e| e.to_string())?;
                        rows
                    };
                    match found.into_iter().find(|(id, _)| !claimed.contains(id)) {
                        Some((id, amount)) => {
                            claimed.insert(id.clone());
                            ("matched".to_string(), Some(id), Some(amount))
                        }
                        // 3. Still expected.
                        None => {
                            let s = if due < today { "overdue" } else { "due" };
                            (s.to_string(), None, None)
                        }
                    }
                }
            };

            out.push(Occurrence {
                recurrence_id: r.id.clone(),
                payee: r.payee.clone(),
                amount_cents: r.amount_cents,
                account_id: r.account_id.clone(),
                account_name: r.account_name.clone(),
                category_id: r.category_id.clone(),
                category_name: r.category_name.clone(),
                due_date: due_s,
                status,
                transaction_id: txn_id,
                actual_amount_cents: actual,
                transfer_account_id: r.transfer_account_id.clone(),
                transfer_account_name: r.transfer_account_name.clone(),
            });
        }
    }
    out.sort_by(|a, b| a.due_date.cmp(&b.due_date).then(a.payee.cmp(&b.payee)));
    Ok(out)
}

fn amount_of_transaction(conn: &Conn, id: &str) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT amount_cents FROM transactions WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Record an explicit decision about one occurrence.
fn set_exception(
    conn: &Connection,
    recurrence_id: &str,
    due_date: &str,
    status: &str,
    transaction_id: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO recurrence_exceptions (id, recurrence_id, due_date, status, transaction_id)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (recurrence_id, due_date)
         DO UPDATE SET status = excluded.status, transaction_id = excluded.transaction_id",
        params![Uuid::new_v4().to_string(), recurrence_id, due_date, status, transaction_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Enter an occurrence into the register: writes a real transaction and marks
/// the occurrence paid, linked to it.
///
/// `amount_cents` overrides the rule's amount for this one instance, which is
/// how a variable bill is entered without editing the rule.
pub fn enter_occurrence(
    conn: &Conn,
    recurrence_id: &str,
    due_date: &str,
    date: &str,
    amount_cents: Option<i64>,
    account_id: Option<&str>,
) -> Result<Transaction, String> {
    let r = get_recurrence(conn, recurrence_id)?;
    let account = account_id
        .map(|s| s.to_string())
        .or_else(|| r.account_id.clone())
        .ok_or("this scheduled item has no account to enter it into")?;
    let amount = amount_cents.unwrap_or(r.amount_cents);

    // The register row and the "paid" mark land together. Without this, a
    // failed exception write left a real transaction with the bill still
    // listed as due — and paying it again would have entered it twice.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let txn_id = match r.transfer_account_id.as_deref().filter(|t| !t.is_empty()) {
        // A scheduled transfer (§57): the linked pair, the sending half is
        // the one the occurrence points at; the receiving half is tagged
        // for the goal when the rule names one.
        Some(to) => {
            // §181 — entering it writes a new transfer, so a schedule whose
            // account has been closed since stops here with a sentence
            // rather than moving money into an account nobody is watching.
            refuse_new_link_to_closed(&tx, &[account.as_str(), to])?;
            let (from_id, to_id) = insert_transfer_pair_named(&tx, &account, to, date, amount.abs(), r.notes.as_deref(), &r.payee)?;
            if let Some(g) = r.goal_id.as_deref().filter(|g| !g.is_empty()) {
                tx.execute("UPDATE transactions SET goal_id = ?2 WHERE id = ?1", params![to_id, g])
                    .map_err(|e| e.to_string())?;
            }
            from_id
        }
        None => insert_transaction(
            &tx,
            &account,
            date,
            &r.payee,
            r.category_id.as_deref(),
            amount,
            None,
            None,
        )?,
    };
    set_exception(&tx, recurrence_id, due_date, "paid", Some(&txn_id))?;
    tx.commit().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, account_id, date, payee, category_id, amount_cents, is_reconciled, notes
         FROM transactions WHERE id = ?1",
        params![txn_id],
        map_txn,
    )
    .map_err(|e| e.to_string())
}

/// Skip one occurrence — it is not going to happen, and should stop being
/// projected or listed.
pub fn skip_occurrence(conn: &Conn, recurrence_id: &str, due_date: &str) -> Result<(), String> {
    set_exception(conn, recurrence_id, due_date, "skipped", None)
}

/// Undo an explicit decision, returning the occurrence to due/matched.
pub fn clear_occurrence(conn: &Conn, recurrence_id: &str, due_date: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM recurrence_exceptions WHERE recurrence_id = ?1 AND due_date = ?2",
        params![recurrence_id, due_date],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Project one account's balance forward.
///
/// The starting point is subtle and worth stating: `accounts.balance_cents` is
/// maintained over EVERY transaction, including future-dated ones. Projecting
/// from it and then re-applying those future rows would count them twice, so
/// they are taken back out first and re-applied on their own dates.
pub fn cash_forecast(
    conn: &Conn,
    account_id: &str,
    from: NaiveDate,
    days: i64,
) -> Result<CashForecast, String> {
    cash_forecast_with(conn, account_id, from, days, false)
}

/// §173 — the recurring charges the subscription detector (§60) finds in ONE
/// account: the same test the Home card applies, over the last two years,
/// scoped to the account being projected. Only charges still being made
/// (`active`) are returned, newest-first is not needed: the caller projects
/// each one forward from its last charge.
pub fn detected_charges(conn: &Conn, account_id: &str, asof: NaiveDate) -> Result<Vec<(String, crate::db::reports::Subscription)>, String> {
    let since = (asof - Duration::days(730)).to_string();
    let mut stmt = conn
        .prepare(
            "SELECT lower(trim(t.payee)), t.payee, t.date, -t.amount_cents
               FROM transactions t
              WHERE t.account_id = ?1 AND t.is_void = 0 AND t.transfer_id IS NULL AND t.activity IS NULL
                AND t.is_revaluation = 0 AND t.is_split_transfer = 0
                AND t.amount_cents < 0 AND trim(t.payee) <> ''
                AND t.date >= ?2 AND t.date <= ?3
              ORDER BY 1, t.date",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, i64)> = stmt
        .query_map(params![account_id, since, asof.to_string()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut groups: Vec<(String, Vec<(NaiveDate, i64)>)> = Vec::new();
    let mut key = String::new();
    for (k, name, date, amt) in rows {
        if k != key || groups.is_empty() {
            groups.push((name.clone(), Vec::new()));
            key = k;
        }
        let g = groups.last_mut().unwrap();
        g.0 = name;
        g.1.push((parse_date(&date)?, amt));
    }
    Ok(groups
        .into_iter()
        // §173.1 — with the amount test relaxed: the forecast wants the
        // power bill too, at the median of its last three.
        .filter_map(|(name, charges)| crate::db::reports::detect_recurring(&charges, asof, true).map(|s| (name, s)))
        .filter(|(_, s)| s.active)
        .collect())
}

/// §173 — `cash_forecast`, and with `include_detected` the recurring charges
/// the detector has noticed in this account as well.
///
/// > *"Quicken and Monarch also project from recurring history it detects
/// > on its own. Your subscriptions report already detects those charges,
/// > so the pieces exist and are not joined."*
///
/// A detected charge is projected from its last charge forward by its
/// cadence, on every day inside the window; one that was expected before
/// the window opened and has not come lands on day one, like an overdue
/// bill. A payee that already has an active scheduled rule in this account
/// is left to the rule (and named in `covered_by_bills`). §173.3: a payee on
/// the Home card's ignore list (§76, `ui.subscriptions.ignored`) is
/// projected all the same and flagged — the Help tells the user to put the
/// mortgage on that list ("not a reminder"), and leaving it out of the
/// forecast silently made a $1,800 hole every month.
pub fn cash_forecast_with(
    conn: &Conn,
    account_id: &str,
    from: NaiveDate,
    days: i64,
    include_detected: bool,
) -> Result<CashForecast, String> {
    let account = get_account(conn, account_id)?;
    // Ten years is already far past anything a cash-flow chart can say.
    // Unclamped, `Duration::days` panics on a large value and the loop below
    // would build one point per day of it.
    let days = days.clamp(1, 3660);
    let to = from + Duration::days(days);
    let from_s = from.to_string();

    let future_sum: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount_cents), 0) FROM transactions
              WHERE account_id = ?1 AND is_void = 0 AND date > ?2",
            params![account_id, from_s],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let starting = account.balance_cents - future_sum;

    // Day → what moves that day.
    let mut deltas: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();

    // Real transactions already in the register, dated ahead.
    {
        let mut stmt = conn
            .prepare(
                "SELECT date, SUM(amount_cents) FROM transactions
                  WHERE account_id = ?1 AND is_void = 0 AND date > ?2 AND date <= ?3
                  GROUP BY date",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![account_id, from_s, to.to_string()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for (date, sum) in rows {
            *deltas.entry(date).or_insert(0) += sum;
        }
    }

    // Scheduled items still expected. Paid, skipped and matched ones are
    // deliberately absent: paid and matched are already real rows above, and
    // skipped is not going to happen.
    // The window opens 30 days back, the same as `get_upcoming`: an unpaid
    // bill that was due yesterday is still going to hit the account, and a
    // forecast that starts today would leave it out. Overdue amounts land on
    // day one of the projection.
    let all = occurrences_between(conn, from - Duration::days(30), to, from)?;
    let upcoming: Vec<Occurrence> = all
        .into_iter()
        .filter(|o| o.account_id.as_deref() == Some(account_id) || o.transfer_account_id.as_deref() == Some(account_id))
        .filter(|o| o.status == "due" || o.status == "overdue")
        .collect();
    for o in &upcoming {
        let day = if o.due_date < from_s { from_s.clone() } else { o.due_date.clone() };
        // A scheduled transfer (§57) leaves one account and lands in the
        // other: the receiving account sees it coming in.
        let delta = if o.account_id.as_deref() == Some(account_id) { o.amount_cents } else { -o.amount_cents };
        *deltas.entry(day).or_insert(0) += delta;
    }

    // §173 — what the detector has noticed, projected the same way.
    let mut detected: Vec<DetectedCharge> = Vec::new();
    // §173.2 — the payees the detector found but left to their scheduled
    // bills, named so the list does not look as if it missed the mortgage.
    let mut covered_by_bills: Vec<String> = Vec::new();
    if include_detected {
        let ignored: Vec<String> = get_setting(conn, "ui.subscriptions.ignored")?
            .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.trim().to_lowercase())
            .collect();
        let scheduled: Vec<String> = {
            let mut st = conn
                .prepare("SELECT lower(trim(payee)) FROM recurrences WHERE is_active = 1 AND (account_id = ?1 OR transfer_account_id = ?1)")
                .map_err(|e| e.to_string())?;
            let v = st
                .query_map(params![account_id], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            v
        };
        for (payee, sub) in detected_charges(conn, account_id, from)? {
            let key = payee.trim().to_lowercase();
            let ignored_on_home = ignored.contains(&key);
            if scheduled.contains(&key) {
                covered_by_bills.push(payee);
                continue;
            }
            // A monthly charge lands on the same day of the month, not 30
            // days on: the detector's cadence is in days, the calendar's is
            // not, and a forecast that drifts a day a month is wrong by the
            // third one. Weekly cadences are exact in days already.
            let months = match sub.cadence {
                "month" => Some(1),
                "2 months" => Some(2),
                "quarter" => Some(3),
                "6 months" => Some(6),
                "year" => Some(12),
                _ => None,
            };
            let step = |d: NaiveDate| -> NaiveDate {
                match months {
                    Some(n) => d.checked_add_months(chrono::Months::new(n)).unwrap_or(d + Duration::days(sub.days)),
                    None => d + Duration::days(sub.days),
                }
            };
            let mut dates = Vec::new();
            let mut d = step(sub.last);
            while d <= to {
                // Expected before the window and not seen: it is still coming,
                // and lands on day one like an overdue bill.
                let day = if d < from { from_s.clone() } else { d.to_string() };
                *deltas.entry(day.clone()).or_insert(0) -= sub.amount_cents;
                dates.push(day);
                d = step(d);
            }
            if dates.is_empty() {
                continue;
            }
            detected.push(DetectedCharge {
                payee,
                amount_cents: -sub.amount_cents,
                cadence: sub.cadence.to_string(),
                last: sub.last.to_string(),
                charges: sub.charges,
                dates,
                varies: sub.varies,
                ignored_on_home,
            });
        }
        detected.sort_by(|a, b| a.dates[0].cmp(&b.dates[0]).then(a.payee.to_lowercase().cmp(&b.payee.to_lowercase())));
    }

    let mut points = Vec::new();
    let mut running = starting;
    let mut low = starting;
    let mut low_date = from_s.clone();
    let mut day = from;
    while day <= to {
        let key = day.to_string();
        let delta = deltas.get(&key).copied().unwrap_or(0);
        running += delta;
        if running < low {
            low = running;
            low_date = key.clone();
        }
        points.push(ForecastPoint {
            date: key,
            delta_cents: delta,
            balance_cents: running,
        });
        day += Duration::days(1);
    }

    Ok(CashForecast {
        account_id: account.id,
        account_name: account.name,
        starting_balance_cents: starting,
        low_balance_cents: low,
        low_date,
        ending_balance_cents: running,
        points,
        upcoming,
        detected,
        covered_by_bills,
    })
}

#[cfg(test)]
mod tests {
    use crate::models::NewRecurrence;
    use chrono::{Duration, NaiveDate};
    use rusqlite::params;
    use super::*;
    use crate::db::queries::test_support::*;

    #[test]
    fn a_scheduled_transfer_enters_a_linked_pair_tags_the_goal_and_forecasts_both_sides() {
        let db = TestDb::new("sched-xfer");
        let c = db.conn();
        let chk = account(&c, "Checking", 500_000);
        let sav = account(&c, "Savings", 100_000);
        let goal = create_goal(&c, "Roof", 1_000_000, 0, None, None, Some(&sav)).unwrap();
        let rule = |to: Option<&str>, goal: Option<&str>, amount: i64| NewRecurrence {
            payee: "Monthly savings".into(), amount_cents: amount, account_id: Some(chk.clone()), category_id: None,
            freq: "monthly".into(), interval_n: 1, start_date: "2026-09-15".into(), end_date: None, second_day: None,
            weekend_rule: "none".into(), notes: None, transfer_account_id: to.map(str::to_string), goal_id: goal.map(str::to_string),
        };
        // Refusals: same account, money in, a goal on a plain bill, a goal on the wrong account.
        assert!(create_recurrence(&c, &rule(Some(&chk), None, -20_000)).is_err());
        assert!(create_recurrence(&c, &rule(Some(&sav), None, 20_000)).is_err());
        assert!(create_recurrence(&c, &rule(None, Some(&goal.id), -20_000)).is_err());
        let other = create_goal(&c, "Car", 1_000_000, 0, None, None, Some(&chk)).unwrap();
        assert!(create_recurrence(&c, &rule(Some(&sav), Some(&other.id), -20_000)).is_err());

        let r = create_recurrence(&c, &rule(Some(&sav), Some(&goal.id), -20_000)).unwrap();
        assert_eq!((r.transfer_account_name.as_deref(), r.goal_name.as_deref()), (Some("Savings"), Some("Roof")));

        let today = NaiveDate::from_ymd_opt(2026, 9, 6).unwrap();
        // Both accounts see it coming: checking down, savings up.
        let f_chk = cash_forecast(&c, &chk, today, 30).unwrap();
        let f_sav = cash_forecast(&c, &sav, today, 30).unwrap();
        assert_eq!(f_chk.ending_balance_cents, 480_000);
        assert_eq!(f_sav.ending_balance_cents, 120_000);

        // Enter it: a linked pair under the rule's name, the receiving half tagged.
        let t = enter_occurrence(&c, &r.id, "2026-09-15", "2026-09-15", None, None).unwrap();
        assert_eq!((t.account_id.as_str(), t.amount_cents), (chk.as_str(), -20_000));
        assert_eq!(balance(&c, &chk), 480_000);
        assert_eq!(balance(&c, &sav), 120_000);
        let reg = get_register(&c, &sav).unwrap();
        let half = reg.iter().find(|x| x.payee == "Monthly savings").unwrap();
        assert_eq!((half.amount_cents, half.transfer_account_name.as_deref(), half.goal_name.as_deref()), (20_000, Some("Checking"), Some("Roof")));
        assert_eq!(get_goal(&c, &goal.id).unwrap().saved_cents, 20_000);
        let occ = occurrences_between(&c, today, today + Duration::days(30), today).unwrap();
        let o = occ.iter().find(|o| o.recurrence_id == r.id).unwrap();
        assert_eq!((o.status.as_str(), o.transfer_account_name.as_deref()), ("paid", Some("Savings")));

        // October's is matched by a transfer typed by hand ("Transfer Money") to the same account.
        create_transfer(&c, &chk, &sav, "2026-10-14", 20_000, None).unwrap();
        let occ = occurrences_between(&c, today, today + Duration::days(60), today).unwrap();
        let oct = occ.iter().find(|o| o.recurrence_id == r.id && o.due_date == "2026-10-15").unwrap();
        assert_eq!(oct.status, "matched");
        // …but not by a transfer to some other account.
        let cash = account(&c, "Cash", 0);
        create_transfer(&c, &chk, &cash, "2026-11-14", 20_000, None).unwrap();
        let occ = occurrences_between(&c, today, today + Duration::days(90), today).unwrap();
        let nov = occ.iter().find(|o| o.recurrence_id == r.id && o.due_date == "2026-11-15").unwrap();
        assert_eq!(nov.status, "due");
    }

    // ── scheduled bills: matching and the forecast (§32) ─────────────────

    #[test]
    fn an_upcoming_bill_is_due_until_something_happens_to_it() {
        let db = TestDb::new("rec-due");
        let c = db.conn();
        let acct = account(&c, "Checking", 500_000);
        create_recurrence(&c, &bill(&acct, "Anytown Properties", -145_000, "2026-09-01"))
            .expect("create");

        let got = occurrences_between(&c, nd("2026-09-01"), nd("2026-11-30"), nd("2026-09-15"))
            .expect("occurrences");
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].status, "overdue", "1 Sep is before today");
        assert_eq!(got[1].status, "due");
        assert_eq!(got[1].due_date, "2026-10-01");
    }

    #[test]
    fn a_bill_paid_by_hand_stops_nagging() {
        // The case the user asked about: they paid the rent from the register
        // without touching the bill. It must not keep showing as due, and the
        // forecast must not project it on top of the real transaction.
        let db = TestDb::new("rec-match");
        let c = db.conn();
        let acct = account(&c, "Checking", 500_000);
        create_recurrence(&c, &bill(&acct, "Anytown Properties", -145_000, "2026-09-01"))
            .expect("create");

        let txn = create_transaction(
            &c, &acct, "2026-09-02", "Anytown Properties", None, -145_000, None, None,
        )
        .expect("paid by hand");

        let got = occurrences_between(&c, nd("2026-09-01"), nd("2026-09-30"), nd("2026-09-15"))
            .expect("occurrences");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].status, "matched");
        assert_eq!(got[0].transaction_id.as_deref(), Some(txn.id.as_str()));
        assert_eq!(got[0].actual_amount_cents, Some(-145_000));
    }

    #[test]
    fn matching_ignores_the_amount_because_bills_vary() {
        // A utility bill is never the same twice. Requiring an exact figure
        // would fail for exactly the bills that need matching most.
        let db = TestDb::new("rec-match-amount");
        let c = db.conn();
        let acct = account(&c, "Checking", 500_000);
        create_recurrence(&c, &bill(&acct, "City Utilities", -8_400, "2026-09-12"))
            .expect("create");
        create_transaction(&c, &acct, "2026-09-12", "City Utilities", None, -11_930, None, None)
            .expect("actual");

        let got = occurrences_between(&c, nd("2026-09-01"), nd("2026-09-30"), nd("2026-09-20"))
            .expect("occurrences");
        assert_eq!(got[0].status, "matched");
        assert_eq!(got[0].actual_amount_cents, Some(-11_930), "the real amount is reported");
    }

    #[test]
    fn a_transaction_outside_the_window_does_not_match() {
        let db = TestDb::new("rec-match-far");
        let c = db.conn();
        let acct = account(&c, "Checking", 500_000);
        create_recurrence(&c, &bill(&acct, "Anytown Properties", -145_000, "2026-09-01"))
            .expect("create");
        // Three weeks late is not this occurrence.
        create_transaction(
            &c, &acct, "2026-09-22", "Anytown Properties", None, -145_000, None, None,
        )
        .expect("txn");

        let got = occurrences_between(&c, nd("2026-09-01"), nd("2026-09-30"), nd("2026-09-25"))
            .expect("occurrences");
        assert_eq!(got[0].status, "overdue");
    }

    #[test]
    fn one_payment_cannot_satisfy_two_months() {
        // Otherwise a single rent payment silently clears the whole quarter.
        let db = TestDb::new("rec-match-once");
        let c = db.conn();
        let acct = account(&c, "Checking", 500_000);
        create_recurrence(&c, &bill(&acct, "Anytown Properties", -145_000, "2026-09-01"))
            .expect("create");
        create_transaction(
            &c, &acct, "2026-09-01", "Anytown Properties", None, -145_000, None, None,
        )
        .expect("txn");

        let got = occurrences_between(&c, nd("2026-09-01"), nd("2026-11-30"), nd("2026-09-01"))
            .expect("occurrences");
        assert_eq!(got[0].status, "matched");
        assert_eq!(got[1].status, "due", "October was cleared by September's payment");
        assert_eq!(got[2].status, "due");
    }

    #[test]
    fn a_voided_transaction_does_not_match() {
        let db = TestDb::new("rec-match-void");
        let c = db.conn();
        let acct = account(&c, "Checking", 500_000);
        create_recurrence(&c, &bill(&acct, "Anytown Properties", -145_000, "2026-09-01"))
            .expect("create");
        let txn = create_transaction(
            &c, &acct, "2026-09-01", "Anytown Properties", None, -145_000, None, None,
        )
        .expect("txn");
        set_void(&c, &txn.id, true).expect("void");

        let got = occurrences_between(&c, nd("2026-09-01"), nd("2026-09-30"), nd("2026-09-15"))
            .expect("occurrences");
        assert_eq!(got[0].status, "overdue", "a voided payment cleared the bill");
    }

    #[test]
    fn a_payment_from_another_account_does_not_match() {
        let db = TestDb::new("rec-match-acct");
        let c = db.conn();
        let checking = account(&c, "Checking", 500_000);
        let savings = account(&c, "Savings", 500_000);
        create_recurrence(&c, &bill(&checking, "Anytown Properties", -145_000, "2026-09-01"))
            .expect("create");
        create_transaction(
            &c, &savings, "2026-09-01", "Anytown Properties", None, -145_000, None, None,
        )
        .expect("txn");

        let got = occurrences_between(&c, nd("2026-09-01"), nd("2026-09-30"), nd("2026-09-15"))
            .expect("occurrences");
        assert_eq!(got[0].status, "overdue");
    }

    #[test]
    fn an_explicit_decision_beats_a_match() {
        // Skipping must stick even if something in the register looks like it.
        let db = TestDb::new("rec-explicit");
        let c = db.conn();
        let acct = account(&c, "Checking", 500_000);
        let r = create_recurrence(&c, &bill(&acct, "Anytown Properties", -145_000, "2026-09-01"))
            .expect("create");
        create_transaction(
            &c, &acct, "2026-09-01", "Anytown Properties", None, -145_000, None, None,
        )
        .expect("txn");

        skip_occurrence(&c, &r.id, "2026-09-01").expect("skip");
        let got = occurrences_between(&c, nd("2026-09-01"), nd("2026-09-30"), nd("2026-09-15"))
            .expect("occurrences");
        assert_eq!(got[0].status, "skipped");

        clear_occurrence(&c, &r.id, "2026-09-01").expect("undo");
        let got = occurrences_between(&c, nd("2026-09-01"), nd("2026-09-30"), nd("2026-09-15"))
            .expect("occurrences");
        assert_eq!(got[0].status, "matched", "undoing should fall back to the match");
    }

    #[test]
    fn entering_an_occurrence_writes_a_real_transaction_and_marks_it_paid() {
        let db = TestDb::new("rec-enter");
        let c = db.conn();
        let acct = account(&c, "Checking", 500_000);
        let r = create_recurrence(&c, &bill(&acct, "Anytown Properties", -145_000, "2026-09-01"))
            .expect("create");

        let txn = enter_occurrence(&c, &r.id, "2026-09-01", "2026-09-01", None, None)
            .expect("enter");

        assert_eq!(balance(&c, &acct), 355_000);
        let got = occurrences_between(&c, nd("2026-09-01"), nd("2026-09-30"), nd("2026-09-15"))
            .expect("occurrences");
        assert_eq!(got[0].status, "paid");
        assert_eq!(got[0].transaction_id.as_deref(), Some(txn.id.as_str()));
    }

    #[test]
    fn entering_a_variable_bill_can_override_the_amount() {
        let db = TestDb::new("rec-enter-amount");
        let c = db.conn();
        let acct = account(&c, "Checking", 500_000);
        let r = create_recurrence(&c, &bill(&acct, "City Utilities", -8_400, "2026-09-12"))
            .expect("create");

        enter_occurrence(&c, &r.id, "2026-09-12", "2026-09-12", Some(-11_930), None)
            .expect("enter");
        assert_eq!(balance(&c, &acct), 488_070);
    }

    // ── the forecast ─────────────────────────────────────────────────────

    #[test]
    fn the_forecast_projects_scheduled_items_forward() {
        let db = TestDb::new("fc-basic");
        let c = db.conn();
        let acct = account(&c, "Checking", 500_000);
        create_recurrence(&c, &bill(&acct, "Anytown Properties", -145_000, "2026-09-01"))
            .expect("rent");
        let mut pay = bill(&acct, "Employer Payroll", 312_500, "2026-09-15");
        pay.payee = "Employer Payroll".to_string();
        create_recurrence(&c, &pay).expect("pay");

        let f = cash_forecast(&c, &acct, nd("2026-09-05"), 90).expect("forecast");
        assert_eq!(f.starting_balance_cents, 500_000);

        // 90 days from 5 Sep reaches 4 Dec, so three of each — assert the
        // dates rather than a total, because a total hides an off-by-one at
        // the window edge, which is exactly what this got wrong first time.
        // The 1 Sep rent is OVERDUE on the 5th and still unpaid, so it is in
        // the projection too: money that has not left yet is going to.
        let due: Vec<&str> = f.upcoming.iter().map(|o| o.due_date.as_str()).collect();
        assert_eq!(
            due,
            [
                "2026-09-01", "2026-09-15", "2026-10-01", "2026-10-15",
                "2026-11-01", "2026-11-15", "2026-12-01"
            ]
        );
        assert_eq!(f.ending_balance_cents, 500_000 + 3 * 312_500 - 4 * 145_000);
    }

    #[test]
    fn the_forecast_reports_the_low_point_and_when_it_happens() {
        // The number a cash-flow forecast exists for.
        let db = TestDb::new("fc-low");
        let c = db.conn();
        let acct = account(&c, "Checking", 200_000);
        create_recurrence(&c, &bill(&acct, "Anytown Properties", -145_000, "2026-09-10"))
            .expect("rent");
        let mut pay = bill(&acct, "Employer Payroll", 312_500, "2026-09-20");
        pay.payee = "Employer Payroll".to_string();
        create_recurrence(&c, &pay).expect("pay");

        let f = cash_forecast(&c, &acct, nd("2026-09-05"), 20).expect("forecast");
        assert_eq!(f.low_balance_cents, 55_000);
        assert_eq!(f.low_date, "2026-09-10");
    }

    #[test]
    fn a_future_dated_transaction_is_counted_once_not_twice() {
        // `accounts.balance_cents` includes future-dated rows, so a forecast
        // that projected from it AND re-applied them would double-count. This
        // is the assertion that pins the correction.
        let db = TestDb::new("fc-future");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        create_transaction(&c, &acct, "2026-09-20", "Check I posted", None, -25_000, None, None)
            .expect("future txn");
        assert_eq!(balance(&c, &acct), 75_000, "the stored balance includes it");

        let f = cash_forecast(&c, &acct, nd("2026-09-05"), 30).expect("forecast");
        assert_eq!(f.starting_balance_cents, 100_000, "today's balance excludes it");
        assert_eq!(f.ending_balance_cents, 75_000, "and it lands once, on its date");
    }

    #[test]
    fn a_paid_or_matched_occurrence_is_not_projected_again() {
        let db = TestDb::new("fc-paid");
        let c = db.conn();
        let acct = account(&c, "Checking", 500_000);
        let r = create_recurrence(&c, &bill(&acct, "Anytown Properties", -145_000, "2026-09-10"))
            .expect("rent");
        enter_occurrence(&c, &r.id, "2026-09-10", "2026-09-10", None, None).expect("enter");

        let f = cash_forecast(&c, &acct, nd("2026-09-05"), 20).expect("forecast");
        // The money moved once: the real transaction, not the projection too.
        assert_eq!(f.ending_balance_cents, 355_000);
        assert!(f.upcoming.iter().all(|o| o.due_date != "2026-09-10"));
    }

    #[test]
    fn a_skipped_occurrence_is_not_projected() {
        let db = TestDb::new("fc-skip");
        let c = db.conn();
        let acct = account(&c, "Checking", 500_000);
        let r = create_recurrence(&c, &bill(&acct, "Anytown Properties", -145_000, "2026-09-10"))
            .expect("rent");
        skip_occurrence(&c, &r.id, "2026-09-10").expect("skip");

        let f = cash_forecast(&c, &acct, nd("2026-09-05"), 20).expect("forecast");
        assert_eq!(f.ending_balance_cents, 500_000);
    }

    #[test]
    fn an_inactive_rule_is_not_projected() {
        let db = TestDb::new("fc-inactive");
        let c = db.conn();
        let acct = account(&c, "Checking", 500_000);
        let r = create_recurrence(&c, &bill(&acct, "Gym", -4_000, "2026-09-10")).expect("gym");
        set_recurrence_active(&c, &r.id, false).expect("deactivate");

        let f = cash_forecast(&c, &acct, nd("2026-09-05"), 30).expect("forecast");
        assert_eq!(f.ending_balance_cents, 500_000);
    }

    #[test]
    fn another_accounts_bills_do_not_appear_in_this_forecast() {
        let db = TestDb::new("fc-scope");
        let c = db.conn();
        let checking = account(&c, "Checking", 500_000);
        let visa = account(&c, "Visa", 0);
        create_recurrence(&c, &bill(&visa, "Card Payment", -30_000, "2026-09-10")).expect("card");

        let f = cash_forecast(&c, &checking, nd("2026-09-05"), 30).expect("forecast");
        assert_eq!(f.ending_balance_cents, 500_000);
        assert!(f.upcoming.is_empty());
    }

    #[test]
    fn the_forecast_covers_exactly_the_days_asked_for() {
        let db = TestDb::new("fc-window");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let f = cash_forecast(&c, &acct, nd("2026-09-05"), 90).expect("forecast");
        assert_eq!(f.points.len(), 91, "inclusive of both ends");
        assert_eq!(f.points[0].date, "2026-09-05");
        assert_eq!(f.points[90].date, "2026-12-04");
    }

    #[test]
    fn a_rule_with_a_bad_frequency_is_refused_with_a_sentence() {
        let db = TestDb::new("rec-validate");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let mut r = bill(&acct, "Gym", -4_000, "2026-09-10");
        r.freq = "fortnightly".to_string();
        let err = create_recurrence(&c, &r).unwrap_err();
        assert!(err.contains("frequency"), "{err}");

        let mut r = bill(&acct, "Gym", -4_000, "2026-09-10");
        r.end_date = Some("2026-01-01".to_string());
        assert!(create_recurrence(&c, &r).unwrap_err().contains("end date"));

        let mut r = bill(&acct, "", -4_000, "2026-09-10");
        r.payee = "  ".to_string();
        assert!(create_recurrence(&c, &r).is_err());
    }

    // -----------------------------------------------------------------------
    // §38 — what the review found
    // -----------------------------------------------------------------------

    #[test]
    fn deleting_an_entered_bill_puts_the_bill_back() {
        // The FK was ON DELETE SET NULL, which left a "paid" mark pointing at
        // nothing: the bill vanished from Upcoming although the money never
        // moved.
        let db = TestDb::new("unpay");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let rule = create_recurrence(&c, &bill(&acct, "City Utilities", -11_930, "2026-09-12"))
            .expect("rule");
        let txn = enter_occurrence(&c, &rule.id, "2026-09-12", "2026-09-12", None, None)
            .expect("enter");
        let paid = occurrences_between(&c, nd("2026-08-06"), nd("2026-10-05"), nd("2026-09-05"))
            .expect("upcoming");
        assert!(paid.iter().all(|o| o.due_date != "2026-09-12" || o.status == "paid"));

        delete_transaction(&c, &txn.id).expect("delete");
        assert_eq!(balance(&c, &acct), 100_000);
        let again = occurrences_between(&c, nd("2026-08-06"), nd("2026-10-05"), nd("2026-09-05"))
            .expect("upcoming");
        let o = again.iter().find(|o| o.due_date == "2026-09-12").expect("the bill is back");
        assert_eq!(o.status, "due", "{o:?}");
    }

    #[test]
    fn the_forecast_does_not_panic_on_an_absurd_horizon() {
        let db = TestDb::new("fc-horizon");
        let c = db.conn();
        let acct = account(&c, "Checking", 0);
        let f = cash_forecast(&c, &acct, nd("2026-09-05"), i64::MAX).expect("forecast");
        assert!(f.points.len() <= 3_661);
    }

    // §173 — the forecast also projects the recurring charges the detector
    // has noticed, and never twice, and never one the user ignored.
    #[test]
    fn the_forecast_projects_detected_charges_but_not_scheduled_or_ignored_ones() {
        let db = TestDb::new("fc-detected");
        let c = db.conn();
        let acct = account(&c, "Checking", 500_000);
        // Netflix, monthly, steady; Spotify too; groceries are not a subscription.
        for d in ["2026-05-03", "2026-06-03", "2026-07-03", "2026-08-03"] {
            create_transaction(&c, &acct, d, "Netflix", None, -1_599, None, None).unwrap();
            create_transaction(&c, &acct, d, "Spotify", None, -1_099, None, None).unwrap();
        }
        for (d, amt) in [("2026-05-10", -4_210), ("2026-05-24", -9_115), ("2026-06-02", -6_500), ("2026-06-30", -2_000), ("2026-07-19", -12_040)] {
            create_transaction(&c, &acct, d, "Kroger", None, amt, None, None).unwrap();
        }
        let from = nd("2026-08-20");
        let scheduled_only = cash_forecast(&c, &acct, from, 90).unwrap();
        assert!(scheduled_only.detected.is_empty());
        assert_eq!(scheduled_only.ending_balance_cents, 500_000 - 4 * 1_599 - 4 * 1_099 - 33_865, "nothing scheduled: the balance stands");

        let f = cash_forecast_with(&c, &acct, from, 90, true).unwrap();
        let names: Vec<&str> = f.detected.iter().map(|d| d.payee.as_str()).collect();
        assert_eq!(names, vec!["Netflix", "Spotify"], "the two subscriptions and not the grocery store: {names:?}");
        let netflix = f.detected.iter().find(|d| d.payee == "Netflix").unwrap();
        assert_eq!((netflix.amount_cents, netflix.cadence.as_str(), netflix.charges), (-1_599, "month", 4));
        // 3 Sep, 3 Oct, 3 Nov fall inside 20 Aug + 90 days (18 Nov).
        assert_eq!(netflix.dates, vec!["2026-09-03", "2026-10-03", "2026-11-03"]);
        assert_eq!(f.ending_balance_cents, scheduled_only.ending_balance_cents - 3 * 1_599 - 3 * 1_099);
        let sep3 = f.points.iter().find(|p| p.date == "2026-09-03").unwrap();
        assert_eq!(sep3.delta_cents, -1_599 - 1_099);

        // A payee with a scheduled rule in this account is the rule's to
        // project, not the detector's.
        create_recurrence(&c, &bill(&acct, "Netflix", -1_599, "2026-09-03")).unwrap();
        let f = cash_forecast_with(&c, &acct, from, 90, true).unwrap();
        assert_eq!(f.detected.iter().map(|d| d.payee.as_str()).collect::<Vec<_>>(), vec!["Spotify"]);
        assert_eq!(f.covered_by_bills, vec!["Netflix"], "§173.2 — named, so it does not look missed");
        let sep3 = f.points.iter().find(|p| p.date == "2026-09-03").unwrap();
        assert_eq!(sep3.delta_cents, -1_599 - 1_099, "Netflix once, from the rule");

        // §173.3 — one on the Home card's ignore list is still projected
        // (money still leaves), and says so.
        set_setting(&c, "ui.subscriptions.ignored", "[\"Spotify\"]").unwrap();
        let f = cash_forecast_with(&c, &acct, from, 90, true).unwrap();
        assert_eq!(f.detected.iter().map(|d| (d.payee.as_str(), d.ignored_on_home)).collect::<Vec<_>>(), vec![("Spotify", true)]);
        assert_eq!(f.ending_balance_cents, scheduled_only.ending_balance_cents - 3 * 1_599 - 3 * 1_099, "Netflix from its rule, Spotify projected all the same");

        // A charge expected before the window and not seen lands on day one.
        set_setting(&c, "ui.subscriptions.ignored", "[]").unwrap();
        let late = cash_forecast_with(&c, &acct, nd("2026-09-10"), 30, true).unwrap();
        let spotify = late.detected.iter().find(|d| d.payee == "Spotify").unwrap();
        assert_eq!(spotify.dates, vec!["2026-09-10", "2026-10-03"]);
    }

    // ── §179 ─────────────────────────────────────────────────────────────

    /// §179 — the occurrence points at the sending half; deleting the
    /// receiving half left it paid.
    #[test]
    fn deleting_the_receiving_half_of_a_scheduled_transfer_puts_the_occurrence_back() {
        let db = TestDb::new("unpay-transfer");
        let c = db.conn();
        let chk = account(&c, "Checking", 500_000);
        let sav = account(&c, "Savings", 100_000);
        let rule = create_recurrence(&c, &NewRecurrence { transfer_account_id: Some(sav.clone()), ..bill(&chk, "Monthly savings", -20_000, "2026-09-15") }).unwrap();
        let status = |c: &Conn| {
            occurrences_between(c, nd("2026-09-01"), nd("2026-10-01"), nd("2026-09-10"))
                .unwrap()
                .into_iter()
                .find(|o| o.recurrence_id == rule.id && o.due_date == "2026-09-15")
                .map(|o| o.status)
        };
        for which in ["receiving", "sending"] {
            let sent = enter_occurrence(&c, &rule.id, "2026-09-15", "2026-09-15", None, None).unwrap();
            assert_eq!(status(&c).as_deref(), Some("paid"));
            let received: String = c.query_row("SELECT transfer_id FROM transactions WHERE id = ?1", params![sent.id], |r| r.get(0)).unwrap();
            let target = if which == "receiving" { received } else { sent.id };
            delete_transaction(&c, &target).unwrap();
            assert_eq!(status(&c).as_deref(), Some("due"), "deleting the {which} half left the transfer paid");
            assert_eq!((balance(&c, &chk), balance(&c, &sav)), (500_000, 100_000));
        }
    }

    /// §181 — a scheduled transfer: none new to a closed account, an old one
    /// still edits, and entering one that now points at a closed account
    /// stops with the sentence rather than writing the pair.
    #[test]
    fn a_scheduled_transfer_to_a_closed_account_is_not_made_or_entered() {
        let db = TestDb::new("closed-schedule");
        let c = db.conn();
        let chk = account(&c, "Checking", 500_000);
        let old = account(&c, "Old Savings", 0);
        let rule = create_recurrence(&c, &NewRecurrence { transfer_account_id: Some(old.clone()), ..bill(&chk, "Monthly savings", -20_000, "2026-09-15") }).unwrap();
        close(&c, &old);

        let err = create_recurrence(&c, &NewRecurrence { transfer_account_id: Some(old.clone()), ..bill(&chk, "Another", -1_000, "2026-09-15") }).unwrap_err();
        assert!(err.contains("Old Savings is closed"), "{err}");
        // The existing rule keeps its account through an edit.
        update_recurrence(&c, &rule.id, &NewRecurrence { transfer_account_id: Some(old.clone()), ..bill(&chk, "Monthly savings", -25_000, "2026-09-15") }).unwrap();
        // An open rule re-pointed at it is a new link.
        let sav = account(&c, "Savings", 0);
        let other = create_recurrence(&c, &NewRecurrence { transfer_account_id: Some(sav.clone()), ..bill(&chk, "Other", -1_000, "2026-09-15") }).unwrap();
        let err = update_recurrence(&c, &other.id, &NewRecurrence { transfer_account_id: Some(old.clone()), ..bill(&chk, "Other", -1_000, "2026-09-15") }).unwrap_err();
        assert!(err.contains("Old Savings is closed"), "{err}");

        let err = enter_occurrence(&c, &rule.id, "2026-09-15", "2026-09-15", None, None).unwrap_err();
        assert!(err.contains("Old Savings is closed"), "{err}");
        assert_eq!((balance(&c, &chk), balance(&c, &old)), (500_000, 0));
    }
}
