// Lots: the part of the app that makes cost basis and capital gains true
// rather than typed.
//
// Nothing here is stored. A holding is the result of replaying an account's
// investment rows in date order: buys, reinvestments and Add Shares open
// lots; sells and Remove Shares close them — oldest first, unless the user
// said which lots (`lot_allocations`); a split multiplies every open lot; a
// return of capital lowers every open lot's basis pro rata. Because it is a
// replay, editing or deleting any row simply changes the answer, and there
// is no second copy of the truth to drift.
//
// All arithmetic is integer. Shares and prices are i64 millionths, money is
// i64 cents, and the proportional splits (this lot's share of the proceeds,
// this sale's share of a lot's cost) go through i128 with half-away-from-zero
// rounding and the REMAINDER ON THE LAST PORTION, so the pieces always add
// back up to the whole. No f64 anywhere.
use std::collections::{BTreeMap, HashMap};

use chrono::{Months, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};

use crate::models::{Disposal, Lot, Performance, Portfolio, Position, RoiPeriod};

pub const MICRO: i64 = 1_000_000;

/// Activities that open a lot.
pub const OPENS_LOT: &[&str] = &["buy", "reinvest_dividend", "reinvest_interest", "reinvest_ltcg", "reinvest_stcg", "add_shares"];
/// Activities that close (part of) one or more lots.
pub const CLOSES_LOT: &[&str] = &["sell", "remove_shares"];
/// Activities that are income: they carry a category and count in category,
/// payee and tax reports. The reinvested forms count for `gross_cents`.
pub const INCOME: &[&str] = &["dividend", "interest", "ltcg_dist", "stcg_dist", "reinvest_dividend", "reinvest_interest", "reinvest_ltcg", "reinvest_stcg"];
pub const ALL_ACTIVITIES: &[&str] = &[
    "buy", "sell", "dividend", "interest", "ltcg_dist", "stcg_dist",
    "reinvest_dividend", "reinvest_interest", "reinvest_ltcg", "reinvest_stcg",
    "add_shares", "remove_shares", "return_of_capital", "split",
];

pub fn activity_label(a: &str) -> &'static str {
    match a {
        "buy" => "Buy",
        "sell" => "Sell",
        "dividend" => "Dividend",
        "interest" => "Interest",
        "ltcg_dist" => "L-T Cap Gains Dist",
        "stcg_dist" => "S-T Cap Gains Dist",
        "reinvest_dividend" => "Reinvest Dividend",
        "reinvest_interest" => "Reinvest Interest",
        "reinvest_ltcg" => "Reinvest L-T CG Dist",
        "reinvest_stcg" => "Reinvest S-T CG Dist",
        "add_shares" => "Add Shares",
        "remove_shares" => "Remove Shares",
        "return_of_capital" => "Return of Capital",
        "split" => "Split",
        _ => "Investment",
    }
}

/// `a * b / c`, rounded half away from zero, without overflow for any i64 inputs.
pub fn mul_div(a: i64, b: i64, c: i64) -> i64 {
    if c == 0 {
        return 0;
    }
    let n = a as i128 * b as i128;
    let d = c as i128;
    let q = n / d;
    let r = n % d;
    let adj = if (r.abs() * 2) >= d.abs() { if (n < 0) != (d < 0) { -1 } else { 1 } } else { 0 };
    (q + adj) as i64
}

/// shares (micro) x price (micro dollars) → cents.
pub fn value_cents(shares_micro: i64, price_micro: i64) -> i64 {
    // shares/1e6 * price/1e6 dollars = shares*price/1e12 dollars = shares*price/1e10 cents
    mul_div(shares_micro, price_micro, 10_000_000_000)
}

/// How a holding's value is rounded to the cent. Brokers differ:
/// some truncate (20.125 sh × $10.07 = 202.65875 → 202.65); the app
/// rounded half away and printed 202.66. The file says which it wants;
/// nothing else in the arithmetic changes. Cost basis, proceeds and cash
/// are never rounded this way — they are sums of cents that were paid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rounding {
    Nearest,
    Down,
}

/// The per-file setting (Settings → Holding values); written through
/// `set_ui_setting("holding_rounding", "nearest" | "down")`.
pub const ROUNDING_KEY: &str = "ui.holding_rounding";

pub fn rounding(conn: &Connection) -> Result<Rounding, String> {
    let v: Option<String> = conn
        .query_row("SELECT value FROM app_settings WHERE key = ?1", params![ROUNDING_KEY], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match v.as_deref() {
        Some("down") => Rounding::Down,
        _ => Rounding::Nearest,
    })
}

/// The account's own choice when it has one, else the file's.
pub fn rounding_for_account(conn: &Connection, account_id: &str, file_default: Rounding) -> Result<Rounding, String> {
    let v: Option<String> = conn
        .query_row("SELECT value_rounding FROM accounts WHERE id = ?1", params![account_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    Ok(match v.as_deref() {
        Some("down") => Rounding::Down,
        Some("nearest") => Rounding::Nearest,
        _ => file_default,
    })
}

impl Rounding {
    pub fn as_str(self) -> &'static str {
        match self {
            Rounding::Nearest => "nearest",
            Rounding::Down => "down",
        }
    }
}

/// shares(micro) × price(micro) → cents, rounded the way the file asks.
pub fn value_cents_rounded(shares_micro: i64, price_micro: i64, r: Rounding) -> i64 {
    match r {
        Rounding::Nearest => value_cents(shares_micro, price_micro),
        // Toward zero for a positive holding is "down"; a negative one
        // cannot occur (a sale of more than held is clamped).
        Rounding::Down => ((shares_micro as i128 * price_micro as i128) / 10_000_000_000i128) as i64,
    }
}

/// cents / shares(micro) → price in micro dollars.
pub fn price_from(gross_cents: i64, shares_micro: i64) -> Option<i64> {
    if shares_micro <= 0 {
        return None;
    }
    // cents*1e4 micro-dollars per cent ... price = gross/100 / (shares/1e6) dollars = gross*1e4/shares dollars → micro: *1e6
    Some(mul_div(gross_cents, 10_000_000_000, shares_micro))
}

struct InvRow {
    id: String,
    account_id: String,
    security_id: String,
    date: String,
    activity: String,
    shares_micro: i64,
    gross_cents: i64,
    commission_cents: i64,
    /// A share transfer's other half.
    transfer_id: Option<String>,
}

/// What was held at the close of one day, taken during a replay
/// so that an account (or one fund) can be valued on many days in ONE pass.
/// Valuing the Investing tab's five periods took a full replay per flow
/// day — a plan with a payroll contribution every two weeks for four years
/// is several hundred of them — and the tab went from instant to slow.
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    pub date: String,
    /// (account, security, shares held, cost of those shares) — open
    /// positions only, after the account and security filters.
    pub positions: Vec<(String, String, i64, i64)>,
}

/// Everything the replay produced up to the as-of date.
#[derive(Debug, Default)]
pub struct Ledger {
    /// Open lots, in acquisition order within each (account, security).
    pub lots: Vec<Lot>,
    pub disposals: Vec<Disposal>,
    /// Rows that could not be honored as written. Never hidden.
    pub problems: Vec<String>,
    /// One per checkpoint date asked of `replay_at`, in date order.
    pub snapshots: Vec<Snapshot>,
}

