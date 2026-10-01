//! The connection type and what several areas share: the categorized-lines CTE
//! and the transaction row mapper.

use crate::models::Transaction;
use r2d2::PooledConnection;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Row;

pub type Conn = PooledConnection<SqliteConnectionManager>;

/// One row per *categorized line* of spending or income.
///
/// A split transaction has no category of its own (`set_splits` clears it), so
/// grouping straight off `transactions.category_id` silently drops split
/// spending from every budget and report. This CTE expands each transaction
/// into its split lines when it has them, and yields the transaction itself
/// when it does not — so callers can group by category without caring which.
/// Investment rows: buys, sells, share moves and splits are exchanges
/// of one asset for another, not income or spending, and are left out; the
/// income activities count, and a REINVESTED dividend counts for the amount
/// reinvested (`gross_cents`), because its cash effect is zero but the income
/// is real — and taxable.
/// `pub(crate)` so `db::plan` can read the same lines the budget
/// screen does. One definition of "what counts as money against a category",
/// or the year plan and the month screen would disagree about a split.
///
/// `amount_cents` is in dollars, converted at the rate on the line's day for
/// an account kept in another currency — budgets are in dollars.
pub(crate) const CATEGORY_LINES: &str = concat!(r#"
    WITH raw_lines AS (
        SELECT t.id                                   AS txn_id,
               t.date                                 AS date,
               COALESCE(s.category_id, t.category_id) AS category_id,
               COALESCE(s.amount_cents,
                        CASE WHEN t.activity LIKE 'reinvest_%' THEN t.gross_cents ELSE t.amount_cents END)
                                                      AS native_cents,
               t.account_id                           AS account_id
        FROM transactions t
        LEFT JOIN splits s ON s.transaction_id = t.id
        WHERE t.is_void = 0 AND t.transfer_id IS NULL
          -- A revaluation is not spending, and neither half of a
          -- split transfer is. Same exclusions as `reports::LINES`.
          AND t.is_revaluation = 0 AND t.is_split_transfer = 0
          AND (s.id IS NULL OR s.transfer_account_id IS NULL)
          AND (t.activity IS NULL OR t.activity IN
               ('dividend','interest','ltcg_dist','stcg_dist',
                'reinvest_dividend','reinvest_interest','reinvest_ltcg','reinvest_stcg'))
    ), lines AS (
        SELECT txn_id, date, category_id,
               CASE WHEN rl.account_id NOT IN (SELECT id FROM accounts WHERE currency <> "#,
    crate::home_sql!(),
    r#")
                    THEN rl.native_cents ELSE "#,
    // No join to accounts: an account kept in another currency is looked up
    // only for its own rows. A per-row join here lets SQLite's planner, once
    // the file has statistics, walk every account's rows by index instead —
    // several times slower — and costs every all-dollar file a lookup per row.
    // Qualified: inside the rate lookup a bare `currency` or `date` would
    // name the exchange_rates row's own column and match every rate.
    crate::to_home_at_sql!("rl.native_cents", "(SELECT fa.currency FROM accounts fa WHERE fa.id = rl.account_id)", "rl.date"),
    r#" END AS amount_cents
          FROM raw_lines rl
    )
"#);

pub(super) fn map_txn(row: &Row) -> rusqlite::Result<Transaction> {
    Ok(Transaction {
        id: row.get(0)?,
        account_id: row.get(1)?,
        date: row.get(2)?,
        payee: row.get(3)?,
        category_id: row.get(4)?,
        amount_cents: row.get(5)?,
        is_reconciled: row.get::<_, i64>(6)? != 0,
        notes: row.get(7)?,
    })
}