fn snapshot_of(open: &BTreeMap<(String, String), Vec<Lot>>, account_id: Option<&str>, security_id: Option<&str>, date: &str) -> Snapshot {
    let mut positions = Vec::new();
    for ((acct, sec), lots) in open {
        if account_id.map_or(false, |a| a != acct) || security_id.map_or(false, |s| s != sec) {
            continue;
        }
        let shares: i64 = lots.iter().map(|l| l.shares_micro).sum();
        if shares <= 0 {
            continue;
        }
        positions.push((acct.clone(), sec.clone(), shares, lots.iter().map(|l| l.cost_cents).sum()));
    }
    Snapshot { date: date.to_string(), positions }
}

fn is_long_term(acquired: &str, sold: &str) -> bool {
    match (NaiveDate::parse_from_str(acquired, "%Y-%m-%d"), NaiveDate::parse_from_str(sold, "%Y-%m-%d")) {
        (Ok(a), Ok(s)) => match a.checked_add_months(Months::new(12)) {
            Some(anniv) => s > anniv,
            None => false,
        },
        _ => false,
    }
}

/// Replay the investment rows, optionally narrowed to one account and/or one
/// security, and only through `asof` (inclusive).
pub fn replay(
    conn: &Connection,
    account_id: Option<&str>,
    security_id: Option<&str>,
    asof: Option<&str>,
) -> Result<Ledger, String> {
    replay_at(conn, account_id, security_id, asof, &[])
}

/// `replay`, also taking a `Snapshot` of the open positions at the close of
/// each `checkpoints` date. A checkpoint is taken before the first
/// row dated after it, once that day's exchanges have been settled.
pub fn replay_at(
    conn: &Connection,
    account_id: Option<&str>,
    security_id: Option<&str>,
    asof: Option<&str>,
    checkpoints: &[String],
) -> Result<Ledger, String> {
    let mut cps: Vec<&str> = checkpoints.iter().map(|s| s.as_str()).collect();
    cps.sort_unstable();
    cps.dedup();
    let mut ci = 0usize;
    let mut sql = String::from(
        "SELECT t.id, t.account_id, t.security_id, t.date, t.activity,
                COALESCE(t.shares_micro, 0), COALESCE(t.gross_cents, 0), t.commission_cents, t.transfer_id
           FROM transactions t
          WHERE t.is_void = 0 AND t.activity IS NOT NULL AND t.security_id IS NOT NULL",
    );
    // The account filter is applied to the OUTPUT, not the query: a share
    // transfer carries lots from one account into another, and the
    // receiving account's replay needs the sending account's rows.
    // The security filter is applied to the OUTPUT too: an exchange
    // within an account moves lots from one security into another, so the
    // receiving fund's replay needs the sending fund's rows.
    let mut args: Vec<String> = Vec::new();
    if let Some(d) = asof {
        args.push(d.to_string());
        sql.push_str(&format!(" AND t.date <= ?{}", args.len()));
    }
    sql.push_str(" ORDER BY t.date ASC, t.rowid ASC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<InvRow> = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), |r| {
            Ok(InvRow {
                id: r.get(0)?,
                account_id: r.get(1)?,
                security_id: r.get(2)?,
                date: r.get(3)?,
                activity: r.get(4)?,
                shares_micro: r.get(5)?,
                gross_cents: r.get(6)?,
                commission_cents: r.get(7)?,
                transfer_id: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut allocs: HashMap<String, Vec<(String, i64)>> = HashMap::new();
    {
        let mut st = conn
            .prepare("SELECT sell_id, lot_id, shares_micro FROM lot_allocations")
            .map_err(|e| e.to_string())?;
        let it = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
            .map_err(|e| e.to_string())?;
        for row in it {
            let (s, l, n) = row.map_err(|e| e.to_string())?;
            allocs.entry(s).or_default().push((l, n));
        }
    }

    let names = security_names(conn)?;
    let mut open: BTreeMap<(String, String), Vec<Lot>> = BTreeMap::new();
    let mut out = Ledger::default();
    // Lots a Remove Shares half of a transfer closed, waiting for the Add
    // Shares half to reopen them — keyed by the removing row's id.
    let mut carried: HashMap<String, Vec<Lot>> = HashMap::new();
    // An exchange WITHIN an account: a TSP reallocation is shares of
    // one fund out and shares of another in, on one day, linked like a share
    // transfer but to a row in the SAME account. The lots that went out are
    // pooled by (account, date) and the rows that came in draw from the pool
    // once the day's out-rows have all been seen, so the basis and the dates
    // the contributions were made survive the move instead of being replaced
    // by that day's market value — which is what a Sell and a Buy did, and
    // which booked a realized gain inside a tax-deferred plan.
    let account_of: HashMap<String, String> = rows.iter().map(|r| (r.id.clone(), r.account_id.clone())).collect();
    let is_exchange = |r: &InvRow| r.transfer_id.as_ref().map_or(false, |p| account_of.get(p) == Some(&r.account_id));
    // Each pooled lot carries the VALUE it had on the way out (its share of
    // the removing row's gross), because that — not its cost — is what
    // decides how many of the new fund's shares it becomes.
    let mut pool: HashMap<(String, String), Vec<(Lot, i64)>> = HashMap::new();
    let mut pending: Vec<InvRow> = Vec::new();

    for r in rows {
        // Every checkpoint that this row is past: settle the day
        // (its exchange-ins are still pending) and photograph the positions.
        while ci < cps.len() && cps[ci] < r.date.as_str() {
            flush_exchanges(&mut open, &mut pool, &mut pending, &mut out, &names);
            out.snapshots.push(snapshot_of(&open, account_id, security_id, cps[ci]));
            ci += 1;
        }
        // A day's exchange-ins wait until the day is over: the TSP lists a
        // fund's payroll contribution AFTER the sale that emptied it,
        // so the in-rows cannot draw from the pool row by row.
        if !pending.is_empty() && pending[0].date != r.date {
            flush_exchanges(&mut open, &mut pool, &mut pending, &mut out, &names);
        }
        if r.activity == "add_shares" && is_exchange(&r) {
            pending.push(r);
            continue;
        }
        let key = (r.account_id.clone(), r.security_id.clone());
        let lots = open.entry(key).or_default();
        let sec = names.get(&r.security_id).cloned().unwrap_or_else(|| r.security_id.clone());
        match r.activity.as_str() {
            "add_shares" if r.transfer_id.is_some() => {
                // The receiving half of a share transfer: the lots arrive
                // with the dates and basis they had, not today's and zero.
                match carried.remove(r.transfer_id.as_deref().unwrap_or_default()) {
                    Some(moved) => {
                        for m in moved {
                            // The same original lot arriving twice merges.
                            if let Some(existing) = lots.iter_mut().find(|l| l.id == m.id) {
                                existing.shares_micro += m.shares_micro;
                                existing.cost_cents += m.cost_cents;
                                existing.original_shares_micro += m.shares_micro;
                                existing.original_cost_cents += m.cost_cents;
                            } else {
                                lots.push(Lot { account_id: r.account_id.clone(), ..m });
                            }
                        }
                        lots.sort_by(|x, y| x.acquired_on.cmp(&y.acquired_on));
                    }
                    None => {
                        out.problems.push(format!(
                            "Transfer Shares on {}: the shares of {} arrived before, or without, the row that sent them — taken as bought that day at the cost typed",
                            r.date, sec
                        ));
                        let cost = r.gross_cents + r.commission_cents;
                        lots.push(Lot {
                            id: r.id.clone(),
                            account_id: r.account_id.clone(),
                            security_id: r.security_id.clone(),
                            acquired_on: r.date.clone(),
                            shares_micro: r.shares_micro,
                            cost_cents: cost,
                            original_shares_micro: r.shares_micro,
                            original_cost_cents: cost,
                        });
                    }
                }
            }
            a if OPENS_LOT.contains(&a) => {
                if r.shares_micro <= 0 {
                    out.problems.push(format!("{} on {}: {} of {} adds no shares", activity_label(a), r.date, activity_label(a), sec));
                    continue;
                }
                let cost = r.gross_cents + r.commission_cents;
                lots.push(Lot {
                    id: r.id.clone(),
                    account_id: r.account_id.clone(),
                    security_id: r.security_id.clone(),
                    acquired_on: r.date.clone(),
                    shares_micro: r.shares_micro,
                    cost_cents: cost,
                    original_shares_micro: r.shares_micro,
                    original_cost_cents: cost,
                });
            }
            a if CLOSES_LOT.contains(&a) => {
                let held: i64 = lots.iter().map(|l| l.shares_micro).sum();
                let mut to_close = r.shares_micro;
                if to_close <= 0 {
                    out.problems.push(format!("{} on {}: {} of {} moves no shares", activity_label(a), r.date, activity_label(a), sec));
                    continue;
                }
                if to_close > held {
                    out.problems.push(format!(
                        "{} on {}: {} shares of {} sold but only {} were held in the account — the extra {} are ignored",
                        activity_label(a), r.date, fmt_shares(to_close), sec, fmt_shares(held), fmt_shares(to_close - held)
                    ));
                    to_close = held;
                }
                if to_close == 0 {
                    continue;
                }
                // Plan: (index into lots, shares). Specified lots first, FIFO for the rest.
                let mut plan: Vec<(usize, i64)> = Vec::new();
                let mut taken: Vec<i64> = vec![0; lots.len()];
                let mut left = to_close;
                if let Some(spec) = allocs.get(&r.id) {
                    for (lot_id, n) in spec {
                        if left == 0 {
                            break;
                        }
                        match lots.iter().position(|l| &l.id == lot_id) {
                            Some(i) => {
                                let avail = lots[i].shares_micro - taken[i];
                                let take = (*n).min(avail).min(left);
                                if take < *n {
                                    out.problems.push(format!(
                                        "{} on {}: asked for {} shares of {} from the lot bought {} but only {} were left in it",
                                        activity_label(a), r.date, fmt_shares(*n), sec, lots[i].acquired_on, fmt_shares(avail)
                                    ));
                                }
                                if take > 0 {
                                    plan.push((i, take));
                                    taken[i] += take;
                                    left -= take;
                                }
                            }
                            None => out.problems.push(format!(
                                "{} on {}: names a lot of {} that is not open in the account; that part went oldest-first",
                                activity_label(a), r.date, sec
                            )),
                        }
                    }
                }
                for i in 0..lots.len() {
                    if left == 0 {
                        break;
                    }
                    let avail = lots[i].shares_micro - taken[i];
                    if avail <= 0 {
                        continue;
                    }
                    let take = avail.min(left);
                    plan.push((i, take));
                    taken[i] += take;
                    left -= take;
                }
                // Proceeds, split by shares with the remainder on the last portion.
                let net = if a == "sell" { r.gross_cents - r.commission_cents } else { 0 };
                let mut proceeds_left = net;
                let n = plan.len();
                let is_transfer = a == "remove_shares" && r.transfer_id.is_some();
                let exchange = is_transfer && is_exchange(&r);
                // An exchange-out's gross is what the shares were WORTH on the
                // way out; each lot takes its share of it by shares, remainder
                // on the last portion, like the proceeds of a sale.
                let mut value_left = r.gross_cents.max(0);
                for (k, (i, take)) in plan.iter().enumerate() {
                    let lot = &mut lots[*i];
                    let whole = *take == lot.shares_micro;
                    let cost = if whole { lot.cost_cents } else { mul_div(lot.cost_cents, *take, lot.shares_micro) };
                    let proceeds = if k + 1 == n { proceeds_left } else { mul_div(net, *take, to_close) };
                    proceeds_left -= proceeds;
                    let value = if k + 1 == n { value_left } else { mul_div(r.gross_cents.max(0), *take, to_close) };
                    value_left -= value;
                    lot.shares_micro -= take;
                    lot.cost_cents -= cost;
                    if is_transfer {
                        let moved = Lot {
                            id: lot.id.clone(),
                            account_id: String::new(),
                            security_id: lot.security_id.clone(),
                            acquired_on: lot.acquired_on.clone(),
                            shares_micro: *take,
                            cost_cents: cost,
                            original_shares_micro: *take,
                            original_cost_cents: cost,
                        };
                        if exchange {
                            pool.entry((r.account_id.clone(), r.date.clone())).or_default().push((moved, value));
                        } else {
                            carried.entry(r.id.clone()).or_default().push(moved);
                        }
                    }
                    out.disposals.push(Disposal {
                        sell_id: r.id.clone(),
                        lot_id: lot.id.clone(),
                        account_id: r.account_id.clone(),
                        security_id: r.security_id.clone(),
                        acquired_on: lot.acquired_on.clone(),
                        sold_on: r.date.clone(),
                        shares_micro: *take,
                        proceeds_cents: proceeds,
                        cost_cents: cost,
                        gain_cents: if a == "sell" { proceeds - cost } else { 0 },
                        long_term: is_long_term(&lot.acquired_on, &r.date),
                        realized: a == "sell",
                    });
                }
                lots.retain(|l| l.shares_micro > 0);
            }
            "split" => {
                if r.shares_micro <= 0 {
                    out.problems.push(format!("Split on {}: {} has no ratio", r.date, sec));
                    continue;
                }
                for l in lots.iter_mut() {
                    l.shares_micro = mul_div(l.shares_micro, r.shares_micro, MICRO);
                }
            }
            "return_of_capital" => {
                let total: i64 = lots.iter().map(|l| l.cost_cents).sum();
                if total == 0 || r.gross_cents == 0 {
                    continue;
                }
                let mut cut_left = r.gross_cents.min(total);
                if r.gross_cents > total {
                    out.problems.push(format!(
                        "Return of Capital on {}: {} returned more than the {} basis left in {}; the excess is a gain this app does not record",
                        r.date, fmt_cents(r.gross_cents), fmt_cents(total), sec
                    ));
                }
                let n = lots.len();
                for (k, l) in lots.iter_mut().enumerate() {
                    let cut = if k + 1 == n { cut_left } else { mul_div(r.gross_cents.min(total), l.cost_cents, total).min(cut_left) };
                    l.cost_cents -= cut;
                    cut_left -= cut;
                }
            }
            _ => {}
        }
    }

    flush_exchanges(&mut open, &mut pool, &mut pending, &mut out, &names);
    while ci < cps.len() {
        out.snapshots.push(snapshot_of(&open, account_id, security_id, cps[ci]));
        ci += 1;
    }

    for ((acct, _), lots) in open {
        if account_id.map_or(true, |a| a == acct) {
            out.lots.extend(lots);
        }
    }
    if let Some(a) = account_id {
        out.disposals.retain(|d| d.account_id == a);
    }
    if let Some(s) = security_id {
        out.lots.retain(|l| l.security_id == s);
        out.disposals.retain(|d| d.security_id == s);
    }
    Ok(out)
}

/// The in-rows of a day's exchanges draw their lots from what went
/// out that day, in the same account.
///
/// Each in-row takes a share of every pooled lot in proportion to the VALUE
/// it brought in (the row's gross), so two funds bought with the proceeds of
/// one carry its basis between them the way the money was split; the new
/// fund's shares are spread across those slices by the VALUE each had on
/// the way out, so a lot's date and its cost stay together and a lot that
/// had gained more becomes more of the new fund. (Spreading by cost — the
/// first version of this — gave every lot the same cost per share, which
/// hid which contributions were behind: with contributions at $17 and at
/// $19 exchanged into one fund at $25, both must keep their own gain.)
/// Remainders land on the last portion, as everywhere else in this file, so
/// the pieces add back up.
///
/// An in-row on a day nothing went out is taken as bought that day at the
/// cost typed, and said so — the same answer a share transfer gives when its
/// sending half is missing.
fn flush_exchanges(
    open: &mut BTreeMap<(String, String), Vec<Lot>>,
    pool: &mut HashMap<(String, String), Vec<(Lot, i64)>>,
    pending: &mut Vec<InvRow>,
    out: &mut Ledger,
    names: &HashMap<String, String>,
) {
    if pending.is_empty() {
        return;
    }
    let mut groups: BTreeMap<(String, String), Vec<InvRow>> = BTreeMap::new();
    for r in std::mem::take(pending) {
        groups.entry((r.account_id.clone(), r.date.clone())).or_default().push(r);
    }
    for (key, ins) in groups {
        let moved = pool.remove(&key).unwrap_or_default();
        let total_in: i64 = ins.iter().map(|r| r.gross_cents.max(0)).sum();
        let n = ins.len() as i64;
        let mut cost_left: Vec<i64> = moved.iter().map(|(l, _)| l.cost_cents).collect();
        let mut value_left: Vec<i64> = moved.iter().map(|(_, v)| *v).collect();
        for (k, r) in ins.iter().enumerate() {
            let sec = names.get(&r.security_id).cloned().unwrap_or_else(|| r.security_id.clone());
            if r.shares_micro <= 0 {
                out.problems.push(format!("Exchange on {}: Add Shares of {} adds no shares", r.date, sec));
                continue;
            }
            let lots = open.entry((r.account_id.clone(), r.security_id.clone())).or_default();
            if moved.is_empty() {
                out.problems.push(format!(
                    "Exchange on {}: {} arrived but nothing left the account that day — taken as bought that day at the cost typed",
                    r.date, sec
                ));
                let cost = r.gross_cents + r.commission_cents;
                lots.push(Lot {
                    id: r.id.clone(),
                    account_id: r.account_id.clone(),
                    security_id: r.security_id.clone(),
                    acquired_on: r.date.clone(),
                    shares_micro: r.shares_micro,
                    cost_cents: cost,
                    original_shares_micro: r.shares_micro,
                    original_cost_cents: cost,
                });
                continue;
            }
            let last_in = k as i64 + 1 == n;
            let weight = r.gross_cents.max(0);
            // This in-row's slice of each pooled lot: (lot index, cost, the
            // value that slice had on the way out).
            let mut slices: Vec<(usize, i64, i64)> = Vec::new();
            for (i, (l, v)) in moved.iter().enumerate() {
                let (cost, value) = if last_in {
                    (cost_left[i], value_left[i])
                } else if total_in > 0 {
                    (mul_div(l.cost_cents, weight, total_in).min(cost_left[i]), mul_div(*v, weight, total_in).min(value_left[i]))
                } else {
                    (mul_div(l.cost_cents, 1, n).min(cost_left[i]), mul_div(*v, 1, n).min(value_left[i]))
                };
                cost_left[i] -= cost;
                value_left[i] -= value;
                slices.push((i, cost, value));
            }
            // The new fund's shares, spread across the slices by the value
            // each was worth on the way out (by cost when no value is known —
            // a Remove Shares typed with no amount), remainder on the last; a
            // slice too small to hold a share folds its cost into the last
            // one rather than losing it.
            let my_value: i64 = slices.iter().map(|s| s.2).sum();
            let my_cost: i64 = slices.iter().map(|s| s.1).sum();
            let mut shares_out = r.shares_micro;
            let mut spill = 0;
            let m = slices.len();
            for (j, (i, cost, value)) in slices.iter().enumerate() {
                let last = j + 1 == m;
                let new_shares = if last {
                    shares_out
                } else if my_value > 0 {
                    mul_div(r.shares_micro, *value, my_value).min(shares_out)
                } else if my_cost > 0 {
                    mul_div(r.shares_micro, *cost, my_cost).min(shares_out)
                } else {
                    mul_div(r.shares_micro, 1, m as i64).min(shares_out)
                };
                shares_out -= new_shares;
                if new_shares <= 0 && !last {
                    spill += cost;
                    continue;
                }
                let (l, _) = &moved[*i];
                let cost = cost + if last { spill } else { 0 };
                if last && new_shares <= 0 {
                    // Rounding left the last slice no shares: its cost joins
                    // the lot this row made just before it, if there is one.
                    if let Some(prev) = lots.iter_mut().rev().find(|x| x.id.ends_with(&format!(">{}", r.id))) {
                        prev.cost_cents += cost;
                        prev.original_cost_cents += cost;
                        continue;
                    }
                }
                lots.push(Lot {
                    id: format!("{}>{}", l.id, r.id),
                    account_id: r.account_id.clone(),
                    security_id: r.security_id.clone(),
                    acquired_on: l.acquired_on.clone(),
                    shares_micro: new_shares,
                    cost_cents: cost,
                    original_shares_micro: new_shares,
                    original_cost_cents: cost,
                });
            }
            lots.sort_by(|x, y| x.acquired_on.cmp(&y.acquired_on));
        }
    }
}

/// What one account holds of each security on `asof`, by NAME, in
/// micro-shares. For the TSP importer, which names its securities and has
/// to know what is already there before it writes an opening position —
/// writing the file's inferred opening on top of shares the register already
/// held would double the holdings.
pub fn shares_held_by_name(conn: &Connection, account_id: &str, asof: &str) -> Result<HashMap<String, i64>, String> {
    let ledger = replay(conn, Some(account_id), None, Some(asof))?;
    let names = security_names(conn)?;
    let mut out: HashMap<String, i64> = HashMap::new();
    for lot in ledger.lots {
        if lot.account_id != account_id || lot.shares_micro <= 0 {
            continue;
        }
        let name = names.get(&lot.security_id).cloned().unwrap_or_else(|| lot.security_id.clone());
        *out.entry(name).or_default() += lot.shares_micro;
    }
    Ok(out)
}

fn security_names(conn: &Connection) -> Result<HashMap<String, String>, String> {
    let mut st = conn.prepare("SELECT id, name FROM securities").map_err(|e| e.to_string())?;
    let it = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
    let mut m = HashMap::new();
    for row in it {
        let (i, n) = row.map_err(|e| e.to_string())?;
        m.insert(i, n);
    }
    Ok(m)
}

pub fn fmt_shares(micro: i64) -> String {
    let neg = micro < 0;
    let a = micro.abs();
    let whole = a / MICRO;
    let frac = a % MICRO;
    let mut s = if frac == 0 {
        format!("{whole}")
    } else {
        let f = format!("{frac:06}");
        format!("{whole}.{}", f.trim_end_matches('0'))
    };
    if neg {
        s.insert(0, '-');
    }
    s
}

/// `fmt_cents` for callers outside this module (the demo receipt).
pub fn fmt_cents_public(c: i64) -> String {
    fmt_cents(c)
}

fn fmt_cents(c: i64) -> String {
    crate::models::format_cents(c)
}

/// The latest price on or before `asof`: (price_micro, date, source).
pub fn price_asof(conn: &Connection, security_id: &str, asof: &str) -> Result<Option<(i64, String, String)>, String> {
    conn.query_row(
        "SELECT price_micro, date, source FROM security_prices
          WHERE security_id = ?1 AND date <= ?2
          ORDER BY date DESC LIMIT 1",
        params![security_id, asof],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Market value of every account's holdings as of `asof`, keyed by account.
/// Accounts with no holdings are absent.
pub fn holdings_by_account(conn: &Connection, asof: &str) -> Result<HashMap<String, i64>, String> {
    let ledger = replay(conn, None, None, Some(asof))?;
    let r = rounding(conn)?;
    let mut prices: HashMap<String, Option<i64>> = HashMap::new();
    // Value each (account, security) POSITION once, as the Portfolio page
    // does — valuing lot by lot and summing could differ from it by a cent,
    // and the sidebar and the Portfolio must print the same number.
    let mut positions: BTreeMap<(String, String), (i64, i64)> = BTreeMap::new();
    for l in &ledger.lots {
        let e = positions.entry((l.account_id.clone(), l.security_id.clone())).or_default();
        e.0 += l.shares_micro;
        e.1 += l.cost_cents;
    }
    let mut out: HashMap<String, i64> = HashMap::new();
    let mut modes: HashMap<String, Rounding> = HashMap::new();
    for ((acct, sec), (shares, cost)) in positions {
        let ra = match modes.get(&acct) {
            Some(m) => *m,
            None => {
                let m = rounding_for_account(conn, &acct, r)?;
                modes.insert(acct.clone(), m);
                m
            }
        };
        let p = match prices.get(&sec) {
            Some(p) => *p,
            None => {
                let p = price_asof(conn, &sec, asof)?.map(|(p, _, _)| p);
                prices.insert(sec.clone(), p);
                p
            }
        };
        let v = match p {
            Some(p) => value_cents_rounded(shares, p, ra),
            None => cost,
        };
        *out.entry(acct).or_default() += v;
    }
    Ok(out)
}

/// The Portfolio page: every holding (optionally in one account) as of a date.
pub fn portfolio(conn: &Connection, account_id: Option<&str>, asof: &str) -> Result<Portfolio, String> {
    let ledger = replay(conn, account_id, None, Some(asof))?;
    let r = rounding(conn)?;
    let mut by_key: BTreeMap<(String, String), Vec<Lot>> = BTreeMap::new();
    for l in ledger.lots {
        by_key.entry((l.account_id.clone(), l.security_id.clone())).or_default().push(l);
    }
    let mut positions = Vec::new();
    for ((acct, sec), lots) in by_key {
        let (account_name,): (String,) = conn
            .query_row("SELECT name FROM accounts WHERE id = ?1", params![acct], |r| Ok((r.get(0)?,)))
            .map_err(|e| e.to_string())?;
        let (security_name, symbol, kind): (String, String, String) = conn
            .query_row("SELECT name, symbol, kind FROM securities WHERE id = ?1", params![sec], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?;
        let shares: i64 = lots.iter().map(|l| l.shares_micro).sum();
        let cost: i64 = lots.iter().map(|l| l.cost_cents).sum();
        let price = price_asof(conn, &sec, asof)?;
        let ra = rounding_for_account(conn, &acct, r)?;
        let value = match &price {
            Some((p, _, _)) => value_cents_rounded(shares, *p, ra),
            None => cost,
        };
        positions.push(Position {
            account_id: acct,
            account_name,
            rounding: ra.as_str().to_string(),
            security_id: sec,
            security_name,
            symbol,
            security_kind: kind,
            shares_micro: shares,
            cost_cents: cost,
            price_micro: price.as_ref().map(|p| p.0),
            price_date: price.as_ref().map(|p| p.1.clone()),
            value_cents: value,
            gain_cents: value - cost,
            lots,
        });
    }
    positions.sort_by(|a, b| a.account_name.cmp(&b.account_name).then(a.security_name.cmp(&b.security_name)));
    let total_cost = positions.iter().map(|p| p.cost_cents).sum();
    let total_value = positions.iter().map(|p| p.value_cents).sum();
    let cash: i64 = {
        let mut sql = String::from(
            "SELECT COALESCE(SUM(t.amount_cents), 0)
               FROM transactions t JOIN accounts a ON a.id = t.account_id
              WHERE t.is_void = 0 AND t.date <= ?1
                AND a.type IN ('investment','retirement')",
        );
        let mut args: Vec<String> = vec![asof.to_string()];
        if let Some(a) = account_id {
            args.push(a.to_string());
            sql.push_str(" AND a.id = ?2");
        }
        conn.query_row(&sql, rusqlite::params_from_iter(args.iter()), |r| r.get(0))
            .map_err(|e| e.to_string())?
    };
    Ok(Portfolio {
        as_of: asof.to_string(),
        positions,
        total_cost_cents: total_cost,
        total_value_cents: total_value,
        cash_cents: cash,
        problems: ledger.problems,
        rounding: r.as_str().to_string(),
    })
}

/// Realized gains in a date range (sells only; Remove Shares realizes nothing).
pub fn realized(conn: &Connection, account_id: Option<&str>, from: &str, to: &str) -> Result<Vec<Disposal>, String> {
    let ledger = replay(conn, account_id, None, Some(to))?;
    Ok(ledger.disposals.into_iter().filter(|d| d.realized && d.sold_on.as_str() >= from).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mul_div_rounds_half_away_and_never_overflows() {
        assert_eq!(mul_div(10, 1, 4), 3); // 2.5 → 3
        assert_eq!(mul_div(-10, 1, 4), -3);
        assert_eq!(mul_div(7, 1, 3), 2);
        assert_eq!(mul_div(i64::MAX, 2, 4), i64::MAX / 2 + 1);
        assert_eq!(mul_div(5, 5, 0), 0);
    }

    #[test]
    fn value_and_price_are_inverse_enough() {
        // 12.3456 shares at 34.5678 = 426.76023 → 426.76
        assert_eq!(value_cents(12_345_600, 34_567_800), 42_676);
        // 100 shares for $1,234.56 → 12.3456
        assert_eq!(price_from(123_456, 100 * MICRO), Some(12_345_600));
        assert_eq!(price_from(100, 0), None);
    }

    #[test]
    fn shares_print_without_trailing_zeros() {
        assert_eq!(fmt_shares(12_345_600), "12.3456");
        assert_eq!(fmt_shares(100 * MICRO), "100");
        assert_eq!(fmt_shares(-500_000), "-0.5");
    }

    #[test]
    fn long_term_means_more_than_one_year() {
        assert!(!is_long_term("2025-03-10", "2026-03-10"));
        assert!(is_long_term("2025-03-10", "2026-03-11"));
        assert!(!is_long_term("2024-02-29", "2025-02-28"));
    }
}

// ---------------------------------------------------------------------------
// Performance: the two returns Money never had.
//
// The ROI table below nets contributions out of a gain, which makes
// the figure honest but not comparable to anything: it is neither the
// return the INVESTMENTS earned (which a benchmark should be measured
// against) nor the return the INVESTOR earned (which depends on when the
// money went in). Those are two different questions with two standard
// answers:
//
//   time-weighted  — chain the growth between each cash flow, so a deposit
//                    the day before a fall does not make the fund look bad;
//   money-weighted — the one rate that discounts every flow and the ending
//                    value to zero (XIRR), so timing counts, as it does to
//                    the person who chose the timing.
//
// Both are integer arithmetic on cents, as everything here is: growth
// factors and discount factors are i128 fixed-point at 1e12, a daily rate
// is found by bisection, and a percentage leaves as basis points. No f64.
//
// What is valued: holdings at the day's price PLUS the account's cash — the
// whole account — so a buy paid from cash already there is not a flow and
// a dividend paid in cash is return. What is a flow: money that crossed the
// account's edge — a transfer half, or a cash row that is not an expense
// (a contribution, a plan withdrawal). A fee paid from cash is an expense
// row and stays inside: it is a cost of the return, not money taken out.

/// Fixed-point scale for growth and discount factors.
const FX: i128 = 1_000_000_000_000;

/// `base^n` in fixed point, by squaring.
fn fx_pow(base: i128, mut n: u32) -> i128 {
    let mut r = FX;
    let mut b = base;
    while n > 0 {
        if n & 1 == 1 {
            r = r * b / FX;
        }
        b = b * b / FX;
        n >>= 1;
    }
    r
}

/// The bracket a daily growth factor is searched in: −0.5% to +0.5% a day,
/// which is −84% to +517% a year. Wider and `fx_pow` over ten years
/// overflows or underflows the scale; a return outside it is not a number
/// this table should print anyway.
const DAILY_LO: i128 = FX - FX / 200;
const DAILY_HI: i128 = FX + FX / 200;

/// The daily factor `b` with `fx_pow(b, days) == target`, or None when the
/// target is outside what the bracket can reach.
fn daily_factor_for(target: i128, days: u32) -> Option<i128> {
    if days == 0 {
        return None;
    }
    let (mut lo, mut hi) = (DAILY_LO, DAILY_HI);
    if fx_pow(lo, days) > target || fx_pow(hi, days) < target {
        return None;
    }
    for _ in 0..80 {
        let mid = (lo + hi) / 2;
        if fx_pow(mid, days) < target {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Some((lo + hi) / 2)
}

/// Net present value of `flows` (day offset, cents) at daily factor `base`,
/// scaled by FX. A term whose discount factor underflows to zero is dropped
/// rather than dividing by it.
fn npv(base: i128, flows: &[(u32, i64)]) -> i128 {
    flows
        .iter()
        .map(|(t, cf)| {
            let d = fx_pow(base, *t);
            if d == 0 { 0 } else { (*cf as i128) * FX * FX / d }
        })
        .sum()
}

/// The daily factor at which `flows` net to zero — the internal rate of
/// return — or None when no rate in the bracket does. NPV falls as the rate
/// rises when money goes in first and comes out last, which is the shape
/// every period here has: −start value, −contributions, +end value.
fn irr_daily(flows: &[(u32, i64)]) -> Option<i128> {
    let (mut lo, mut hi) = (DAILY_LO, DAILY_HI);
    let (flo, fhi) = (npv(lo, flows), npv(hi, flows));
    if flo == 0 {
        return Some(lo);
    }
    if fhi == 0 {
        return Some(hi);
    }
    if (flo > 0) == (fhi > 0) {
        return None;
    }
    let falling = flo > 0;
    for _ in 0..80 {
        let mid = (lo + hi) / 2;
        let f = npv(mid, flows);
        if (f > 0) == falling {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Some((lo + hi) / 2)
}

/// A daily factor as a yearly return, in basis points.
fn annual_bps(daily: i128) -> i64 {
    ((fx_pow(daily, 365) - FX) * 10_000 / FX) as i64
}

/// Cash in the account (or every investment account) at the close of `date`.
fn cash_on(conn: &Connection, account_id: Option<&str>, date: &str) -> Result<i64, String> {
    let mut sql = String::from(
        "SELECT COALESCE(SUM(t.amount_cents), 0)
           FROM transactions t JOIN accounts a ON a.id = t.account_id
          WHERE t.is_void = 0 AND t.date <= ?1
            AND a.type IN ('investment','retirement')",
    );
    let mut args: Vec<String> = vec![date.to_string()];
    if let Some(a) = account_id {
        args.push(a.to_string());
        sql.push_str(" AND a.id = ?2");
    }
    conn.query_row(&sql, rusqlite::params_from_iter(args.iter()), |r| r.get(0)).map_err(|e| e.to_string())
}

/// What the account (every investment account, or one fund in it)
/// was worth at the close of each of `dates`: holdings at that day's price
/// plus, unless the scope is one security, cash. One replay for all of them
/// — the same positions `portfolio` would report on each day, valued the
/// same way (the account's rounding; cost when a security has no price).
pub fn worth_on_dates(conn: &Connection, account_id: Option<&str>, security_id: Option<&str>, dates: &[String]) -> Result<BTreeMap<String, i64>, String> {
    let mut out = BTreeMap::new();
    let Some(last) = dates.iter().max() else { return Ok(out) };
    let ledger = replay_at(conn, account_id, security_id, Some(last), dates)?;
    let r = rounding(conn)?;
    let mut modes: HashMap<String, Rounding> = HashMap::new();
    let mut prices: HashMap<(String, String), Option<i64>> = HashMap::new();
    for snap in &ledger.snapshots {
        let mut total = 0i64;
        for (acct, sec, shares, cost) in &snap.positions {
            let ra = match modes.get(acct) {
                Some(m) => *m,
                None => {
                    let m = rounding_for_account(conn, acct, r)?;
                    modes.insert(acct.clone(), m);
                    m
                }
            };
            let key = (sec.clone(), snap.date.clone());
            let p = match prices.get(&key) {
                Some(p) => *p,
                None => {
                    let p = price_asof(conn, sec, &snap.date)?.map(|x| x.0);
                    prices.insert(key, p);
                    p
                }
            };
            total += match p {
                Some(p) => value_cents_rounded(*shares, p, ra),
                None => *cost,
            };
        }
        if security_id.is_none() {
            total += cash_on(conn, account_id, &snap.date)?;
        }
        out.insert(snap.date.clone(), total);
    }
    Ok(out)
}

/// Money into or out of ONE holding, by day, in (`after`, `to`]:
/// what a buy cost, what a sale brought, and the value shares carried in or
/// out (an exchange within the plan, a transfer between accounts). A
/// reinvested distribution is the fund's own earnings, not new money, and a
/// split moves nothing. Shares carried without a stated value are valued at
/// that day's price.
fn security_flows(conn: &Connection, account_id: Option<&str>, security_id: &str, after: &str, to: &str) -> Result<Vec<(String, i64)>, String> {
    let mut sql = String::from(
        "SELECT t.date, t.activity, COALESCE(t.shares_micro, 0), COALESCE(t.gross_cents, 0), t.commission_cents
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
          WHERE t.is_void = 0 AND t.security_id = ?1
            AND t.activity IN ('buy','sell','add_shares','remove_shares')
            AND t.date > ?2 AND t.date <= ?3",
    );
    let mut args = vec![security_id.to_string(), after.to_string(), to.to_string()];
    if let Some(a) = account_id {
        args.push(a.to_string());
        sql.push_str(" AND a.id = ?4");
    }
    sql.push_str(" ORDER BY t.date, t.rowid");
    let mut st = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = st
        .query_map(rusqlite::params_from_iter(args.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut by_day: BTreeMap<String, i64> = BTreeMap::new();
    for (date, activity, shares, gross, commission) in rows {
        let carried = |gross: i64| -> Result<i64, String> {
            if gross > 0 {
                return Ok(gross);
            }
            Ok(price_asof(conn, security_id, &date)?.map(|(p, _, _)| value_cents(shares, p)).unwrap_or(0))
        };
        let amount = match activity.as_str() {
            "buy" => gross + commission,
            "sell" => -(gross - commission),
            "add_shares" => carried(gross)?,
            "remove_shares" => -carried(gross)?,
            _ => 0,
        };
        *by_day.entry(date).or_insert(0) += amount;
    }
    Ok(by_day.into_iter().filter(|(_, v)| *v != 0).collect())
}

/// Money that crossed the account's edge, by day, in (`after`, `to`]:
/// transfer halves and cash rows that are not an expense. Across every
/// investment account a transfer between two of them nets to zero on its
/// day, as it should.
fn account_flows(conn: &Connection, account_id: Option<&str>, after: &str, to: &str) -> Result<Vec<(String, i64)>, String> {
    let mut sql = String::from(
        "SELECT t.date, SUM(t.amount_cents)
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
           LEFT JOIN categories c ON c.id = t.category_id
          WHERE t.is_void = 0 AND t.activity IS NULL
            AND a.type IN ('investment','retirement')
            AND t.date > ?1 AND t.date <= ?2
            AND (t.transfer_id IS NOT NULL OR COALESCE(c.kind, 'income') <> 'expense')",
    );
    let mut args = vec![after.to_string(), to.to_string()];
    if let Some(a) = account_id {
        args.push(a.to_string());
        sql.push_str(" AND a.id = ?3");
    }
    sql.push_str(" GROUP BY t.date HAVING SUM(t.amount_cents) <> 0 ORDER BY t.date");
    let mut st = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = st
        .query_map(rusqlite::params_from_iter(args.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// The two returns for one period, plus the figures they were made from.
///
/// Both are for the period as a whole and then annualized only when the
/// period is at least a year long (the convention everywhere
/// returns are published; a month's −4.7% shown as −43% a year is a number
/// nobody should act on, and a user asked what it was).
pub fn performance_between(conn: &Connection, account_id: Option<&str>, security_id: Option<&str>, from: &str, to: &str) -> Result<Performance, String> {
    let from_d = NaiveDate::parse_from_str(from, "%Y-%m-%d").map_err(|e| format!("bad date {from:?}: {e}"))?;
    let to_d = NaiveDate::parse_from_str(to, "%Y-%m-%d").map_err(|e| format!("bad date {to:?}: {e}"))?;
    let days = (to_d - from_d).num_days().max(0) as u32;
    // One fund's edge is what it was bought and sold for; the
    // account's is what crossed into or out of the account.
    let flows = match security_id {
        Some(s) => security_flows(conn, account_id, s, from, to)?,
        None => account_flows(conn, account_id, from, to)?,
    };
    let mut dates: Vec<String> = vec![from.to_string(), to.to_string()];
    dates.extend(flows.iter().map(|(d, _)| d.clone()));
    let worth = worth_on_dates(conn, account_id, security_id, &dates)?;
    let worth_on = |d: &str| -> Result<i64, String> { worth.get(d).copied().ok_or_else(|| format!("no valuation for {d}")) };
    let start = worth_on(from)?;
    let end = worth_on(to)?;
    let flows_in: i64 = flows.iter().map(|(_, f)| *f).filter(|f| *f > 0).sum();
    let flows_out: i64 = -flows.iter().map(|(_, f)| *f).filter(|f| *f < 0).sum::<i64>();
    let gain = end - start - (flows_in - flows_out);

    // Time-weighted: chain the growth of each stretch between flows. A
    // stretch that starts from nothing (the account before its first
    // deposit) has no growth to measure and is skipped.
    let mut prod = FX;
    let mut measured = 0usize;
    let mut prev = start;
    for (date, f) in &flows {
        let v = worth_on(date)?;
        if prev > 0 {
            prod = prod * ((v - f) as i128 * FX / prev as i128) / FX;
            measured += 1;
        }
        prev = v;
    }
    if prev > 0 && (flows.is_empty() || flows.last().map(|(d, _)| d.as_str()) != Some(to)) {
        prod = prod * (end as i128 * FX / prev as i128) / FX;
        measured += 1;
    }
    let twr_bps = if measured > 0 { Some(((prod - FX) * 10_000 / FX) as i64) } else { None };
    let twr_annual_bps = if measured > 0 && days >= 365 { daily_factor_for(prod, days).map(annual_bps) } else { None };

    // Money-weighted: the rate that discounts what went in to what came out.
    let mwr_annual_bps = if days >= 365 && (start > 0 || !flows.is_empty()) && end > 0 {
        let mut cf: Vec<(u32, i64)> = vec![(0, -start)];
        for (date, f) in &flows {
            let t = (NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|e| e.to_string())? - from_d).num_days().max(0) as u32;
            cf.push((t, -f));
        }
        cf.push((days, end));
        irr_daily(&cf).map(annual_bps)
    } else {
        None
    };

    Ok(Performance {
        label: String::new(),
        from: from.to_string(),
        to: to.to_string(),
        start_value_cents: start,
        end_value_cents: end,
        flows_in_cents: flows_in,
        flows_out_cents: flows_out,
        gain_cents: gain,
        twr_bps,
        twr_annual_bps,
        mwr_annual_bps,
        flow_days: flows.len(),
    })
}

/// The Investing tab's performance table: the same periods as the ROI table,
/// plus three years, and all time from the day before the first row.
pub fn performance(conn: &Connection, account_id: Option<&str>, security_id: Option<&str>, asof: &str) -> Result<Vec<Performance>, String> {
    use chrono::Datelike;
    let to = NaiveDate::parse_from_str(asof, "%Y-%m-%d").map_err(|e| format!("bad date {asof:?}: {e}"))?;
    let back = |months: i64| -> NaiveDate {
        let (y, m) = crate::schedule::add_months(to.year(), to.month(), -months);
        let last = NaiveDate::from_ymd_opt(y, m + 1, 1).or_else(|| NaiveDate::from_ymd_opt(y + 1, 1, 1)).unwrap().pred_opt().unwrap();
        NaiveDate::from_ymd_opt(y, m, to.day().min(last.day())).unwrap()
    };
    let year_start = NaiveDate::from_ymd_opt(to.year(), 1, 1).unwrap().pred_opt().unwrap();
    let first: Option<String> = {
        let mut sql = String::from("SELECT MIN(t.date) FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.is_void = 0 AND a.type IN ('investment','retirement')");
        let mut args: Vec<String> = Vec::new();
        if let Some(a) = account_id {
            args.push(a.to_string());
            sql.push_str(&format!(" AND a.id = ?{}", args.len()));
        }
        if let Some(s) = security_id {
            args.push(s.to_string());
            sql.push_str(&format!(" AND t.security_id = ?{}", args.len()));
        }
        conn.query_row(&sql, rusqlite::params_from_iter(args.iter()), |r| r.get(0)).map_err(|e| e.to_string())?
    };
    let all_time = first
        .and_then(|d| NaiveDate::parse_from_str(&d, "%Y-%m-%d").ok())
        .and_then(|d| d.pred_opt());
    let mut periods: Vec<(&str, NaiveDate)> = vec![("Past month", back(1)), ("Year to date", year_start), ("12 months", back(12)), ("3 years", back(36))];
    if let Some(d) = all_time {
        periods.push(("All time", d));
    }
    let mut out = Vec::new();
    for (label, from) in periods {
        if from >= to {
            continue;
        }
        let mut p = performance_between(conn, account_id, security_id, &from.format("%Y-%m-%d").to_string(), asof)?;
        p.label = label.to_string();
        out.push(p);
    }
    Ok(out)
}

/// Money's ROI figures for the Portfolio page: past month, year to
/// date, 12 months, all time. Money's own formula is (value now − value
/// then + income) / value then, which counts every contribution as a gain;
/// this one takes the money in and out back out of it:
///
///   return = (unrealized gain at end − unrealized gain at start)
///          + gains realized in the period + income in the period
///
/// so a 401(k) that received $6,000 of contributions and rose $400 shows
/// $400, not $6,400. The denominator is the value at the start (None when
/// nothing was held), and for all-time the cost of everything ever bought.
pub fn roi(conn: &Connection, account_id: Option<&str>, asof: &str) -> Result<Vec<RoiPeriod>, String> {
    use chrono::{Datelike, NaiveDate};
    let to = NaiveDate::parse_from_str(asof, "%Y-%m-%d").map_err(|e| format!("bad date {asof:?}: {e}"))?;
    let month_ago = {
        let (y, m) = crate::schedule::add_months(to.year(), to.month(), -1);
        let last = NaiveDate::from_ymd_opt(y, m + 1, 1).or_else(|| NaiveDate::from_ymd_opt(y + 1, 1, 1)).unwrap().pred_opt().unwrap();
        NaiveDate::from_ymd_opt(y, m, to.day().min(last.day())).unwrap()
    };
    let year_start = NaiveDate::from_ymd_opt(to.year(), 1, 1).unwrap().pred_opt().unwrap();
    let year_ago = NaiveDate::from_ymd_opt(to.year() - 1, to.month(), to.day()).unwrap_or_else(|| NaiveDate::from_ymd_opt(to.year() - 1, to.month(), 28).unwrap());
    let end = portfolio(conn, account_id, asof)?;
    let unrealized_end = end.total_value_cents - end.total_cost_cents;
    let mut out = Vec::new();
    let periods: [(&str, Option<NaiveDate>); 4] = [("Past month", Some(month_ago)), ("Year to date", Some(year_start)), ("12 months", Some(year_ago)), ("All time", None)];
    for (label, start) in periods {
        let (from_iso, start_value, unrealized_start, denominator) = match start {
            Some(d) => {
                let iso = d.format("%Y-%m-%d").to_string();
                let p = portfolio(conn, account_id, &iso)?;
                (iso, p.total_value_cents, p.total_value_cents - p.total_cost_cents, p.total_value_cents)
            }
            None => {
                // Everything ever put in: the cost of every lot opened.
                let ledger = replay(conn, account_id, None, Some(asof))?;
                let cost_in: i64 = ledger.lots.iter().map(|l| l.cost_cents).sum::<i64>() + ledger.disposals.iter().map(|d| d.cost_cents).sum::<i64>();
                ("".to_string(), 0, 0, cost_in)
            }
        };
        let from_next = match start {
            Some(d) => d.succ_opt().unwrap().format("%Y-%m-%d").to_string(),
            None => "0000-00-00".to_string(),
        };
        let realized_cents: i64 = realized(conn, account_id, &from_next, asof)?.iter().map(|d| d.gain_cents).sum();
        let income_cents: i64 = {
            let mut sql = String::from(
                "SELECT COALESCE(SUM(t.gross_cents), 0) FROM transactions t JOIN accounts a ON a.id = t.account_id
                  WHERE t.is_void = 0 AND t.date >= ?1 AND t.date <= ?2
                    AND t.activity IN ('dividend','interest','ltcg_dist','stcg_dist','reinvest_dividend','reinvest_interest','reinvest_ltcg','reinvest_stcg')",
            );
            let mut args = vec![from_next.clone(), asof.to_string()];
            if let Some(a) = account_id {
                sql.push_str(" AND a.id = ?3");
                args.push(a.to_string());
            }
            conn.query_row(&sql, rusqlite::params_from_iter(args.iter()), |r| r.get(0)).map_err(|e| e.to_string())?
        };
        let unrealized_change = unrealized_end - unrealized_start;
        let ret = unrealized_change + realized_cents + income_cents;
        out.push(RoiPeriod {
            label: label.to_string(),
            from: from_iso,
            to: asof.to_string(),
            start_value_cents: start_value,
            end_value_cents: end.total_value_cents,
            unrealized_change_cents: unrealized_change,
            realized_cents,
            income_cents,
            return_cents: ret,
            return_bps: if denominator > 0 { Some(crate::db::reports::bps(ret, denominator)) } else { None },
        });
    }
    Ok(out)
}
