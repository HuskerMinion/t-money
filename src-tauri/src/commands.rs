//! Tauri IPC commands. Each is a thin wrapper over `db::queries` (or the
//! import / keyring modules) that maps errors to a `String` the frontend can
//! display.
//!
//! The connection pool lives in `AppState.pool` as a `Mutex<Option<DbPool>>`.
//! Every read/write command locks the pool, pulls a connection, and runs the
//! query while holding the lock (fine for a single-user desktop app). The
//! restore / master-key commands drop the pool (`None`) to release the OS file
//! handles, mutate the DB file, then rebuild it.

use crate::db::pool::{self, DbPool};
use crate::db::undo;
use crate::db::classes;
use crate::db::lots;
use crate::db::plan;
use crate::db::queries;
use crate::import;
use crate::keyring;
use crate::models::{
    Attachment,
    UsedText,
    AutobudgetLine,
    ClassPick, Classification, ClassificationValue,
    Performance,
    RoiPeriod,
    HoldingChange,
    MergeSummary,
    StatementHolding,
    Account, BackupConfig, Budget, CashForecast, Category, CategoryBudget, CommonTransaction,
    DbInfo, Disposal, Goal, ImportSummary, Lot, NewInvestmentTransaction, Portfolio, Security, SecurityPrice,
    KeyStatus, NewCommonTransaction, NewRecurrence, NewTransaction, Occurrence, Payee,
    Recurrence, RegisterRow, Report, ReportGalleryEntry, ReportRequest, SavedReport, SearchHit,
    PriceRefreshSummary, PriceStatus, SeedSummary, Split, Statement, Transaction, UpdateTransaction,
};
use crate::backup;
use crate::prices;
use crate::state::AppState;
use rusqlite::OptionalExtension;
use tauri::State;

/// Lock the pool and hand back a live connection. The guard must outlive the
/// connection, so callers keep `guard` in scope until the query completes.
/// The open file's path. Cloned out of the lock rather than borrowed —
/// every caller wants an owned path and holding the lock across file IO is
/// how a UI freezes.
fn db_path_of(state: &State<AppState>) -> Result<std::path::PathBuf, String> {
    state.db_path.lock().map(|p| p.clone()).map_err(|_| "state lock poisoned".to_string())
}

fn key_account_of(state: &State<AppState>) -> Result<String, String> {
    state.key_account.lock().map(|a| a.clone()).map_err(|_| "state lock poisoned".to_string())
}

/// What a command says when there is no file open. The UI shows the
/// start screen instead of calling these at all; this is the backstop for a
/// call that gets through anyway, and it must read like something a person
/// wrote.
pub const NO_FILE: &str = "No file is open. Use File → Open, or File → New.";

// ---------------------------------------------------------------------------
// Two sentinels for the two ways an Open can fail on a key.
//
// > *"I want to open my file on another computer but it requires the key. I
// > think the file open for an existing file needs a way to paste the key in."*
//
// The backend has long taken a key; nothing ever passed one, so the only
// way this ended was an error message describing a door with no handle. The
// UI needs to tell "locked" from "broken" apart to know whether to ASK, and a
// message written for a human is the wrong thing to branch on — it is one
// reword away from a dialog that silently stops appearing. So the two cases
// that mean "ask for a key" say so in a token, and the sentence for the human
// follows it.
// ---------------------------------------------------------------------------

/// The file is fine; this computer has no key that opens it.
pub const NEEDS_KEY: &str = "NEEDS_KEY";
/// A key was supplied and it does not decrypt the file.
pub const WRONG_KEY: &str = "WRONG_KEY";

/// SQLCipher cannot report a wrong key as such — a file it cannot decrypt does
/// not look like a database at all, and that is the error SQLite raises. Both
/// spellings, because which one appears depends on where in the open it fails.
fn is_undecryptable(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("file is not a database") || e.contains("file is encrypted or is not a database")
}

fn with_conn<'a>(
    state: &'a State<AppState>,
) -> Result<
    (
        std::sync::MutexGuard<'a, Option<DbPool>>,
        r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>,
    ),
    String,
> {
    let guard = state
        .pool
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    // This is what every command says when File → Close has left the
    // app with no file open. It is a sentence the user can act on, because
    // it reaches the screen — "database pool not initialized" did not.
    let pool = guard
        .as_ref()
        .ok_or_else(|| NO_FILE.to_string())?;
    let conn = pool.get().map_err(|e| format!("pool error: {e}"))?;
    // Every message this command writes uses the open file's home currency
    // and region.
    let setting = |key: &str| -> Option<String> {
        conn.prepare_cached("SELECT value FROM app_settings WHERE key = ?1")
            .and_then(|mut st| st.query_row([key], |r| r.get(0)))
            .ok()
    };
    crate::region::set_display(
        setting(crate::currency::HOME_KEY).as_deref(),
        setting(crate::region::REGION_KEY).as_deref(),
    );
    Ok((guard, conn))
}

/// Drop the pool (releasing file handles), then rebuild it from the keyring
/// key. Used after restore and after a master-key change.
fn rebuild_pool(state: &State<AppState>) -> Result<(), String> {
    // The OPEN file's key, not "the" key. With several files, the global
    // account is only right for the app's own database.
    let key = keyring::get_key_in(&key_account_of(state)?).map_err(|e| format!("keyring get failed: {e}"))?;
    let pool = pool::init_pool(&db_path_of(&state)?, &key)
        .map_err(|e| format!("database init failed: {e}"))?;
    let mut guard = state
        .pool
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    *guard = Some(pool);
    Ok(())
}

// ── Accounts ───────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub fn get_favorite_accounts(state: State<AppState>) -> Result<Vec<Account>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::get_favorite_accounts(&conn)
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_all_accounts(state: State<AppState>) -> Result<Vec<Account>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::get_all_accounts(&conn)
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_account(
    state: State<AppState>,
    name: String,
    account_type: String,
    opening_balance_cents: i64,
    opened_on: Option<String>,
    currency: Option<String>,
) -> Result<Account, String> {
    let (_g, conn) = with_conn(&state)?;
    let currency = match currency {
        Some(c) => c,
        None => queries::home_currency(&conn)?,
    };
    queries::create_account_in(&conn, &name, &account_type, opening_balance_cents, opened_on.as_deref(), &currency)
}

/// Change the currency an account is kept in, without converting its
/// amounts (`queries::set_account_currency` says when it is refused). Not
/// undoable, so the undo stack is emptied, as for any write undo cannot take
/// back.
#[tauri::command(rename_all = "camelCase")]
pub fn set_account_currency(state: State<AppState>, id: String, currency: String) -> Result<Account, String> {
    let (_g, conn) = with_conn(&state)?;
    let before = queries::get_account(&conn, &id)?.currency;
    let out = queries::set_account_currency(&conn, &id, &currency)?;
    if out.currency != before {
        undo_stack_invalidated(&state)?;
    }
    Ok(out)
}

/// The currencies an account can be kept in.
#[tauri::command(rename_all = "camelCase")]
pub fn list_currencies() -> Vec<crate::currency::Currency> {
    crate::currency::CURRENCIES.to_vec()
}

/// The regions a file can write its numbers and dates for.
#[tauri::command(rename_all = "camelCase")]
pub fn list_regions() -> Vec<crate::region::Region> {
    crate::region::REGIONS.to_vec()
}

/// The open file's home currency and region.
#[tauri::command(rename_all = "camelCase")]
pub fn get_file_format(state: State<AppState>) -> Result<crate::models::FileFormat, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::file_format(&conn)
}

/// Write the file's numbers and dates the way `region` does.
#[tauri::command(rename_all = "camelCase")]
pub fn set_region(state: State<AppState>, region: String) -> Result<crate::models::FileFormat, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::set_region(&conn, &region)?;
    queries::file_format(&conn)
}

/// Make `currency` the file's home currency; `relabel` says the accounts in
/// the old one were really in the new one (`queries::set_home_currency`).
/// Relabeling is not undoable, so the undo stack is emptied when it happens.
#[tauri::command(rename_all = "camelCase")]
pub fn set_home_currency(state: State<AppState>, currency: String, relabel: bool) -> Result<crate::models::FileFormat, String> {
    let (_g, conn) = with_conn(&state)?;
    let before = queries::home_currency(&conn)?;
    queries::set_home_currency(&conn, &currency, relabel)?;
    let out = queries::file_format(&conn)?;
    if out.home_currency != before {
        undo_stack_invalidated(&state)?;
    }
    Ok(out)
}

/// Every exchange rate in the file.
#[tauri::command(rename_all = "camelCase")]
pub fn list_exchange_rates(state: State<AppState>) -> Result<Vec<crate::models::ExchangeRate>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::list_rates(&conn)
}

/// Record a rate typed by the user: `rate` is dollars per one unit, as text
/// ("1.0875"), so it is read as a decimal, never a float.
#[tauri::command(rename_all = "camelCase")]
pub fn set_exchange_rate(state: State<AppState>, currency: String, date: String, rate: String) -> Result<(), String> {
    let micro = queries::parse_rate(&rate)?;
    let (_g, conn) = with_conn(&state)?;
    queries::set_rate(&conn, &currency, &date, micro, "manual").map(|_| ())
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_exchange_rate(state: State<AppState>, currency: String, date: String) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::delete_rate(&conn, &currency, &date)
}

/// Fetch today's rate for each currency named — or, with none named, each
/// currency an account is kept in — from the same quote source as share
/// prices. Only ever run when the user asks; nothing fetches on its own.
/// A failure for one currency is reported and the rest still run, unless the
/// source cannot be reached at all.
#[tauri::command(rename_all = "camelCase")]
pub async fn fetch_exchange_rates(
    state: State<'_, AppState>,
    currencies: Option<Vec<String>>,
) -> Result<PriceRefreshSummary, String> {
    let started_on = db_path_of(&state)?;
    let (home, in_use) = {
        let (_g, conn) = with_conn(&state)?;
        (queries::home_currency(&conn)?, queries::currencies_in_use(&conn)?)
    };
    let wanted: Vec<String> = match currencies.filter(|c| !c.is_empty()) {
        Some(list) => list
            .iter()
            .map(|c| crate::currency::validate(c).map(str::to_string))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|c| *c != home)
            .collect(),
        None => in_use,
    };
    let today = chrono::Local::now().date_naive();
    let mut summary = prices::empty_summary();
    let total = wanted.len();
    for (i, code) in wanted.into_iter().enumerate() {
        let sym = crate::currency::rate_symbol(&code, &home);
        let quote_in = home.clone();
        let fetched = tauri::async_runtime::spawn_blocking(move || prices::quote_dated_in(&sym, today, &quote_in))
            .await
            .map_err(|e| format!("rate lookup did not run: {e}"))?;
        let quote = match fetched {
            Ok(q) => q,
            Err(e) => {
                let unreachable = e.is_source();
                prices::fail(&mut summary, &code, e.message());
                if unreachable {
                    let rest = total - i - 1;
                    if rest > 0 {
                        prices::fail(&mut summary, "", format!("{rest} more not tried — the rate source could not be reached"));
                    }
                    break;
                }
                continue;
            }
        };
        let micro = match queries::decimal_to_micro(quote.price) {
            Ok(m) => m,
            Err(e) => {
                prices::fail(&mut summary, &code, e);
                continue;
            }
        };
        // The file may have been switched — or closed — while the fetch
        // ran. Checked while holding the pool, so no switch can land between
        // the check and the write; a closed file ends the run with what was
        // already saved.
        let Ok((_g, conn)) = with_conn(&state) else {
            return Ok(summary);
        };
        if !crate::files::is_same(&db_path_of(&state)?, &started_on) {
            return Ok(summary);
        }
        let on = quote.store_date(today).format("%Y-%m-%d").to_string();
        match queries::set_rate_quoted(&conn, &code, &home, &on, micro, "fetched") {
            Ok(true) => summary.updated += 1,
            Ok(false) => prices::fail(&mut summary, &code, format!("kept the rate you typed for {}", crate::region::date(quote.store_date(today)))),
            Err(e) => {
                prices::fail(&mut summary, &code, e);
                // A changed home currency makes every remaining quote wrong.
                if queries::home_currency(&conn)? != home {
                    return Ok(summary);
                }
            }
        }
    }
    Ok(summary)
}

// ---------------------------------------------------------------------------
// SimpleFIN bank sync.
//
// The access URL SimpleFIN hands back holds the user's credential. It lives
// in Windows Credential Manager under the open file, and nothing here ever
// returns it, logs it or writes it to the file: the screen sees the server's
// name only. Nothing is fetched except when the user asks.
// ---------------------------------------------------------------------------

/// The Credential Manager entry holding the open file's SimpleFIN access,
/// or None when this file has never been connected. Named by a random id
/// kept in the file, not by the file's path: a file that is moved or
/// renamed stays connected, and a new file made later at the same path
/// does not inherit someone's bank feed.
fn simplefin_entry(conn: &queries::Conn) -> Result<Option<String>, String> {
    Ok(queries::simplefin_connection_id(conn)?.map(|id| format!("simplefin:{id}")))
}

fn simplefin_access(state: &State<AppState>) -> Result<crate::simplefin::Access, String> {
    let entry = {
        let (_g, conn) = with_conn(state)?;
        simplefin_entry(&conn)?
    };
    match entry.filter(|e| keyring::has_key_in(e)) {
        Some(e) => crate::simplefin::parse_access(&keyring::get_key_in(&e)?),
        None => Err("This file is not connected to SimpleFIN on this computer. Paste a setup token in Settings → Money → Bank sync.".to_string()),
    }
}

fn local_today() -> chrono::NaiveDate {
    chrono::Local::now().date_naive()
}

fn status_with(state: &State<AppState>, messages: Vec<String>) -> Result<crate::models::SimplefinStatus, String> {
    let (_g, conn) = with_conn(state)?;
    let entry = simplefin_entry(&conn)?.filter(|e| keyring::has_key_in(e));
    let server = entry
        .as_deref()
        .and_then(|e| keyring::get_key_in(e).ok())
        .and_then(|a| crate::simplefin::parse_access(&a).ok())
        .map(|a| a.host());
    Ok(crate::models::SimplefinStatus {
        connected: entry.is_some(),
        server,
        accounts: queries::list_simplefin_accounts(&conn)?,
        requests_today: queries::simplefin_requests_today(&conn, chrono::Utc::now().timestamp())?,
        daily_limit: crate::simplefin::DAILY_REQUESTS,
        messages,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn simplefin_status(state: State<AppState>) -> Result<crate::models::SimplefinStatus, String> {
    status_with(&state, Vec::new())
}

/// Ask SimpleFIN for its accounts and balances (no transactions) and record
/// them. Counted against the day's requests. Returns SimpleFIN's own
/// messages, which the screen must show.
async fn simplefin_list_accounts(state: &State<'_, AppState>) -> Result<Vec<String>, String> {
    let started_on = db_path_of(state)?;
    let access = simplefin_access(state)?;
    {
        let (_g, conn) = with_conn(state)?;
        queries::take_simplefin_request(&conn, chrono::Utc::now().timestamp())?;
    }
    // Balances only: the dates are not sent.
    let body = tauri::async_runtime::spawn_blocking(move || crate::simplefin::fetch_accounts(&access, 0, 0, true))
        .await
        .map_err(|_| "The request to SimpleFIN did not run. Try again.".to_string())??;
    let set = crate::simplefin::parse_account_set(&body)?;
    let (_g, conn) = with_conn(state)?;
    if !crate::files::is_same(&db_path_of(state)?, &started_on) {
        return Err("A different file was opened while SimpleFIN answered, so nothing was saved.".to_string());
    }
    queries::upsert_simplefin_accounts(&conn, &set)?;
    Ok(set.messages)
}

/// Connect the open file: claim the setup token (which works once), keep the
/// access it returns in Credential Manager, and list the accounts.
#[tauri::command(rename_all = "camelCase")]
pub async fn simplefin_connect(state: State<'_, AppState>, setup_token: String) -> Result<crate::models::SimplefinStatus, String> {
    let claim_url = crate::simplefin::decode_setup_token(&setup_token)?;
    // Refuse before claiming when no file is open, or when it is already
    // connected here: a claimed token cannot be claimed again, and a second
    // connection would leave the first one's access working on the server.
    {
        let (_g, conn) = with_conn(&state)?;
        if simplefin_entry(&conn)?.is_some_and(|e| keyring::has_key_in(&e)) {
            return Err("This file is already connected to SimpleFIN. Disconnect it first to use a new token.".to_string());
        }
    }
    let access = tauri::async_runtime::spawn_blocking(move || crate::simplefin::claim(&claim_url))
        .await
        .map_err(|_| "The request to SimpleFIN did not run. Try again.".to_string())??;
    // Checked before it is kept: an access that is not https is refused here.
    crate::simplefin::parse_access(&access)?;
    let entry = {
        let (_g, conn) = with_conn(&state)?;
        format!("simplefin:{}", queries::new_simplefin_connection_id(&conn)?)
    };
    keyring::set_key_in(&entry, &access)
        .map_err(|_| "SimpleFIN connected, but Windows would not keep the connection. Make a new setup token and try again.".to_string())?;
    // The account list is a convenience; the connection stands without it.
    match simplefin_list_accounts(&state).await {
        Ok(messages) => status_with(&state, messages),
        Err(e) => status_with(&state, vec![format!("Connected, but the accounts could not be listed: {e}")]),
    }
}

/// Ask SimpleFIN again which accounts there are, without transactions.
#[tauri::command(rename_all = "camelCase")]
pub async fn simplefin_refresh_accounts(state: State<'_, AppState>) -> Result<crate::models::SimplefinStatus, String> {
    let messages = simplefin_list_accounts(&state).await?;
    status_with(&state, messages)
}

/// Link a SimpleFIN account to a T-Money account, or unlink it (`None`).
#[tauri::command(rename_all = "camelCase")]
pub fn simplefin_link(state: State<AppState>, sf_id: String, account_id: Option<String>) -> Result<crate::models::SimplefinStatus, String> {
    {
        let (_g, conn) = with_conn(&state)?;
        queries::link_simplefin_account(&conn, &sf_id, account_id.as_deref())?;
    }
    simplefin_status(state)
}

/// Forget the connection: the credential leaves Credential Manager and the
/// account list leaves the file. Transactions already fetched stay.
#[tauri::command(rename_all = "camelCase")]
pub fn simplefin_disconnect(state: State<AppState>) -> Result<crate::models::SimplefinStatus, String> {
    let entry = {
        let (_g, conn) = with_conn(&state)?;
        simplefin_entry(&conn)?
    };
    // The credential goes first: if Windows will not remove it, the links
    // stay too, and the screen still says it is connected.
    if let Some(e) = entry {
        keyring::delete_key_in(&e)?;
    }
    {
        let (_g, conn) = with_conn(&state)?;
        queries::clear_simplefin(&conn)?;
    }
    simplefin_status(state)
}

/// Get bank transactions: one request for every linked account, from a few
/// days before the newest bank row already in the register — the earliest
/// such date across the linked accounts, or 88 days back when one has none —
/// written through the ordinary import path as one Undo step.
///
/// The register, not the date of the last fetch, decides where to start:
/// a fetch that was undone took its rows with it, and the next fetch has to
/// reach back for them again.
#[tauri::command(rename_all = "camelCase")]
pub async fn simplefin_sync(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<crate::models::SimplefinSync, String> {
    let started_on = db_path_of(&state)?;
    let access = simplefin_access(&state)?;
    let today = local_today();
    let linked: Vec<Option<chrono::NaiveDate>> = {
        let (_g, conn) = with_conn(&state)?;
        queries::list_simplefin_accounts(&conn)?
            .into_iter()
            .filter_map(|a| a.account_id)
            .map(|id| {
                queries::latest_feed_date(&conn, &id)
                    .map(|d| d.and_then(|d| chrono::NaiveDate::parse_from_str(&d, "%Y-%m-%d").ok()))
            })
            .collect::<Result<_, _>>()?
    };
    if linked.is_empty() {
        return Err("No SimpleFIN account is linked to a T-Money account yet. Pick one for each in the list first.".to_string());
    }
    // The earliest need decides the window; a never-fetched link needs it all.
    let since = if linked.iter().any(Option::is_none) { None } else { linked.into_iter().flatten().min() };
    let windows = crate::simplefin::request_windows(today, since);
    let start = windows.first().map(|w| w.0).unwrap_or_default();
    {
        let (_g, conn) = with_conn(&state)?;
        queries::take_simplefin_requests(&conn, chrono::Utc::now().timestamp(), windows.len() as u32)?;
    }
    // Oldest first; each reply folded into the one before it.
    let mut set = crate::simplefin::AccountSet::default();
    for (s, e) in windows {
        let access = access.clone();
        let body = tauri::async_runtime::spawn_blocking(move || crate::simplefin::fetch_accounts(&access, s, e, false))
            .await
            .map_err(|_| "The request to SimpleFIN did not run. Try again.".to_string())??;
        crate::simplefin::merge_sets(&mut set, crate::simplefin::parse_account_set(&body)?);
    }
    let from = crate::simplefin::utc_date(start).unwrap_or_default();
    let today_s = today.to_string();
    importing(&state, "get bank transactions", || {
        let guard = state.pool.lock().map_err(|_| "state lock poisoned".to_string())?;
        // The file may have been switched while SimpleFIN answered. Checked
        // while holding the pool, so no switch can land before the write.
        if !crate::files::is_same(&db_path_of(&state)?, &started_on) {
            return Err("A different file was opened while SimpleFIN answered, so nothing was imported.".to_string());
        }
        let pool = guard.as_ref().ok_or_else(|| NO_FILE.to_string())?;
        // Which account is importing, for the progress bar. A lost event
        // costs a frame of the bar, nothing more.
        use tauri::Emitter;
        let mut progress = |done: usize, total: usize, account: &str| {
            let _ = app.emit("tm://simplefin-progress", serde_json::json!({ "done": done, "total": total, "account": account }));
        };
        crate::simplefin::apply_fetch(pool, &set, &today_s, &from, &mut progress)
    })
}

/// Deleting an account empties the undo stack.
///
/// Deleting an account is not undoable and is not going to be (`undo.rs`'s
/// header says why: it takes every transaction in the account with it, and
/// something that consequential should stay confirm-then-commit). The undo rule
/// is the other half of that decision and was never applied here: a write
/// that cannot be undone must invalidate what came before it, or Ctrl+Z
/// reaches straight PAST the delete and takes back the unrelated edit you
/// made ten minutes ago — while the delete stays.
///
/// The stack is emptied only on success. A delete that failed changed
/// nothing, and throwing away a usable undo history over it would be a second
/// loss caused by the first.
#[tauri::command(rename_all = "camelCase")]
pub fn delete_account(state: State<AppState>, id: String) -> Result<(), String> {
    {
        let (_g, conn) = with_conn(&state)?;
        queries::delete_account(&conn, &id)?;
    }
    undo_stack_invalidated(&state)?;
    Ok(())
}

/// And so does merging two accounts, for the same reason.
///
/// A merge re-points every row of one account into another and then deletes
/// the empty one. It is at least as consequential as a delete and is equally
/// absent from the stack. `dry_run` is the preview the dialog runs before the
/// button is pressed and writes nothing, so it must leave the stack alone —
/// graying out Undo because somebody OPENED a dialog would be its own bug.
#[tauri::command(rename_all = "camelCase")]
pub fn merge_accounts(
    state: State<AppState>,
    into_id: String,
    from_id: String,
    after_last: bool,
    dry_run: bool,
) -> Result<MergeSummary, String> {
    let summary = {
        let (_g, conn) = with_conn(&state)?;
        queries::merge_accounts(&conn, &into_id, &from_id, after_last, dry_run)?
    };
    if !dry_run {
        undo_stack_invalidated(&state)?;
    }
    Ok(summary)
}

/// A small per-file setting the frontend owns (for example the Debt Reduction
/// Planner's rates and minimums). Keys are namespaced so nothing here can
/// reach the backup or key settings.
#[tauri::command(rename_all = "camelCase")]
pub fn get_ui_setting(state: State<AppState>, key: String) -> Result<Option<String>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::get_setting(&conn, &format!("ui.{key}"))
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_ui_setting(state: State<AppState>, key: String, value: String) -> Result<(), String> {
    if key.is_empty() || key.len() > 64 || value.len() > 64 * 1024 {
        return Err("setting key or value out of range".into());
    }
    let (_g, conn) = with_conn(&state)?;
    queries::set_setting(&conn, &format!("ui.{key}"), &value)
}

/// Money's "Export an account as QIF": the register written to
/// `path`. Returns (records written, void rows left out).
#[tauri::command(rename_all = "camelCase")]
pub fn export_qif(state: State<AppState>, account_id: String, path: String) -> Result<(u32, u32), String> {
    let (_g, conn) = with_conn(&state)?;
    let q = crate::import::qif_export::export_account(&conn, &account_id)?;
    std::fs::write(&path, q.text).map_err(|e| format!("could not write {path}: {e}"))?;
    Ok((q.records, q.voided))
}

/// Per-transaction tax line: null follows the category, "" takes the
/// row out of the tax reports, a line name puts it on that line.
#[tauri::command(rename_all = "camelCase")]
pub fn set_transaction_tax_line(state: State<AppState>, transaction_id: String, tax_line: Option<String>) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::set_transaction_tax_line(&conn, &transaction_id, tax_line.as_deref())
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_holdings(
    state: State<AppState>,
    account_id: String,
    date: String,
    lines: Vec<StatementHolding>,
    dry_run: bool,
) -> Result<Vec<HoldingChange>, String> {
    let (_g, conn) = with_conn(&state)?;
    let changes = queries::update_holdings(&conn, &account_id, &date, &lines, dry_run)?;
    // The real run writes buys and sells no undo step photographs, so
    // an older step restored after it would put back balances that no longer
    // hold. The preview writes nothing and keeps the stack.
    if !dry_run {
        undo_stack_invalidated(&state)?;
    }
    Ok(changes)
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_favorite(
    state: State<AppState>,
    account_id: String,
    is_favorite: bool,
) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::set_favorite(&conn, &account_id, is_favorite)
}

// ── Transactions ───────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub fn get_transactions(
    state: State<AppState>,
    account_id: String,
    limit: Option<i64>,
) -> Result<Vec<Transaction>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::get_transactions(&conn, &account_id, limit)
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_transaction(
    state: State<AppState>,
    payload: NewTransaction,
) -> Result<Transaction, String> {
    let (_g, conn) = with_conn(&state)?;
    // Recorded so Edit → Undo can take it back. The id does not exist
    // yet, so there is nothing to photograph beforehand; `recording` widens
    // the "before" to cover whatever gets created, which is what makes undo
    // of a create a deletion of exactly that row.
    // The split lines, when the form sends them, are written inside
    // this same step, so one Enter is one Ctrl+Z.
    let (out, step) = undo::recording(&conn, "add a transaction", &[], || {
        queries::create_transaction_with_splits(&conn, &payload)
    })?;
    let mut step = step;
    // The created row is only knowable after the fact.
    let made = undo::related_ids(&conn, &out.id)?;
    step.after = undo::snapshot(&conn, &made)?;
    step.before.txn_ids = made;
    push_undo(&state, step)?;
    Ok(out)
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_transaction(
    state: State<AppState>,
    payload: UpdateTransaction,
) -> Result<Transaction, String> {
    let (_g, conn) = with_conn(&state)?;
    let ids = undo::related_ids(&conn, &payload.id)?;
    // The split lines, when the form sends them, are replaced inside
    // this same step (lines first, then the edit), so one Enter is one Ctrl+Z.
    let (out, step) = undo::recording(&conn, "edit a transaction", &ids, || {
        queries::update_transaction_with_splits(&conn, &payload)
    })?;
    push_undo(&state, step)?;
    Ok(out)
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_transaction(state: State<AppState>, id: String) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    let ids = undo::related_ids(&conn, &id)?;
    let (_, step) = undo::recording(&conn, "delete a transaction", &ids, || {
        queries::delete_transaction(&conn, &id)
    })?;
    push_undo(&state, step)?;
    Ok(())
}

/// The account register: every transaction oldest→newest with a running
/// balance column, exactly like MS Money's register.
#[tauri::command(rename_all = "camelCase")]
pub fn get_register(
    state: State<AppState>,
    account_id: String,
) -> Result<Vec<RegisterRow>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::get_register(&conn, &account_id)
}

// ── Categories ─────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub fn list_categories(state: State<AppState>) -> Result<Vec<Category>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::list_categories(&conn)
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_category(
    state: State<AppState>,
    name: String,
    kind: String,
    parent_id: Option<String>,
    tax_line: Option<String>,
) -> Result<Category, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::create_category(
        &conn,
        &name,
        &kind,
        parent_id.as_deref(),
        tax_line.as_deref(),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_category(
    state: State<AppState>,
    id: String,
    name: String,
    kind: String,
    parent_id: Option<String>,
    tax_line: Option<String>,
) -> Result<Category, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::update_category(
        &conn,
        &id,
        &name,
        &kind,
        parent_id.as_deref(),
        tax_line.as_deref(),
    )
}

/// Delete a category. `reassignTo` refiles everything that used it; omit it to
/// leave those transactions uncategorized.
///
/// Undoable, like the merge it now shares a body with. It was neither
/// undoable nor did it empty the stack, so Ctrl+Z after a delete reached past
/// it and took back whatever came before.
#[tauri::command(rename_all = "camelCase")]
pub fn delete_category(
    state: State<AppState>,
    id: String,
    reassign_to: Option<String>,
) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    let step = queries::delete_category(&conn, &id, reassign_to.as_deref())?;
    push_undo(&state, step)
}

/// Add Money's standard chart of categories, skipping anything already
/// present. Returns the number created — 0 means nothing was missing.
#[tauri::command(rename_all = "camelCase")]
pub fn seed_standard_categories(state: State<AppState>) -> Result<usize, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::seed_standard_categories(&conn)
}

/// What a merge is about to do, asked before it is done.
///
/// The dialog calls this each time the destination changes, so the sentence
/// it shows names both sides and the counts, and a merge the backend would
/// refuse is refused in the dialog rather than on the button press.
#[tauri::command(rename_all = "camelCase")]
pub fn preview_category_merge(
    state: State<AppState>,
    from_id: String,
    into_id: String,
) -> Result<queries::MergePreview, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::preview_merge(&conn, &from_id, &into_id)
}

/// Undoable, because a user asked for it: which way a merge went
/// was not obvious, and getting it backwards looked permanent without a
/// backup taken just before.
#[tauri::command(rename_all = "camelCase")]
pub fn merge_categories(
    state: State<AppState>,
    from_id: String,
    into_id: String,
) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    let step = queries::merge_categories(&conn, &from_id, &into_id)?;
    push_undo(&state, step)
}

// ── Budgets & spending ─────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub fn get_spending_summary(
    state: State<AppState>,
    month: String,
) -> Result<Vec<CategoryBudget>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::get_spending_summary(&conn, &month)
}

// `set_budget_line` was a tauri command and is not any more. The
// Budget screen it served became a reading when the year plan took over the
// typing, and `reachability.test.ts` will not have a wrapper nothing calls.
//
// `queries::set_budget_line` is untouched and still the guarded write: it is
// what `set_budget` below goes through, and it is where the envelope rule
// runs.

/// Everything the Budget screen draws, in one call.
#[tauri::command(rename_all = "camelCase")]
pub fn get_budget_grid(
    state: State<AppState>,
    month: String,
) -> Result<crate::models::BudgetGrid, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::budget_grid(&conn, &month)
}

/// A budget to start from: the top-level categories this household
/// actually spends on, ranked by cost, with an amount proposed for each.
/// Nothing is written; `apply_autobudget` does that, and takes these lines.
#[tauri::command(rename_all = "camelCase")]
pub fn get_budget_starter(
    state: State<AppState>,
    month: String,
    lookback: Option<u32>,
    limit: Option<u32>,
) -> Result<Vec<crate::models::AutobudgetLine>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::budget_starter(&conn, &month, lookback.unwrap_or(12), limit.unwrap_or(12))
}

// ── The year plan ───────────────────────────────────────────────────

/// The whole Budget screen for one year, in one answer.
///
/// `today` is not a parameter: the elapsed-month count is a property of the
/// calendar, not of the caller, and letting the frontend send it would let a
/// stale clock in one component disagree with another about how much of the
/// year has happened. `db::plan::year_plan` takes it so tests can stand in
/// the middle of a year; this is the one place that reads the real clock.
#[tauri::command(rename_all = "camelCase")]
pub fn get_year_plan(state: State<AppState>, year: i32) -> Result<crate::models::YearPlan, String> {
    let (_g, conn) = with_conn(&state)?;
    let today = chrono::Local::now().date_naive().to_string();
    plan::year_plan(&conn, year, &today)
}

/// Set one line's plan: an annual figure and the months it runs.
///
/// Returns the line as written and any parent this pushed up, so the screen
/// can say what it did rather than leaving a number to change by itself.
///
/// `spread` is "spent" or "aside": whether the `months` mask names
/// the months this is SPENT in (divide the annual figure by them) or the
/// months the bill is DUE (divide by twelve, because the monthly figure is
/// what is set aside). `None` means "spent", so a caller written against
/// the first year plan keeps the behavior it was written for.
///
/// Kept out of the parameter list on purpose: `ipcContract.test.ts` reads
/// these parameters out of this file, and a comment among them is parsed as
/// an argument name.
#[tauri::command(rename_all = "camelCase")]
pub fn set_budget_plan(
    state: State<AppState>,
    category_id: String,
    year: i32,
    annual_cents: i64,
    months: String,
    spread: Option<String>,
) -> Result<crate::models::PlanWrite, String> {
    let (_g, conn) = with_conn(&state)?;
    plan::set_plan(
        &conn,
        &category_id,
        year,
        annual_cents,
        &months,
        spread.as_deref().unwrap_or(plan::SPENT),
    )
}

/// Remove a line's plan, and the monthly rows that came from it.
/// Different from a plan of zero, which is a real budget of nothing.
#[tauri::command(rename_all = "camelCase")]
pub fn clear_budget_plan(
    state: State<AppState>,
    category_id: String,
    year: i32,
) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    plan::clear_plan(&conn, &category_id, year)
}

/// Read one year and propose the next. Writes nothing.
#[tauri::command(rename_all = "camelCase")]
pub fn plan_from_history(
    state: State<AppState>,
    from_year: i32,
    to_year: i32,
) -> Result<Vec<crate::models::PlanProposal>, String> {
    let (_g, conn) = with_conn(&state)?;
    let today = chrono::Local::now().date_naive().to_string();
    plan::from_history(&conn, from_year, to_year, &today)
}

/// Write the proposals that came back ticked, and rebuild the year's
/// monthly rows once rather than once per line.
#[tauri::command(rename_all = "camelCase")]
pub fn apply_year_plan(
    state: State<AppState>,
    year: i32,
    lines: Vec<crate::models::PlanPick>,
) -> Result<u32, String> {
    let (_g, conn) = with_conn(&state)?;
    let picks: Vec<(String, i64, String, String)> = lines
        .into_iter()
        .map(|l| {
            let spread = l.spread.unwrap_or_else(|| plan::SPENT.to_string());
            (l.category_id, l.annual_cents, l.months, spread)
        })
        .collect();
    plan::apply_proposals(&conn, year, &picks)
}

/// The old single-budget write, kept because `useBudgetStore` and any
/// saved script still name it.
///
/// It now goes through `set_budget_line` rather than straight at
/// `queries::set_budget`, which wrote the row and ran no envelope rule at
/// all. Two commands that write the same table, one of them keeping the
/// envelope rule and one of them not, is a bug waiting for
/// whichever caller picks the wrong one — and the low-level `queries::
/// set_budget` stays as it is because demo seeding wants exactly that: a row
/// and no consequences.
///
/// The return stays `Budget` so the command's shape is unchanged; the raise
/// is applied, just not reported here. Anything that wants to SAY what moved
/// should call `set_budget_line`.
///
/// The existing period is read and passed back in rather than defaulted:
/// this command has never been able to express one, and `set_budget_line`
/// WRITES whatever it is given, so passing a flat "monthly" would silently
/// demote a category that was being budgeted by the year.
#[tauri::command(rename_all = "camelCase")]
pub fn set_budget(
    state: State<AppState>,
    category_id: String,
    target_cents: i64,
    month_year: String,
) -> Result<Budget, String> {
    let (_g, conn) = with_conn(&state)?;
    let period: String = conn
        .query_row(
            "SELECT period FROM budgets WHERE category_id = ?1 AND month_year = ?2",
            rusqlite::params![category_id, month_year],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "monthly".to_string());
    queries::set_budget_line(&conn, &category_id, target_cents, &month_year, &period)
        .map(|w| w.budget)
}

#[tauri::command(rename_all = "camelCase")]
pub fn autobudget(state: State<AppState>, month: String, lookback: u32) -> Result<Vec<AutobudgetLine>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::autobudget(&conn, &month, lookback)
}

#[tauri::command(rename_all = "camelCase")]
pub fn apply_autobudget(
    state: State<AppState>,
    month: String,
    months: u32,
    lines: Vec<(String, i64)>,
) -> Result<u32, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::apply_autobudget(&conn, &month, months, &lines)
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_budgets(state: State<AppState>, month_year: String) -> Result<Vec<Budget>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::list_budgets(&conn, &month_year)
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_budget(state: State<AppState>, id: String) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::delete_budget(&conn, &id)
}

// ── Goals ──────────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub fn list_goals(state: State<AppState>) -> Result<Vec<Goal>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::list_goals(&conn)
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_goal(
    state: State<AppState>,
    name: String,
    target_cents: i64,
    saved_cents: i64,
    deadline: Option<String>,
    notes: Option<String>,
    account_id: Option<String>,
) -> Result<Goal, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::create_goal(
        &conn,
        &name,
        target_cents,
        saved_cents,
        deadline.as_deref(),
        notes.as_deref(),
        account_id.as_deref(),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_goal(
    state: State<AppState>,
    id: String,
    name: String,
    target_cents: i64,
    saved_cents: i64,
    deadline: Option<String>,
    notes: Option<String>,
    account_id: Option<String>,
) -> Result<Goal, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::update_goal(
        &conn,
        &id,
        &name,
        target_cents,
        saved_cents,
        deadline.as_deref(),
        notes.as_deref(),
        account_id.as_deref(),
    )
}

/// Count this account in tax reports, or not.
///
/// The parameter is `account_id`, not `id`: `rename_all = "camelCase"` makes
/// the wire name `accountId`, which is what `ipc.ts` has always sent. Named
/// `id` it sent `accountId` at a command expecting `id`, every call failed to
/// deserialize, and the checkbox on the Taxes tab silently would not stay
/// ticked — so a retirement account could never be brought into the tax
/// reports. Both sides had tests; neither could see the other. See
/// `ipcContract.test.ts`, which now compares them.
#[tauri::command(rename_all = "camelCase")]
pub fn set_account_tax_included(state: State<AppState>, account_id: String, included: bool) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::set_account_tax_included(&conn, &account_id, included)
}

/// CSV import — look first, then import with the confirmed mapping.
#[tauri::command(rename_all = "camelCase")]
pub fn preview_csv(path: String, has_header: Option<bool>, mapping: Option<crate::import::csv::CsvMapping>) -> Result<crate::import::csv::CsvPreview, String> {
    crate::import::preview_csv(&path, has_header, mapping.as_ref())
}

#[tauri::command(rename_all = "camelCase")]
pub fn import_csv(state: State<AppState>, path: String, account_id: String, mapping: crate::import::csv::CsvMapping) -> Result<ImportSummary, String> {
    importing(&state, "import a CSV", || {
        let guard = state.pool.lock().map_err(|e| e.to_string())?;
        let pool = guard.as_ref().ok_or("database is not open")?;
        crate::import::import_csv(pool, &path, &account_id, &mapping)
    })
}

/// Read a statement and say which rows look like transactions already in
/// the register. Writes nothing; `mapping` is set for a CSV only.
#[tauri::command(rename_all = "camelCase")]
pub fn preview_import(
    state: State<AppState>,
    path: String,
    account_id: String,
    mapping: Option<crate::import::csv::CsvMapping>,
    window_days: Option<u32>,
) -> Result<crate::import::matching::ImportMatchPreview, String> {
    let guard = state.pool.lock().map_err(|e| e.to_string())?;
    let pool = guard.as_ref().ok_or("database is not open")?;
    crate::import::preview_import(pool, &path, &account_id, mapping.as_ref(), window_days.unwrap_or(3))
}

// ── TSP ─────────────────────────────────────────────────────────────

/// What a tsp.gov activity export contains, and what has to be asked about it.
///
/// Read-only: nothing is written, so the dialog can show the collapse, the
/// opening position it worked out, and the payments it needs answers for
/// before anyone commits to anything.
#[tauri::command(rename_all = "camelCase")]
pub fn preview_tsp(
    state: State<AppState>,
    path: String,
    account_id: Option<String>,
) -> Result<crate::import::tsp::Plan, String> {
    use crate::import::tsp;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("could not read {path}: {e}"))?;
    // Once an account is chosen, the preview says what of the
    // opening position is already in it. The dialog re-asks on every
    // account change for exactly this.
    let txns = tsp::collapse(&tsp::read(&text)?);
    let held = tsp_held(&state, account_id.as_deref(), &txns)?;
    tsp::plan(&text, &held)
}

/// What `account_id` already holds of each fund the file touches, on
/// the day before the export begins. Keyed by the plan's own fund name and in
/// its units, so `tsp::net_of_held` can subtract it from the opening the file
/// implies. Empty when no account is named.
fn tsp_held(
    state: &State<AppState>,
    account_id: Option<&str>,
    txns: &[crate::import::tsp::Txn],
) -> Result<std::collections::BTreeMap<String, rust_decimal::Decimal>, String> {
    use crate::import::tsp;
    let mut held = std::collections::BTreeMap::new();
    let Some(account_id) = account_id.filter(|a| !a.trim().is_empty()) else {
        return Ok(held);
    };
    let Some(first) = txns.iter().map(|t| t.date).min() else {
        return Ok(held);
    };
    let open_date = first.pred_opt().unwrap_or(first).to_string();
    let (_g, conn) = with_conn(state)?;
    let by_name = lots::shares_held_by_name(&conn, account_id, &open_date)?;
    let funds: std::collections::BTreeSet<&str> = txns.iter().map(|t| t.fund.as_str()).collect();
    for fund in funds {
        if let Some(micro) = by_name.get(&tsp::security(fund)) {
            if *micro > 0 {
                // Micro-shares are six places, which is the plan's own precision.
                held.insert(fund.to_string(), rust_decimal::Decimal::new(*micro, 6));
            }
        }
    }
    Ok(held)
}

/// Turn the export into transactions, given the answers.
///
/// It builds the QIF the script used to write and hands it to the ordinary
/// importer, rather than writing rows itself. That is deliberate: the QIF path
/// already knows how to create securities, match a transfer to a deposit that
/// is already in the register, and run the treatment dialog. A second way
/// into the ledger would be a second set of those rules to keep in step.
///
/// The prices go in the same way, as a `!Type:Prices` file, so the account's
/// value on any past date is the plan's own number rather than an
/// interpolation.
#[tauri::command(rename_all = "camelCase")]
pub fn import_tsp(
    state: State<AppState>,
    path: String,
    account_id: String,
    cash_account_id: Option<String>,
    splits: Vec<crate::import::tsp::PaymentSplit>,
) -> Result<ImportSummary, String> {
    use crate::import::tsp;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("could not read {path}: {e}"))?;
    let rows = tsp::read(&text)?;
    let txns = tsp::collapse(&rows);
    let (opening, _slivers) = tsp::opening_positions(&txns);

    // Refuse rather than import something that cannot be true. A file whose
    // running balance goes negative is a file we have misread, and the cost
    // of importing it anyway is a register that has to be unpicked by hand.
    let problems = tsp::check(&txns, &opening);
    if !problems.is_empty() {
        return Err(format!(
            "this file does not add up, so nothing was imported:\n{}",
            problems.join("\n")
        ));
    }

    // `check` used the opening the FILE implies, which is the right
    // thing to check the file against. What is WRITTEN is that opening less
    // what the account already holds on the open date: the register, not
    // the file, knows whether those shares are already there.
    let held = tsp_held(&state, Some(&account_id), &txns)?;
    let opening = tsp::net_of_held(&opening, &held);

    // Only asked for when the plan paid something out. A file of
    // contributions and reallocations moves nothing to a bank, so there is
    // no account to name; `build_qif` refuses a file WITH a payment and no
    // account, before anything is written.
    let cash_name = match cash_account_id.as_deref().filter(|id| !id.trim().is_empty()) {
        Some(id) => {
            let (_g, conn) = with_conn(&state)?;
            Some(queries::get_account(&conn, id)?.name)
        }
        None => None,
    };
    let first = txns.iter().map(|t| t.date).min().ok_or("no transactions")?;
    let open_date = first.pred_opt().unwrap_or(first);
    let qif = tsp::build_qif(&txns, &opening, open_date, cash_name.as_deref(), &splits)?;
    let prices = tsp::build_prices(&rows);

    // Beside the export, not in a temp directory: if something goes wrong the
    // user can look at exactly what was handed to the importer.
    let base = std::path::Path::new(&path);
    let stem = base.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "tsp".into());
    let dir = base.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let qif_path = dir.join(format!("{stem}.qif"));
    let prices_path = dir.join(format!("{stem}_prices.qif"));
    std::fs::write(&qif_path, &qif).map_err(|e| format!("could not write {}: {e}", qif_path.display()))?;
    std::fs::write(&prices_path, &prices)
        .map_err(|e| format!("could not write {}: {e}", prices_path.display()))?;

    // Both passes inside ONE undo step. The prices are about
    // securities the transactions just created, so taking back the
    // transactions and leaving the prices would be half an import.
    importing(&state, "import a TSP activity detail", || {
        let guard = state.pool.lock().map_err(|_| "state lock poisoned".to_string())?;
        let pool = guard.as_ref().ok_or("database is not open")?;
        // With the contribution memos' meaning supplied, so every
        // payroll deferral, match and automatic 1% gets its cash side
        // (Retirement Contributions) instead of draining the plan's cash.
        let mut summary = import::import_file_with_rules(pool, &qif_path.to_string_lossy(), &account_id, &tsp::contribution_rules())?;
        // Prices second: they are about securities the transactions just created.
        let priced = import::import_file(pool, &prices_path.to_string_lossy(), &account_id)?;
        summary.imported += priced.imported;
        // A reallocation day's Shares Out / Shares In rows are linked
        // to each other, which is what makes them an exchange to the lot
        // engine: the basis and dates of what went out carry into what came
        // in, instead of the day's price becoming the basis.
        let conn = crate::db::pool::get(pool)?;
        let linked = queries::link_same_day_exchanges(&conn, &account_id, tsp::REALLOC_OUT, tsp::REALLOC_IN)?;
        drop(conn);
        drop(guard);
        if linked > 0 {
            summary.notes.push(format!(
                "{linked} reallocation rows were linked as exchanges within the plan, so cost basis follows the money between funds."
            ));
        }
        summary.notes.push(format!(
            "Wrote {} and {} beside the export, so you can see exactly what was imported.",
            qif_path.display(),
            prices_path.display()
        ));
        Ok(summary)
    })
}

/// Import with the user's answers from the review dialog.
#[tauri::command(rename_all = "camelCase")]
pub fn import_with_decisions(
    state: State<AppState>,
    path: String,
    account_id: String,
    mapping: Option<crate::import::csv::CsvMapping>,
    decisions: Vec<crate::import::matching::RowDecision>,
    memo_rules: Option<Vec<crate::import::plan::MemoRule>>,
) -> Result<ImportSummary, String> {
    importing(&state, "import a statement", || {
        let guard = state.pool.lock().map_err(|e| e.to_string())?;
        let pool = guard.as_ref().ok_or("database is not open")?;
        let summary = crate::import::import_with_decisions(
            pool,
            &path,
            &account_id,
            mapping.as_ref(),
            decisions,
            memo_rules.unwrap_or_default(),
        )?;
        drop(guard);
        Ok(summary)
    })
}

/// What an asset is worth now — a dated revaluation, kept out of every
/// income and spending report.
#[tauri::command(rename_all = "camelCase")]
pub fn set_account_value(
    state: State<AppState>,
    account_id: String,
    date: String,
    value_cents: i64,
    notes: Option<String>,
) -> Result<Option<crate::models::Transaction>, String> {
    let (_g, conn) = with_conn(&state)?;
    // Undoable. It was not, and the first person to fat-finger a
    // valuation had to go and delete the row by hand: "I had an error and I
    // couldn't undo and had to delete."
    //
    // A revaluation is not a plain insert, which is why it needs more care
    // than `create_transaction`. Writing a value for last June ADJUSTS the
    // next revaluation after it — each one asserts what the thing was worth on
    // its own date, so June's correction must not silently push December up by
    // the same amount. That adjusted row is part of what happened and has to
    // be photographed BEFORE the write, or undo would put June back and leave
    // December carrying the difference for ever.
    let touched: Vec<String> = {
        let mut st = conn
            .prepare(
                "SELECT id FROM transactions
                  WHERE account_id = ?1 AND is_revaluation = 1 AND is_void = 0 AND date > ?2
                  ORDER BY date, rowid LIMIT 1",
            )
            .map_err(|e| e.to_string())?;
        let ids: Vec<String> = st
            .query_map(rusqlite::params![&account_id, &date], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        ids
    };
    let (out, step) = undo::recording(&conn, "update a value", &touched, || {
        crate::db::queries::set_account_value(&conn, &account_id, &date, value_cents, notes.as_deref())
    })?;
    // A value that did not change writes nothing, and an undo step for
    // nothing would make Ctrl+Z appear to do something and then not.
    if let Some(made) = &out {
        push_undo(&state, undo::creation_step(&conn, step, &made.id, &touched)?)?;
    }
    Ok(out)
}

/// The asset a debt is borrowed against; None unlinks.
#[tauri::command(rename_all = "camelCase")]
pub fn set_account_security(state: State<AppState>, account_id: String, asset_id: Option<String>) -> Result<(), String> {
    let guard = state.pool.lock().map_err(|e| e.to_string())?;
    let pool = guard.as_ref().ok_or("database is not open")?;
    let conn = pool.get().map_err(|e| e.to_string())?;
    crate::db::queries::set_account_security(&conn, &account_id, asset_id.as_deref())
}

/// What is owed against each asset, for the equity line.
#[tauri::command(rename_all = "camelCase")]
pub fn debts_by_asset(state: State<AppState>) -> Result<std::collections::HashMap<String, i64>, String> {
    let guard = state.pool.lock().map_err(|e| e.to_string())?;
    let pool = guard.as_ref().ok_or("database is not open")?;
    let conn = pool.get().map_err(|e| e.to_string())?;
    crate::db::queries::debts_by_asset(&conn)
}

/// This loan's rate, payment and where each part of it goes. None until
/// the terms have been set.
#[tauri::command(rename_all = "camelCase")]
pub fn get_loan_terms(state: State<AppState>, account_id: String) -> Result<Option<crate::models::LoanTerms>, String> {
    let (_g, conn) = with_conn(&state)?;
    crate::db::loans::get_terms(&conn, &account_id)
}

/// Save this loan's terms, overwriting whatever was there.
#[tauri::command(rename_all = "camelCase")]
pub fn set_loan_terms(state: State<AppState>, terms: crate::models::LoanTerms) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    crate::db::loans::set_terms(&conn, &terms)
}

/// Forget this loan's terms. The account and its history stay.
#[tauri::command(rename_all = "camelCase")]
pub fn clear_loan_terms(state: State<AppState>, account_id: String) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    crate::db::loans::clear_terms(&conn, &account_id)
}

/// The next `count` payments as the terms predict them, starting from
/// what is actually owed today. A starting point to type over, not a promise.
#[tauri::command(rename_all = "camelCase")]
pub fn loan_schedule(
    state: State<AppState>,
    account_id: String,
    from: Option<String>,
    count: Option<u32>,
    terms: Option<crate::models::LoanTerms>,
) -> Result<Vec<crate::models::LoanPeriod>, String> {
    let (_g, conn) = with_conn(&state)?;
    let from = match from {
        Some(d) => d,
        None => chrono::Local::now().date_naive().to_string(),
    };
    let count = count.unwrap_or(12) as usize;
    // With `terms` the dialog is previewing numbers nobody has saved yet, so
    // the stored terms are not read — only the balance, which is real.
    match terms {
        Some(t) => {
            let opening = crate::db::loans::owed(&conn, &account_id)?;
            crate::db::loans::schedule_with(&t, opening, &from, count)
        }
        None => crate::db::loans::schedule(&conn, &account_id, &from, count),
    }
}

/// How the next payment divides at today's balance.
#[tauri::command(rename_all = "camelCase")]
pub fn next_loan_payment(state: State<AppState>, account_id: String, date: Option<String>) -> Result<crate::models::LoanPeriod, String> {
    let (_g, conn) = with_conn(&state)?;
    let date = match date {
        Some(d) => d,
        None => chrono::Local::now().date_naive().to_string(),
    };
    crate::db::loans::next_payment(&conn, &account_id, &date)
}

/// Record a payment as ONE transaction split into interest,
/// principal, extra principal and escrow. Both principal lines reduce the
/// loan, the escrow lands in the escrow account, and only the interest is
/// spending. Whatever is passed is what is recorded — the bank's arithmetic
/// wins over ours, and the register shows the one amount the bank shows.
#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)]
pub fn record_loan_payment(
    state: State<AppState>,
    account_id: String,
    from_account_id: String,
    date: String,
    interest_cents: i64,
    principal_cents: i64,
    escrow_cents: i64,
    extra_principal_cents: i64,
    payee: Option<String>,
    check_number: Option<String>,
    notes: Option<String>,
) -> Result<String, String> {
    let (_g, conn) = with_conn(&state)?;
    // Undoable, like every other way of writing a transaction. This is
    // the one that most needed it: a mortgage payment is one row in the
    // checking account, three split lines, and two transfer rows in two other
    // accounts, so putting a mistake back by hand means finding all of them.
    // `related_ids` follows both `transfer_id` and a split's `transfer_txn_id`,
    // which is exactly the shape this writes.
    let (id, step) = undo::recording(&conn, "record a loan payment", &[], || {
        crate::db::loans::record_payment(
            &conn,
            &account_id,
            &from_account_id,
            &date,
            interest_cents,
            principal_cents,
            escrow_cents,
            extra_principal_cents,
            payee.as_deref().unwrap_or(""),
            check_number.as_deref(),
            notes.as_deref(),
        )
    })?;
    push_undo(&state, undo::creation_step(&conn, step, &id, &[])?)?;
    Ok(id)
}

/// Write text the frontend built (a CSV) to a path the user chose in
/// the save dialog. UTF-8 with a BOM so Eelectric reads accents; nothing else.
#[tauri::command(rename_all = "camelCase")]
pub fn write_text_file(path: String, text: String) -> Result<(), String> {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(text.as_bytes());
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {path}: {e}"))
}

/// Payee rename rules.
#[tauri::command(rename_all = "camelCase")]
pub fn list_payee_rules(state: State<AppState>) -> Result<Vec<crate::models::PayeeRule>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::list_payee_rules(&conn)
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_payee_rule(
    state: State<AppState>,
    match_text: String,
    payee_name: String,
    category_id: Option<String>,
    min_cents: Option<i64>,
    max_cents: Option<i64>,
    memo_contains: Option<String>,
    account_id: Option<String>,
) -> Result<crate::models::PayeeRule, String> {
    let (_g, conn) = with_conn(&state)?;
    let when = crate::models::RuleConditions { min_cents, max_cents, memo_contains, account_id };
    queries::create_payee_rule(&conn, &match_text, &payee_name, category_id.as_deref(), &when)
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_payee_rule(state: State<AppState>, id: String) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::delete_payee_rule(&conn, &id)
}

/// What applying the rules would change, row by row, changing nothing.
#[tauri::command(rename_all = "camelCase")]
pub fn preview_payee_rules(
    state: State<AppState>,
) -> Result<Vec<crate::models::PayeeRuleChange>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::preview_payee_rules(&conn)
}

/// Apply the rules to what is already in the file; returns rows changed.
///
/// Two things it did not do before. It takes the ids the user left
/// ticked in the preview (`None` = all of them, the old behavior), and it
/// goes on the undo stack **as one step**: a bulk edit that can only be taken
/// back one row at a time is not one you would dare run.
#[tauri::command(rename_all = "camelCase")]
pub fn apply_payee_rules(
    state: State<AppState>,
    transaction_ids: Option<Vec<String>>,
) -> Result<u32, String> {
    let (_g, conn) = with_conn(&state)?;

    // Which rows the change will touch has to be known BEFORE it happens, so
    // they can be photographed. The preview is the same computation the apply
    // uses, so this cannot drift from what is about to be written.
    let planned: Vec<String> = queries::preview_payee_rules(&conn)?
        .into_iter()
        .map(|c| c.transaction_id)
        .filter(|id| transaction_ids.as_ref().is_none_or(|ids| ids.contains(id)))
        .collect();
    if planned.is_empty() {
        return Ok(0);
    }

    let (changed, step) = undo::recording(&conn, "rename payees", &planned, || {
        queries::apply_payee_rules_to(&conn, transaction_ids.as_deref())
    })?;
    push_undo(&state, step)?;
    Ok(changed.len() as u32)
}

/// Rows in one account that look entered twice.
#[tauri::command(rename_all = "camelCase")]
pub fn find_duplicates(state: State<AppState>, account_id: String, window_days: u32) -> Result<Vec<crate::models::DuplicateGroup>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::find_duplicates(&conn, &account_id, window_days)
}

/// Read the file back against itself; `repair` recomputes drifted
/// balances and unlinks half transfers.
#[tauri::command(rename_all = "camelCase")]
pub fn verify_file(state: State<AppState>, repair: bool) -> Result<crate::models::FileCheck, String> {
    let (_g, conn) = with_conn(&state)?;
    let check = queries::verify_file(&conn, repair)?;
    // A repair writes rows the undo snapshots never saw.
    if !check.repaired.is_empty() {
        undo_stack_invalidated(&state)?;
    }
    Ok(check)
}

/// How this account's holdings round to the cent; null follows the file.
#[tauri::command(rename_all = "camelCase")]
pub fn set_account_value_rounding(state: State<AppState>, id: String, rounding: Option<String>) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::set_account_value_rounding(&conn, &id, rounding.as_deref())
}

// ---------------------------------------------------------------------------
// Classifications
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub fn list_classifications(state: State<AppState>) -> Result<Vec<Classification>, String> {
    let (_g, conn) = with_conn(&state)?;
    classes::list_classifications(&conn)
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_classification(state: State<AppState>, name: String) -> Result<Classification, String> {
    let (_g, conn) = with_conn(&state)?;
    classes::create_classification(&conn, &name)
}

#[tauri::command(rename_all = "camelCase")]
pub fn rename_classification(state: State<AppState>, id: String, name: String) -> Result<Classification, String> {
    let (_g, conn) = with_conn(&state)?;
    classes::rename_classification(&conn, &id, &name)
}

/// Resolves to the number of transaction / split links that went with it.
#[tauri::command(rename_all = "camelCase")]
pub fn delete_classification(state: State<AppState>, id: String) -> Result<i64, String> {
    let (_g, conn) = with_conn(&state)?;
    let links = classes::delete_classification(&conn, &id)?;
    // The links it took with it are in older undo steps' photographs;
    // restoring one would point a row at a value that no longer exists.
    undo_stack_invalidated(&state)?;
    Ok(links)
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_classification_value(
    state: State<AppState>,
    classification_id: String,
    name: String,
    parent_id: Option<String>,
) -> Result<ClassificationValue, String> {
    let (_g, conn) = with_conn(&state)?;
    classes::create_classification_value(&conn, &classification_id, &name, parent_id.as_deref())
}

#[tauri::command(rename_all = "camelCase")]
pub fn rename_classification_value(state: State<AppState>, id: String, name: String) -> Result<ClassificationValue, String> {
    let (_g, conn) = with_conn(&state)?;
    classes::rename_classification_value(&conn, &id, &name)
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_classification_value(state: State<AppState>, id: String) -> Result<i64, String> {
    let (_g, conn) = with_conn(&state)?;
    let links = classes::delete_classification_value(&conn, &id)?;
    // As `delete_classification`.
    undo_stack_invalidated(&state)?;
    Ok(links)
}

/// A transaction's values, one per axis; a pick with an empty `valueId`
/// clears that axis. Both halves of a transfer are written.
#[tauri::command(rename_all = "camelCase")]
pub fn set_transaction_classes(state: State<AppState>, transaction_id: String, picks: Vec<ClassPick>) -> Result<Vec<ClassPick>, String> {
    let (_g, conn) = with_conn(&state)?;
    // Tagging is an edit like any other from where the user sits — and
    // a mis-picked value on the wrong row is exactly the mis-click undo
    // exists for. The snapshot photographs `transaction_classes` beside the
    // rows, and `related_ids` reaches the transfer partner this writes to.
    let ids = undo::related_ids(&conn, &transaction_id)?;
    let (out, step) = undo::recording(&conn, "change a classification", &ids, || {
        classes::set_transaction_classes(&conn, &transaction_id, &picks)
    })?;
    push_undo(&state, step)?;
    Ok(out)
}

/// Tag a row (or the half of a transfer that landed in the goal's account)
/// for a savings goal; `goalId` null untags.
#[tauri::command(rename_all = "camelCase")]
pub fn set_transaction_goal(state: State<AppState>, transaction_id: String, goal_id: Option<String>) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::set_transaction_goal(&conn, &transaction_id, goal_id.as_deref())
}

/// A transfer into the goal's account, tagged for the goal.
#[tauri::command(rename_all = "camelCase")]
pub fn contribute_to_goal(
    state: State<AppState>,
    goal_id: String,
    from_account_id: String,
    date: String,
    amount_cents: i64,
    notes: Option<String>,
) -> Result<Goal, String> {
    let (_g, conn) = with_conn(&state)?;
    let goal = queries::contribute_to_goal(&conn, &goal_id, &from_account_id, &date, amount_cents, notes.as_deref())?;
    // A transfer no undo step recorded moves two balances; an older
    // step restored past it would put one of them back wrong.
    undo_stack_invalidated(&state)?;
    Ok(goal)
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_goal(state: State<AppState>, id: String) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::delete_goal(&conn, &id)
}

// ── Payments ───────────────────────────────────────────────────────────────
//
// Retired. Migration 0019 folded one-off payments into recurrence rules
// with frequency 'once', so there is one list of upcoming money rather than two
// concepts that both mean "a bill". The `payments` TABLE is deliberately left
// in place rather than dropped: it is the source the migration read, and
// keeping it costs nothing while the new model settles.

// ── Investments: securities, prices, lots ────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub fn list_securities(state: State<AppState>) -> Result<Vec<Security>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::list_securities(&conn)
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_security(
    state: State<AppState>,
    name: String,
    symbol: String,
    kind: String,
    notes: Option<String>,
) -> Result<Security, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::create_security(&conn, &name, &symbol, &kind, notes.as_deref())
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_security(
    state: State<AppState>,
    id: String,
    name: String,
    symbol: String,
    kind: String,
    notes: Option<String>,
) -> Result<Security, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::update_security(&conn, &id, &name, &symbol, &kind, notes.as_deref())
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_security(state: State<AppState>, id: String) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::delete_security(&conn, &id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_security_prices(state: State<AppState>, security_id: String) -> Result<Vec<SecurityPrice>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::list_security_prices(&conn, &security_id)
}

/// A price the user typed. Replaces whatever that day had.
#[tauri::command(rename_all = "camelCase")]
pub fn set_security_price(
    state: State<AppState>,
    security_id: String,
    date: String,
    price_micro: i64,
) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::set_security_price(&conn, &security_id, &date, price_micro, "manual")
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_security_price(state: State<AppState>, security_id: String, date: String) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::delete_security_price(&conn, &security_id, &date)
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_investment_transaction(
    state: State<AppState>,
    transaction: NewInvestmentTransaction,
) -> Result<String, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::create_investment_transaction(&conn, &transaction)
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_investment_transaction(
    state: State<AppState>,
    id: String,
    transaction: NewInvestmentTransaction,
) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::update_investment_transaction(&conn, &id, &transaction)
}

/// Move shares between investment accounts, lots and all.
#[tauri::command(rename_all = "camelCase")]
pub fn create_share_transfer(
    state: State<AppState>,
    from_account_id: String,
    to_account_id: String,
    date: String,
    security_id: String,
    shares_micro: i64,
    notes: Option<String>,
    lot_allocations: Option<Vec<crate::models::LotAllocation>>,
) -> Result<Vec<String>, String> {
    let (_g, conn) = with_conn(&state)?;
    let (a, b) = queries::create_share_transfer(
        &conn,
        &from_account_id,
        &to_account_id,
        &date,
        &security_id,
        shares_micro,
        notes.as_deref(),
        &lot_allocations.unwrap_or_default(),
    )?;
    Ok(vec![a, b])
}

/// Open lots for one security in one account as of a date — what a sale on
/// that date can take.
#[tauri::command(rename_all = "camelCase")]
pub fn list_lots(
    state: State<AppState>,
    account_id: String,
    security_id: String,
    as_of: String,
) -> Result<Vec<Lot>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::list_lots(&conn, &account_id, &security_id, &as_of)
}

/// The lots one sale took, with the gain on each.
#[tauri::command(rename_all = "camelCase")]
pub fn get_disposals(state: State<AppState>, sell_id: String) -> Result<Vec<Disposal>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::disposals_for(&conn, &sell_id)
}

/// Every holding, or one account's, as of a date (default today).
#[tauri::command(rename_all = "camelCase")]
pub fn get_portfolio(
    state: State<AppState>,
    account_id: Option<String>,
    as_of: Option<String>,
) -> Result<Portfolio, String> {
    let (_g, conn) = with_conn(&state)?;
    let asof = as_of.unwrap_or_else(|| chrono::Local::now().date_naive().format("%Y-%m-%d").to_string());
    lots::portfolio(&conn, account_id.as_deref().filter(|a| !a.is_empty()), &asof)
}

/// Time-weighted and money-weighted returns by period, for the
/// Investing tab. `account_id` None is every investment account;
/// `security_id` narrows it to one holding, valued without cash.
#[tauri::command(rename_all = "camelCase")]
pub fn get_performance(state: State<AppState>, account_id: Option<String>, security_id: Option<String>, as_of: Option<String>) -> Result<Vec<Performance>, String> {
    let (_g, conn) = with_conn(&state)?;
    let asof = as_of.unwrap_or_else(|| chrono::Local::now().date_naive().format("%Y-%m-%d").to_string());
    lots::performance(&conn, account_id.as_deref().filter(|a| !a.is_empty()), security_id.as_deref().filter(|s| !s.is_empty()), &asof)
}

/// Money's dated ROI: past month / YTD / 12 months / all time.
#[tauri::command(rename_all = "camelCase")]
pub fn get_roi(state: State<AppState>, account_id: Option<String>, as_of: Option<String>) -> Result<Vec<RoiPeriod>, String> {
    let (_g, conn) = with_conn(&state)?;
    let asof = as_of.unwrap_or_else(|| chrono::Local::now().date_naive().format("%Y-%m-%d").to_string());
    lots::roi(&conn, account_id.as_deref().filter(|a| !a.is_empty()), &asof)
}

// ── Reports ────────────────────────────────────────────────────────────────

// Saved, named reports.
#[tauri::command(rename_all = "camelCase")]
pub fn list_saved_reports(state: State<AppState>) -> Result<Vec<SavedReport>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::list_saved_reports(&conn)
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_report(state: State<AppState>, report: SavedReport) -> Result<SavedReport, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::save_report(&conn, report)
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_saved_report(state: State<AppState>, id: String) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::delete_saved_report(&conn, &id)
}

/// Which account a transaction lives in — so a report row (which carries the
/// transaction id but not its account) can open the right register.
#[tauri::command(rename_all = "camelCase")]
pub fn get_transaction_account(state: State<AppState>, id: String) -> Result<String, String> {
    let (_g, conn) = with_conn(&state)?;
    conn.query_row("SELECT account_id FROM transactions WHERE id = ?1", [&id], |r| r.get(0))
        .map_err(|e| format!("transaction {id} not found: {e}"))
}

/// The report gallery — every report the engine answers, grouped the way
/// Money's "View a report" page groups them.
///
/// The Classifications group is left out until the file has at least
/// one classification. Those reports cannot say anything without an axis,
/// and a gallery entry that always errors is worse than one that is not
/// there — the Classifications screen is where you make the first one.
#[tauri::command(rename_all = "camelCase")]
pub fn list_reports(state: State<AppState>) -> Vec<ReportGalleryEntry> {
    let any_class = with_conn(&state)
        .ok()
        .and_then(|(_g, conn)| conn.query_row("SELECT COUNT(*) FROM classifications", [], |r| r.get::<_, i64>(0)).ok())
        .unwrap_or(0)
        > 0;
    crate::db::reports::GALLERY
        .iter()
        .filter(|(group, _, _)| any_class || *group != "Classifications")
        .map(|(group, kind, label)| ReportGalleryEntry {
            group: group.to_string(),
            kind: kind.to_string(),
            label: label.to_string(),
        })
        .collect()
}

/// Run one report.
#[tauri::command(rename_all = "camelCase")]
pub fn run_report(state: State<AppState>, request: ReportRequest) -> Result<Report, String> {
    let (_g, conn) = with_conn(&state)?;
    crate::db::reports::run_report(&conn, &request)
}

// ── Import ─────────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub fn import_qif_ofx(
    state: State<AppState>,
    file_path: String,
    account_id: String,
) -> Result<ImportSummary, String> {
    // import_file takes the pool and acquires its own connections internally,
    // so we hand it the pool directly (holding the guard for the duration).
    importing(&state, "import a bank file", || {
        let guard = state
            .pool
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        let pool = guard
            .as_ref()
            .ok_or_else(|| "database pool not initialized".to_string())?;
        let summary = import::import_file(pool, &file_path, &account_id)?;
        drop(guard);
        Ok(summary)
    })
}

// ── Keyring ────────────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub fn get_key_status(state: State<AppState>) -> Result<KeyStatus, String> {
    Ok(KeyStatus {
        has_key: keyring::has_key_in(&key_account_of(&state)?),
        db_path: db_path_of(&state)?.to_string_lossy().to_string(),
    })
}

/// Replace the master key in the keyring and rebuild the pool with it.
#[tauri::command(rename_all = "camelCase")]
pub fn change_master_key(state: State<AppState>, new_key: String) -> Result<(), String> {
    if new_key.trim().is_empty() {
        return Err("master key cannot be empty".into());
    }
    let account = key_account_of(&state)?;
    let old_key = keyring::get_key_in(&account)?;
    if old_key == new_key {
        return Err("that is already the master key".into());
    }

    // Order matters, and this is the whole point.
    //
    // The previous implementation stored the new key in the OS keyring and
    // rebuilt the pool — WITHOUT re-encrypting the file. The database stayed
    // encrypted with the old key, the next open failed, and because the old key
    // had never been shown to anyone the file was unrecoverable. Changing the
    // master key was a button that destroyed access to your own data.
    //
    // So: drop the pool (its connections still hold the old key), re-encrypt
    // the FILE, and only then record the new key.
    {
        let mut guard = state
            .pool
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        *guard = None;
    }
    if let Err(e) = pool::rekey_file(&db_path_of(&state)?, &old_key, &new_key) {
        // The file is unchanged (rekey_file proves the old key before it
        // touches anything), so bring the app back up on it rather than
        // leaving the pool empty until a restart.
        let reopen = rebuild_pool(&state);
        return Err(match reopen {
            Ok(()) => e,
            Err(r) => format!("{e} (and reopening the database afterwards failed too: {r})"),
        });
    }

    // The file is already re-encrypted. If the keyring write fails now, the new
    // key is the ONLY way in — so say it, in full, rather than returning a
    // tidy error that loses it.
    if let Err(e) = keyring::set_key_in(&account, &new_key) {
        return Err(reopen_after_keyring_refused(&state.pool, &db_path_of(&state)?, &new_key, &e));
    }
    rebuild_pool(&state)
}

/// The keyring would not take the new key, but the file is already
/// re-encrypted with it.
///
/// This returned the error and nothing else, with the pool still `None` from
/// before the rekey — so every command after it answered "database is not
/// open" until a restart, and a restart reads the OLD key from the keyring,
/// which no longer opens the file. The session that knows the new key is the
/// last chance to use it: reopen with it, directly, since `rebuild_pool`
/// would read the keyring, and say the key in full so it can be written
/// down.
fn reopen_after_keyring_refused(
    slot: &std::sync::Mutex<Option<DbPool>>,
    path: &std::path::Path,
    new_key: &str,
    why: &str,
) -> String {
    let reopened = pool::init_pool(path, new_key).and_then(|p| {
        *slot.lock().map_err(|_| "state lock poisoned".to_string())? = Some(p);
        Ok(())
    });
    match reopened {
        Ok(()) => format!(
            "The database was re-encrypted and is open, but the new key could not be saved to the \
             OS keyring ({why}). SAVE THIS KEY NOW — the next time the app starts it is the only way \
             to open your data: {new_key}"
        ),
        Err(r) => format!(
            "The database was re-encrypted, but the new key could not be saved to the OS keyring \
             ({why}), and reopening the database with it failed too ({r}). SAVE THIS KEY NOW — it \
             is the only way to open your data: {new_key}"
        ),
    }
}

/// How automatic backups are configured, plus what is already in the folder.
#[tauri::command(rename_all = "camelCase")]
pub fn get_backup_config(state: State<AppState>) -> Result<BackupConfig, String> {
    let (_g, conn) = with_conn(&state)?;
    let folder = queries::get_setting(&conn, backup::FOLDER)?;
    let existing = folder
        .as_deref()
        .map(|f| {
            let mut names: Vec<String> = backup::ours_in(std::path::Path::new(f))
                .iter()
                .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(String::from))
                .collect();
            names.reverse(); // newest first, for a list the user reads
            names
        })
        .unwrap_or_default();
    Ok(BackupConfig {
        enabled: queries::get_setting(&conn, backup::ENABLED)?.as_deref() == Some("1"),
        on_exit: queries::get_setting(&conn, backup::ON_EXIT)?.as_deref() == Some("1"),
        folder,
        keep: queries::get_setting(&conn, backup::KEEP)?
            .and_then(|v| v.parse().ok())
            .unwrap_or(10),
        last_at: queries::get_setting(&conn, backup::LAST_AT)?,
        existing,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_backup_config(
    state: State<AppState>,
    enabled: bool,
    on_exit: bool,
    folder: Option<String>,
    keep: u32,
) -> Result<BackupConfig, String> {
    {
        let (_g, conn) = with_conn(&state)?;
        queries::set_setting(&conn, backup::ENABLED, if enabled { "1" } else { "0" })?;
        queries::set_setting(&conn, backup::ON_EXIT, if on_exit { "1" } else { "0" })?;
        queries::set_setting(&conn, backup::FOLDER, folder.as_deref().unwrap_or(""))?;
        // Never zero: a retention of 0 is a configuration mistake, not an
        // instruction to delete every backup the user has.
        queries::set_setting(&conn, backup::KEEP, &keep.max(1).to_string())?;
    }
    get_backup_config(state)
}

/// Take one now, ignoring the once-a-day rule — the "Back up now" button.
#[tauri::command(rename_all = "camelCase")]
pub fn backup_now(state: State<AppState>) -> Result<String, String> {
    {
        let (_g, conn) = with_conn(&state)?;
        // Clearing the stamp is what makes this ignore the daily check without
        // a second code path that could drift from the automatic one.
        queries::set_setting(&conn, backup::LAST_AT, "")?;
    }
    let guard = state
        .pool
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    let pool = guard
        .as_ref()
        .ok_or_else(|| "database pool not initialized".to_string())?;
    match backup::run_if_due(pool, chrono::Local::now())? {
        Some(p) => Ok(p.to_string_lossy().to_string()),
        None => Err("Automatic backup is off, or no folder is set.".to_string()),
    }
}

/// The master key itself, for the user to write down or store in a password
/// manager.
///
/// This is not a leak, it is the recovery path. The key lives in the OS keyring
/// and nowhere else; lose the Windows profile and an unexportable key means the
/// database — and every backup of it, which is encrypted with the same key — is
/// gone permanently. A local-first app that cannot show you your own key is
/// asking you to trust one registry hive with your entire financial history.
#[tauri::command(rename_all = "camelCase")]
pub fn export_master_key(state: State<AppState>) -> Result<String, String> {
    // The key for the file that is OPEN. Handing back the app database's
    // key while looking at another file would be worse than useless — it would
    // be written down and filed as the key to the wrong thing.
    keyring::get_key_in(&key_account_of(&state)?)
}

/// Write the master key to a file the user chose.
#[tauri::command(rename_all = "camelCase")]
pub fn save_master_key(state: State<AppState>, path: String) -> Result<(), String> {
    let key = keyring::get_key_in(&key_account_of(&state)?)?;
    let body = format!(
        "T-Money master key\r\n\r\n{key}\r\n\r\n\
         This key decrypts your T-Money database and every backup of it.\r\n\
         Without it those files cannot be opened by anyone, including you.\r\n\
         Keep it somewhere separate from the backups themselves.\r\n"
    );
    std::fs::write(&path, body).map_err(|e| format!("could not write {path}: {e}"))
}

// ---------------------------------------------------------------------------
// T-Money files: open another one, make a new one, list the recents.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFile {
    pub path: String,
    pub name: String,
    /// True when this is the app's own database rather than one the user
    /// chose — the UI says so, because "where is my data" has one answer and
    /// it should not be a mystery.
    pub is_default: bool,
    pub scratch: bool,
    /// False after File → Close: there is genuinely no file open, and
    /// the app shows its start screen. `path` and `name` are then the file
    /// that WAS open, so the start screen can offer to reopen it.
    pub is_open: bool,
}

#[tauri::command(rename_all = "camelCase")]
pub fn current_file(state: State<AppState>) -> Result<OpenFile, String> {
    let p = db_path_of(&state)?;
    // The pool IS the answer to "is a file open" — it is dropped by
    // Close and rebuilt by Open, and there is no second flag to disagree
    // with it.
    let is_open = state.pool.lock().map_err(|_| "state lock poisoned".to_string())?.is_some();
    Ok(OpenFile {
        name: crate::files::display_name(&p),
        is_default: p == state.default_db_path,
        scratch: state.scratch_dir.is_some(),
        path: p.to_string_lossy().to_string(),
        is_open,
    })
}

/// File → Close. Close the file. No file is then open.
///
/// An earlier change made this "go back to T-Money's own database", on the reasoning that
/// a start screen would exist for one purpose. What that actually produced,
/// the first time it met a real machine: two files with the same data in
/// them, a Close that swapped one for the other, and a screen that looked
/// completely unchanged. "Close" has to mean closed, or it means nothing.
///
/// So the pool is DROPPED — the file handle released, which on Windows is
/// also what lets the file be moved or backed up — the undo stack cleared,
/// and every command that needs a file answers `NO_FILE` until one is opened.
/// `db_path` is left pointing at the file that was open, so the start screen
/// can offer it back.
#[tauri::command(rename_all = "camelCase")]
pub fn close_file(state: State<AppState>) -> Result<OpenFile, String> {
    // A snapshot on the way out, BEFORE the pool goes: once it is
    // dropped there is no connection left to `VACUUM INTO` from.
    //
    // Close counts as leaving. It is the moment a person swaps to another
    // file or walks away, and if the backup folder is a synced one, this is
    // what puts a consistent copy on its way to the other machine without
    // anybody remembering to ask.
    if state.scratch_dir.is_none() {
        if let Ok(guard) = state.pool.lock() {
            if let Some(pool) = guard.as_ref() {
                match crate::backup::run_on_exit(pool, chrono::Local::now()) {
                    Ok(Some(p)) => eprintln!("[t-money] backup on close written to {}", p.display()),
                    Ok(None) => {}
                    // Soft, always. A backup that will not write is never a
                    // reason a file cannot be closed.
                    Err(e) => eprintln!("[t-money] backup on close skipped: {e}"),
                }
            }
        }
    }
    {
        let mut guard = state.pool.lock().map_err(|_| "state lock poisoned".to_string())?;
        *guard = None;
    }
    // A different file is a different history, and no file is no history.
    // Undo across a close would restore rows into whatever is opened
    // next.
    if let Ok(mut j) = state.undo.lock() {
        j.clear();
    }
    current_file(state)
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_recent_files(state: State<AppState>) -> Result<Vec<crate::files::RecentFile>, String> {
    // `files::recent` knows about paths and nothing else, which is why
    // it leaves `needs_key` false. The keyring and the default database's path
    // both live here, so the flag is filled in here: the start screen can then
    // say which of these files this computer cannot open BEFORE you click one,
    // rather than after.
    Ok(crate::files::recent(&state.config_dir)
        .into_iter()
        .map(|mut f| {
            let p = std::path::PathBuf::from(&f.path);
            let account = crate::keyring::account_for(&p, Some(&state.default_db_path));
            f.needs_key = f.exists && !crate::keyring::has_key_in(&account);
            f
        })
        .collect())
}

#[tauri::command(rename_all = "camelCase")]
pub fn forget_file(state: State<AppState>, path: String) -> Result<(), String> {
    crate::files::forget(&state.config_dir, std::path::Path::new(&path))
}

/// Open `path` in place of whatever is open.
///
/// `create` says the caller means to make a new file; without it a path that
/// is not there is an error rather than a brand new empty database. That
/// distinction is the whole safety of this command — a typo in Open must not
/// silently produce an empty file and leave the user thinking their data is
/// gone.
#[tauri::command(rename_all = "camelCase")]
pub fn open_file(state: State<AppState>, path: String, create: bool, key: Option<String>) -> Result<OpenFile, String> {
    open_file_impl(&state, path, create, key)
}

/// `open_file`'s body, callable from another command (the sample file).
/// Tauri commands take `State` by value, so the shared work lives here rather
/// than one command pretending to be a caller of another.
fn open_file_impl(state: &State<AppState>, path: String, create: bool, key: Option<String>) -> Result<OpenFile, String> {
    let target = crate::files::with_extension(std::path::Path::new(&path));
    let exists = target.exists();
    if !exists && !create {
        return Err(format!("there is no file at {}", target.display()));
    }
    if exists && create {
        return Err(format!("{} already exists — open it instead", target.display()));
    }
    if create {
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        }
    }

    // The key for the file being opened — its own account, unless it is the
    // app's own database, which keeps the original one.
    let account = crate::keyring::account_for(&target, Some(&state.default_db_path));
    let name = crate::files::display_name(&target);
    let typed = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    let key = match &typed {
        // A key typed by the user: a file carried from another machine.
        //
        // It is NOT stored here. It used to be, one line before the
        // open was even attempted, and that made the first typo permanent in
        // a way no message explained: the wrong key went into the keyring,
        // `has_key_in` then said this computer had a key, and every later
        // open used it and failed with SQLCipher's "file is not a database".
        // The file looked CORRUPT rather than LOCKED, and there was no way
        // back through the UI. It is stored below, once it has actually
        // opened the file.
        Some(k) => k.clone(),
        None => {
            // Refuse to invent a key for a file that already exists and has
            // none stored: a fresh random key cannot decrypt it, and opening
            // would fail with something far less useful than this sentence.
            if exists && !crate::keyring::has_key_in(&account) {
                return Err(format!(
                    "{NEEDS_KEY}: {name} was not created on this computer — its master key is needed to open it"
                ));
            }
            crate::keyring::ensure_key_in(&account)?.0
        }
    };

    // Drop the old pool BEFORE opening the new one: on Windows the file stays
    // locked while a handle is open, and the two files can be the same one.
    let was_open = {
        let mut guard = state.pool.lock().map_err(|_| "state lock poisoned".to_string())?;
        guard.take().is_some()
    };
    let pool = match pool::init_pool(&target, &key) {
        Ok(p) => p,
        Err(e) => {
            // Say which of the three things went wrong, because they
            // want three different responses from the user.
            //
            // A key that does not decrypt is not a broken file, and the
            // difference is the whole point: one is "try again", the other is
            // "restore from a backup". The no-key-typed case reaches here only
            // when the key this computer HAS is wrong for the file — which is
            // exactly the state the old store-before-open bug left people in,
            // so it asks for a key rather than stranding them.
            let why = if !is_undecryptable(&e) {
                format!("could not open {}: {e}", target.display())
            } else if typed.is_some() {
                format!(
                    "{WRONG_KEY}: that key does not open {name} — check that all 64 characters came across"
                )
            } else {
                format!(
                    "{NEEDS_KEY}: the key stored on this computer does not open {name} — its own master key is needed"
                )
            };
            // Put back what was open, so a failed Open does not leave the app
            // with no database at all — unless nothing WAS open, in
            // which case the start screen is where a failed Open belongs.
            if !was_open {
                return Err(why);
            }
            let previous = db_path_of(&state)?;
            let prev_account = key_account_of(&state)?;
            if let Ok(k) = crate::keyring::get_key_in(&prev_account) {
                if let Ok(p) = pool::init_pool(&previous, &k) {
                    *state.pool.lock().map_err(|_| "state lock poisoned".to_string())? = Some(p);
                }
            }
            return Err(why);
        }
    };

    // NOW the key is worth keeping: it opened the file. A keyring
    // write that fails here means being asked for the key again next time,
    // which is a mild and self-announcing failure — and strictly better than
    // the alternative this replaced, which was storing a key that opens
    // nothing and reporting the file as corrupt ever after.
    if let Some(k) = &typed {
        let _ = crate::keyring::set_key_in(&account, k);
    }
    {
        // The path changes while the pool lock is held, so a fetch that
        // checks "is this still the file I started on?" under that lock
        // never sees the new pool beside the old path.
        let mut slot = state.pool.lock().map_err(|_| "state lock poisoned".to_string())?;
        *state.db_path.lock().map_err(|_| "state lock poisoned".to_string())? = target.clone();
        *state.key_account.lock().map_err(|_| "state lock poisoned".to_string())? = account;
        *slot = Some(pool);
    }

    // A different file is a different history. The stack holds row ids
    // and whole rows from the file that was open a moment ago; undoing one of
    // those steps against this file would insert rows that never belonged to
    // it. Nothing about the previous file survives the swap.
    if let Ok(mut j) = state.undo.lock() {
        j.clear();
    }

    // With the undo history gone, attachment bytes nothing points at
    // any more (a removed attachment, or one that went with a deleted row)
    // can go too. Nothing that fails here should keep the file from opening.
    if let Ok(guard) = state.pool.lock() {
        if let Some(pool) = guard.as_ref() {
            if let Ok(conn) = crate::db::pool::get(pool) {
                let _ = queries::sweep_orphan_attachment_blobs(&conn);
            }
        }
    }

    // A scratch run must not touch the real recents.
    //
    // This wrote to the shared config directory unconditionally, and the
    // config directory is NOT redirected by `--data-dir`. So opening a file
    // from a scratch run changed which database the INSTALLED app opened at
    // its next launch. A scratch run exists precisely so that it cannot
    // affect the real one; this was the hole in that promise.
    if state.scratch_dir.is_none() {
        let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
        let _ = crate::files::remember(&state.config_dir, &target, &now);
    }

    Ok(OpenFile {
        name: crate::files::display_name(&target),
        is_default: target == state.default_db_path,
        scratch: state.scratch_dir.is_some(),
        path: target.to_string_lossy().to_string(),
        is_open: true,
    })
}

/// The reason the app is not on the file you left it on, if there is
/// one. Read-and-clear: it is news exactly once, and a banner that will not
/// go away is a banner people learn to ignore.
#[tauri::command(rename_all = "camelCase")]
pub fn startup_note(state: State<AppState>) -> Result<Option<String>, String> {
    let mut n = state.startup_note.lock().map_err(|_| "state lock poisoned".to_string())?;
    Ok(n.take())
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_db_info(state: State<AppState>) -> Result<DbInfo, String> {
    let live_path = db_path_of(&state)?;
    let size = std::fs::metadata(&live_path).map(|m| m.len()).unwrap_or(0);
    Ok(DbInfo {
        db_path: live_path.to_string_lossy().to_string(),
        size_bytes: size,
        has_key: keyring::has_key_in(&key_account_of(&state)?),
        scratch_dir: state.scratch_dir.as_ref().map(|p| p.to_string_lossy().to_string()),
    })
}

/// Export the encrypted database to `path` via `VACUUM INTO` — a consistent,
/// self-contained, still-encrypted copy (WAL data included).
#[tauri::command(rename_all = "camelCase")]
pub fn backup_database(state: State<AppState>, path: String) -> Result<u64, String> {
    let target = std::path::PathBuf::from(&path);

    // Refuse to back the database up over itself. `VACUUM INTO` would fail
    // anyway, but only after `vacuum_into` had moved the live file aside —
    // and the one file this app exists to protect is not one to be clever
    // with. Compare resolved paths so `..` and a short path cannot sneak past.
    let live_path = db_path_of(&state)?;
    let same = match (target.canonicalize(), live_path.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => target == live_path,
    };
    if same {
        return Err("that is the database itself — choose a different file".to_string());
    }

    let (_g, conn) = with_conn(&state)?;
    backup::vacuum_into(&conn, &target)?;
    let bytes = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    Ok(bytes)
}

/// Restore the database from an encrypted backup at `path`. The live DB is
/// replaced (the pool is dropped first to release the file handles).
///
/// `key` is the passphrase that backup was encrypted with, for when it is not
/// the one this machine already holds. That is the actual recovery path — a
/// backup carried from an old machine is unreadable without it, and before this parameter
/// there was no way to supply one. (Doc comments cannot sit on a parameter in
/// Rust.)
#[tauri::command(rename_all = "camelCase")]
pub fn restore_database(
    state: State<AppState>,
    path: String,
    key: Option<String>,
) -> Result<(), String> {
    let src = std::path::Path::new(&path);
    if !src.exists() {
        return Err(format!("backup file not found: {path}"));
    }
    let live_owned = db_path_of(&state)?;
    let live = &live_owned;
    let live_str = live.to_string_lossy().to_string();
    let wal = format!("{live_str}-wal");

    // The set-aside copy gets a name of its own per attempt, and a file
    // already at that name is never deleted. A previous attempt's aside copy
    // may be the only good database the user has — and "restore from it" is
    // exactly what they will try next.
    let aside = std::path::PathBuf::from(format!(
        "{live_str}.pre-restore-{}",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));
    if aside.exists() {
        return Err("a restore was attempted less than a second ago — try again".to_string());
    }
    // Refuse to restore the live database over itself. `backup_database`
    // makes the same check for the same reason.
    let same_file = |a: &std::path::Path, b: &std::path::Path| match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    };
    if same_file(src, live) {
        return Err("that is the live database itself — choose a backup file".to_string());
    }

    // 0) Prove the backup opens with the key we are about to rely on, BEFORE
    //    anything is touched. The old order was copy → set keyring → rebuild,
    //    so a corrupt backup or a mistyped key was discovered only after the
    //    live file had been overwritten and the keyring pointed at a key that
    //    opened nothing. Now a bad backup is refused with the live database
    //    exactly as it was.
    let account = key_account_of(&state)?;
    let old_key = keyring::get_key_in(&account).map_err(|e| format!("keyring get failed: {e}"))?;
    let new_key = key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string);
    pool::verify_key(src, new_key.as_deref().unwrap_or(&old_key))
        .map_err(|e| format!("that backup cannot be opened, so nothing was restored: {e}"))?;

    // 1) Fold the write-ahead log into the main file and empty it, BEFORE the
    //    pool goes away.
    //
    //    This is the whole bug this function used to have. The database runs
    //    in WAL mode, so recent writes live in `<db>-wal`, not in `<db>`.
    //    Windows keeps that sidecar locked even after the pool is dropped, so
    //    the `remove_file` below can fail — and it used to fail *silently*,
    //    behind a `let _ =`. SQLite would then replay the pre-restore WAL on
    //    top of the file we just restored, silently undoing the restore.
    //    `wal_checkpoint(TRUNCATE)` folds it in and leaves the sidecar empty,
    //    so even a copy we cannot delete replays nothing.
    //
    //    Covered by `pool::tests::a_restore_replaces_the_live_file_and_the_pool_comes_back_consistent`.
    {
        let guard = state
            .pool
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        if let Some(pool) = guard.as_ref() {
            let conn = pool.get().map_err(|e| format!("pool error: {e}"))?;
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(|e| format!("could not checkpoint the write-ahead log: {e}"))?;
        }
    }

    // 2) Drop the pool to release the OS file handles.
    {
        let mut guard = state
            .pool
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        *guard = None;
    }

    // 3) Clear the sidecars. Deletion is best-effort — Windows may still hold
    //    a handle — but a *non-empty* WAL at this point would be replayed over
    //    the restored file, so that case aborts BEFORE the copy. Failing here
    //    leaves the user's live database exactly as it was.
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{live_str}{suffix}"));
    }
    if let Ok(meta) = std::fs::metadata(&wal) {
        if meta.len() > 0 {
            // Nothing has been touched; bring the app back up on it.
            let reopen = rebuild_pool(&state);
            return Err(format!(
                "restore aborted: the write-ahead log is still in use and could not be \
                 cleared. Close any other window using the database and try again — your \
                 current data has not been touched.{}",
                match reopen {
                    Ok(()) => String::new(),
                    Err(e) => format!(" (Reopening it failed too: {e}. Restart the app.)"),
                }
            ));
        }
    }

    // 4) Move the live file aside rather than over-writing it, then copy the
    //    backup in. If anything after this fails, the aside copy goes back.
    //    A restore must never be the step that loses the only good file.
    let had_live = live.exists();
    if had_live {
        if let Err(e) = std::fs::rename(live, &aside) {
            let reopen = rebuild_pool(&state);
            return Err(format!(
                "restore aborted before touching your data: could not set the current \
                 database aside ({e}).{}",
                match reopen {
                    Ok(()) => String::new(),
                    Err(e) => format!(" (Reopening it failed too: {e}. Restart the app.)"),
                }
            ));
        }
    }
    let put_back = |why: String| -> String {
        // Clear the FAILED restore's file and its sidecars before the old
        // file comes back: a non-empty WAL left beside it would be replayed
        // over the previous database at the next open — the same trap step
        // 1 exists for, in the other direction. If the WAL cannot be
        // cleared, the previous file stays aside, intact, and the message
        // says where it is.
        let _ = std::fs::remove_file(live);
        for suffix in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{live_str}{suffix}"));
        }
        let wal_stuck = std::fs::metadata(&wal).map(|m| m.len() > 0).unwrap_or(false);
        if had_live {
            if wal_stuck {
                return format!(
                    "{why}. The previous database was NOT put back, because a write-ahead \
                     log from the failed restore is still locked and would corrupt it. \
                     It is intact at {} — close the app, delete {wal}, and rename it to \
                     {live_str}.",
                    aside.display()
                );
            }
            if let Err(e) = std::fs::rename(&aside, live) {
                return format!(
                    "{why}. WORSE: the previous database could not be put back either ({e}). \
                     It is intact at {} — rename it to {live_str} by hand.",
                    aside.display()
                );
            }
        }
        let _ = keyring::set_key_in(&account, &old_key);
        match rebuild_pool(&state) {
            Ok(()) => format!("{why}. Your previous database was put back and is open."),
            Err(e) => format!("{why}. Your previous database was put back but could not be reopened: {e}"),
        }
    };
    if let Err(e) = std::fs::copy(src, live) {
        return Err(put_back(format!("restore failed while copying the backup: {e}")));
    }

    // 5) If the backup was encrypted with a different key, adopt it — the file
    //    on disk is now that backup, so the keyring must match it or the
    //    rebuild below fails and the app is left unable to open anything.
    if let Some(k) = new_key.as_deref() {
        if let Err(e) = keyring::set_key_in(&account, k) {
            return Err(put_back(format!("the backup's key could not be saved to the OS keyring: {e}")));
        }
    }

    // 6) Rebuild the pool (re-applies the key, re-runs idempotent migrations).
    if let Err(e) = rebuild_pool(&state) {
        return Err(put_back(format!("the restored database could not be opened: {e}")));
    }
    // The rows the undo stack was holding belong to the file that was
    // here before the restore. Same reasoning as `open_file`.
    if let Ok(mut j) = state.undo.lock() {
        j.clear();
    }
    // Only now is the aside copy surplus. Best effort: on Windows it may be
    // gone already or briefly locked, and either way the restore succeeded.
    let _ = std::fs::remove_file(&aside);
    Ok(())
}

// ── Scheduled bills and income ───────────────────────────────────────
//
// These replace the one-off `payments` commands, which migration 0019 folded
// into recurrence rules so there is ONE list of upcoming money rather than two
// concepts that both mean "a bill".

#[tauri::command(rename_all = "camelCase")]
pub fn list_recurrences(state: State<AppState>) -> Result<Vec<Recurrence>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::list_recurrences(&conn)
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_recurrence(
    state: State<AppState>,
    payload: NewRecurrence,
) -> Result<Recurrence, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::create_recurrence(&conn, &payload)
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_recurrence(
    state: State<AppState>,
    id: String,
    payload: NewRecurrence,
) -> Result<Recurrence, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::update_recurrence(&conn, &id, &payload)
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_recurrence(state: State<AppState>, id: String) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::delete_recurrence(&conn, &id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_recurrence_active(
    state: State<AppState>,
    id: String,
    active: bool,
) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::set_recurrence_active(&conn, &id, active)
}

/// Occurrences between two dates, for the bill calendar. Resolved
/// against the register the same way `get_upcoming` is.
#[tauri::command(rename_all = "camelCase")]
pub fn get_occurrences(state: State<AppState>, from: String, to: String) -> Result<Vec<Occurrence>, String> {
    let (_g, conn) = with_conn(&state)?;
    let parse = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|e| format!("bad date {s:?}: {e}"));
    let (from, to) = (parse(&from)?, parse(&to)?);
    if to < from {
        return Err("the range ends before it starts".into());
    }
    queries::occurrences_between(&conn, from, to, chrono::Local::now().date_naive())
}

/// Occurrences from today across `days`, each resolved against what actually
/// happened — including bills the user paid by hand.
#[tauri::command(rename_all = "camelCase")]
pub fn get_upcoming(state: State<AppState>, days: i64) -> Result<Vec<Occurrence>, String> {
    let (_g, conn) = with_conn(&state)?;
    let today = chrono::Local::now().date_naive();
    // A little history, so an overdue bill does not vanish off the top.
    let from = today - chrono::Duration::days(30);
    queries::occurrences_between(&conn, from, today + chrono::Duration::days(days.max(1)), today)
}

/// Enter one occurrence into the register.
#[tauri::command(rename_all = "camelCase")]
pub fn enter_occurrence(
    state: State<AppState>,
    recurrence_id: String,
    due_date: String,
    date: String,
    amount_cents: Option<i64>,
    account_id: Option<String>,
) -> Result<Transaction, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::enter_occurrence(
        &conn,
        &recurrence_id,
        &due_date,
        &date,
        amount_cents,
        account_id.as_deref(),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn skip_occurrence(
    state: State<AppState>,
    recurrence_id: String,
    due_date: String,
) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::skip_occurrence(&conn, &recurrence_id, &due_date)
}

/// Undo a Paid or Skipped decision, returning the occurrence to due — or to
/// matched, if a real transaction still satisfies it.
#[tauri::command(rename_all = "camelCase")]
pub fn clear_occurrence(
    state: State<AppState>,
    recurrence_id: String,
    due_date: String,
) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::clear_occurrence(&conn, &recurrence_id, &due_date)
}

/// Project one account's balance forward, with the low point called out.
#[tauri::command(rename_all = "camelCase")]
/// `include_detected` also projects the recurring charges the
/// detector has noticed; absent means yes, and the Bills tab has the switch.
/// (No comment inside the parameter list: the IPC contract test reads it.)
pub fn get_cash_forecast(
    state: State<AppState>,
    account_id: String,
    days: i64,
    include_detected: Option<bool>,
) -> Result<CashForecast, String> {
    let (_g, conn) = with_conn(&state)?;
    let today = chrono::Local::now().date_naive();
    queries::cash_forecast_with(&conn, &account_id, today, days, include_detected.unwrap_or(true))
}

// ── Common Transactions ──────────────────────────────────────────────

/// The saved entry-form templates, most-used first.
#[tauri::command(rename_all = "camelCase")]
pub fn list_common_transactions(state: State<AppState>) -> Result<Vec<CommonTransaction>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::list_common_transactions(&conn)
}

/// Save the entry form as a named template. Saving over an existing name
/// replaces it and keeps its usage count.
#[tauri::command(rename_all = "camelCase")]
pub fn create_common_transaction(
    state: State<AppState>,
    payload: NewCommonTransaction,
) -> Result<CommonTransaction, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::create_common_transaction(&conn, &payload)
}

/// Record that a template was used, so the menu can lead with the ones that
/// earn their place.
#[tauri::command(rename_all = "camelCase")]
pub fn touch_common_transaction(state: State<AppState>, id: String) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::touch_common_transaction(&conn, &id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_common_transaction(state: State<AppState>, id: String) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::delete_common_transaction(&conn, &id)
}

/// How old the prices are, and what the user asked for.
///
/// The app still fetches only when told to; "automatically" here means the
/// app asks ONCE a day (or a week) while it is open, and only after the user
/// turns it on in Settings. Nothing fetches on its own out of the box, which
/// is the promise `prices.rs` makes.
#[tauri::command(rename_all = "camelCase")]
pub fn price_status(state: State<AppState>) -> Result<PriceStatus, String> {
    let (_g, conn) = with_conn(&state)?;
    let with_symbol: i64 = conn
        .query_row("SELECT COUNT(*) FROM securities WHERE trim(symbol) <> ''", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let newest: Option<String> = conn
        .query_row(
            "SELECT MAX(p.date) FROM security_prices p
               JOIN securities s ON s.id = p.security_id
              WHERE trim(s.symbol) <> ''",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    // The worst-served security: the oldest of each one's newest price.
    let oldest: Option<String> = conn
        .query_row(
            "SELECT MIN(latest) FROM (
                 SELECT MAX(p.date) AS latest FROM security_prices p
                   JOIN securities s ON s.id = p.security_id
                  WHERE trim(s.symbol) <> ''
                  GROUP BY p.security_id)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let never_priced: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM securities s
              WHERE trim(s.symbol) <> ''
                AND NOT EXISTS (SELECT 1 FROM security_prices p WHERE p.security_id = s.id)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(PriceStatus {
        with_symbol,
        newest_date: newest,
        oldest_date: oldest,
        never_priced,
        last_auto: queries::get_setting(&conn, "ui.prices.lastAuto")?.filter(|v| !v.is_empty()),
        interval: queries::get_setting(&conn, "ui.prices.auto")?.filter(|v| !v.is_empty()).unwrap_or_else(|| "off".to_string()),
    })
}

/// Fetch a current share price for every holding that has a symbol.
///
/// **This is the only command in the app that makes an outbound network
/// request.** It runs when the user presses "Refresh prices", or on the
/// schedule they opted into. Only ticker symbols leave the machine;
/// quantities, cost basis, balances and account names do not. See
/// `prices.rs`.
///
/// Failure is per-holding and never destructive: a symbol the source does not
/// carry, an unreadable quantity, or a stale quote leaves that holding's
/// stored value exactly as it was and adds a line to `failures` for the screen
/// to show. A refresh that reaches nothing changes nothing.
/// `auto` marks the run as the scheduled one, which stamps
/// `ui.prices.lastAuto` so the next check knows a day has passed. A refresh
/// the user pressed does not, so turning the timer on tomorrow does not
/// think it already ran.
///
/// Three things this used to get wrong. A price was stored under the
/// day of the refresh, so Friday's close fetched on Monday morning became
/// Monday's price and Friday had none; it is stored under the quote's own
/// trading day now. A source that could not be reached at all (no network, a
/// firewall, a rate limit) was tried again for every symbol, ten seconds
/// each; the run stops at the first such failure and says the rest were not
/// tried. And the securities are read from the file open when the run
/// starts, but each write went to whichever file was open when it landed —
/// and the refresh starts the moment a file opens, so switching files straight away
/// sent the rest of file A's prices at file B and stamped B's `lastAuto`. The
/// run now stops without writing once the open file has changed.
#[tauri::command(rename_all = "camelCase")]
pub async fn refresh_investment_prices(
    state: State<'_, AppState>,
    auto: Option<bool>,
) -> Result<PriceRefreshSummary, String> {
    // Read the securities, then release the connection: the fetches take
    // seconds and must not hold a pooled connection while they run.
    let started_on = db_path_of(&state)?;
    // Prices are stored in the home currency, so only quotes in it are taken.
    let (home, securities): (String, Vec<(String, String)>) = {
        let (_g, conn) = with_conn(&state)?;
        let list = queries::list_securities(&conn)?
            .into_iter()
            .map(|s| (s.id, s.symbol))
            .collect();
        (queries::home_currency(&conn)?, list)
    };
    let today = chrono::Local::now().date_naive();
    let still_open = |state: &State<'_, AppState>| -> Result<bool, String> {
        Ok(crate::files::is_same(&db_path_of(state)?, &started_on))
    };

    let mut summary = prices::empty_summary();
    let total = securities.len();
    for (i, (id, symbol)) in securities.into_iter().enumerate() {
        if symbol.trim().is_empty() {
            summary.skipped += 1;
            continue;
        }
        // `ureq` is blocking; keep it off the async runtime's threads.
        let sym = symbol.clone();
        let quote_in = home.clone();
        let fetched = tauri::async_runtime::spawn_blocking(move || prices::quote_dated_in(&sym, today, &quote_in))
            .await
            .map_err(|e| format!("price lookup did not run: {e}"))?;

        let quote = match fetched {
            Ok(q) => q,
            Err(e) => {
                let unreachable = e.is_source();
                prices::fail(&mut summary, &symbol, e.message());
                if unreachable {
                    let rest = total - i - 1;
                    if rest > 0 {
                        prices::fail(
                            &mut summary,
                            "",
                            format!("{rest} more not tried — the price source could not be reached"),
                        );
                    }
                    break;
                }
                continue;
            }
        };
        let price_micro = match prices::price_to_micro(quote.price) {
            Ok(p) => p,
            Err(e) => {
                prices::fail(&mut summary, &symbol, e);
                continue;
            }
        };

        if !still_open(&state)? {
            return Ok(summary);
        }
        let (_g, conn) = with_conn(&state)?;
        // Prices were asked for in the home currency the run started with.
        if queries::home_currency(&conn)? != home {
            prices::fail(&mut summary, "", "the home currency changed while prices were being fetched; update them again");
            return Ok(summary);
        }
        let on = quote.store_date(today).format("%Y-%m-%d").to_string();
        match queries::set_security_price(&conn, &id, &on, price_micro, "fetched") {
            Ok(_) => summary.updated += 1,
            Err(e) => prices::fail(&mut summary, &symbol, e),
        }
    }
    if auto.unwrap_or(false) && still_open(&state)? {
        // Stamped even when every symbol failed: the point is that the app
        // ASKED today, so an offline machine does not retry every minute.
        let (_g, conn) = with_conn(&state)?;
        let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
        queries::set_setting(&conn, "ui.prices.lastAuto", &now)?;
    }
    Ok(summary)
}

/// Fill the file with a realistic set of demo accounts and transactions.
///
/// **Development only** — this command, not the generator. `db::demo` is
/// compiled in every build (the sample file needs it); what is
/// behind `#[cfg(debug_assertions)]` is the ability to seed demo rows into
/// *the file that is already open*. The command itself stays registered
/// (Tauri's `generate_handler!` cannot take a `cfg` on an entry) but in
/// release it resolves to the stub below and returns an error, so a shipped
/// app has no code path that can write fake transactions into somebody's real
/// finances. The sample file is the opposite case and is allowed in
/// release precisely because it can only ever write into a file it just
/// created.
///
/// The `cfg` is on two *items* rather than on two blocks inside one function:
/// `#[cfg]` on a statement is stable, but on a tail *expression* it is not
/// (`stmt_expr_attributes`), and the debug arm has to be the tail expression
/// to return its value.
///
/// Additive: it creates its own accounts (`Demo Checking`, and so on, with a
/// numeric suffix if those names are taken) and never reads, changes or
/// removes anything already in the file.
#[cfg(debug_assertions)]
fn seed_demo_impl(state: &State<AppState>) -> Result<SeedSummary, String> {
    let (_g, conn) = with_conn(state)?;
    crate::db::demo::seed(&conn)
}

#[cfg(not(debug_assertions))]
fn seed_demo_impl(_state: &State<AppState>) -> Result<SeedSummary, String> {
    Err("seed_demo_data is available only in development builds".to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn seed_demo_data(state: State<AppState>) -> Result<SeedSummary, String> {
    seed_demo_impl(&state)
}

/// Create a NEW file, full of demo data, and open it.
///
/// For handing the app to somebody to try. A tester who opens an empty file
/// sees an empty app: no register to scroll, no report with anything in it,
/// no reconcile to run. This gives them three years of a plausible household
/// — accounts, transactions, categories, budget, bills, investments with a
/// price history, a mortgage part-way paid down — and none of it belongs to
/// anybody.
///
/// **Why this is allowed in a release build when `seed_demo_data` is not.**
/// The rule the seeder protects is that a personal-finance application must
/// never be able to write invented transactions into somebody's real
/// finances. This cannot: `create = true` makes `open_file_impl` refuse a
/// path that already exists, so the file is one this call brought into being
/// a moment ago, and the emptiness check below says so a second time before a
/// single row is written. There is no argument, no setting and no accident
/// that points it at an existing file.
///
/// The file is left OPEN, because the next thing a tester wants is to look at
/// it.
#[tauri::command(rename_all = "camelCase")]
pub fn create_sample_file(state: State<AppState>, path: String) -> Result<SeedSummary, String> {
    // `create = true` is the first guard: an existing path is refused here,
    // before anything is opened.
    open_file_impl(&state, path, true, None)?;

    let (_g, conn) = with_conn(&state)?;
    // And the second: whatever we just opened has nothing in it. Belt and
    // braces on the one operation in this application that writes rows
    // nobody typed.
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM transactions", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if rows != 0 {
        return Err("that file already has transactions in it — a sample file is only ever a new one".to_string());
    }
    crate::db::demo::seed(&conn)
}

/// Edit a transfer in place, including moving the other half to a different
/// account. See `queries::update_transfer`.
///
/// Undoable. It was the one way of editing a transaction that wrote
/// no step, so Ctrl+Z after moving a transfer to the wrong account reached
/// past it and took back whatever came before. Both halves are photographed
/// BEFORE the edit, while the partner still sits in the old account; the
/// "after" photograph names the new one. Undo recomputes every account
/// either photograph names — this one, the old partner account and the new
/// one — from their rows, so the money lands back where it was in all three.
/// `other_amount_cents` is the amount on the other side, for a transfer
/// between accounts kept in two currencies; None otherwise.
#[tauri::command(rename_all = "camelCase")]
pub fn update_transfer(
    state: State<AppState>,
    id: String,
    date: String,
    other_account_id: String,
    amount_cents: i64,
    other_amount_cents: Option<i64>,
    notes: Option<String>,
) -> Result<Transaction, String> {
    let (_g, conn) = with_conn(&state)?;
    let ids = undo::related_ids(&conn, &id)?;
    let (out, step) = undo::recording(&conn, "edit a transfer", &ids, || {
        queries::update_transfer_amounts(&conn, &id, &date, &other_account_id, amount_cents, other_amount_cents, notes.as_deref())
    })?;
    push_undo(&state, step)?;
    Ok(out)
}

/// An ordinary transaction becomes a transfer to another account: the
/// partner row is written and linked, this row's category cleared. Undoable:
/// `recording` re-derives the related ids afterwards, so the partner it
/// created is in the "after" photograph and undo deletes it.
#[tauri::command(rename_all = "camelCase")]
pub fn convert_to_transfer(state: State<AppState>, id: String, other_account_id: String) -> Result<Transaction, String> {
    let (_g, conn) = with_conn(&state)?;
    let ids = undo::related_ids(&conn, &id)?;
    let (out, step) = undo::recording(&conn, "make a transaction a transfer", &ids, || {
        queries::convert_to_transfer(&conn, &id, &other_account_id)
    })?;
    push_undo(&state, step)?;
    Ok(out)
}

/// The reverse: the partner row goes, this one is filed under a
/// category. The partner is in the "before" photograph, so undo puts it back.
#[tauri::command(rename_all = "camelCase")]
pub fn convert_from_transfer(state: State<AppState>, id: String, category_id: Option<String>) -> Result<Transaction, String> {
    let (_g, conn) = with_conn(&state)?;
    let ids = undo::related_ids(&conn, &id)?;
    let (out, step) = undo::recording(&conn, "make a transfer an ordinary transaction", &ids, || {
        queries::convert_from_transfer(&conn, &id, category_id.as_deref())
    })?;
    push_undo(&state, step)?;
    Ok(out)
}

// ── Splits ─────────────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub fn list_splits(state: State<AppState>, transaction_id: String) -> Result<Vec<Split>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::list_splits(&conn, &transaction_id)
}


// ── Transfers ──────────────────────────────────────────────────────────────

/// Move money between accounts. Creates the two linked halves in one go;
/// `amount_cents` is a magnitude, direction comes from the account arguments.
/// `received_cents` is what arrives in the other account, in its currency,
/// when the two are kept in different currencies; None otherwise.
#[tauri::command(rename_all = "camelCase")]
pub fn create_transfer(
    state: State<AppState>,
    from_account_id: String,
    to_account_id: String,
    date: String,
    amount_cents: i64,
    received_cents: Option<i64>,
    notes: Option<String>,
) -> Result<Transaction, String> {
    let (_g, conn) = with_conn(&state)?;
    match received_cents {
        Some(received) => queries::create_transfer_between(&conn, &from_account_id, &to_account_id, &date, amount_cents, received, notes.as_deref()),
        None => queries::create_transfer(&conn, &from_account_id, &to_account_id, &date, amount_cents, notes.as_deref()),
    }
}

/// The order the accounts are listed in, everywhere. `ids` is the
/// whole arrangement; an account not in it sorts after the placed ones.
#[tauri::command(rename_all = "camelCase")]
pub fn set_account_order(state: State<AppState>, ids: Vec<String>) -> Result<usize, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::set_account_order(&conn, &ids)
}

// ── Attachments ─────────────────────────────────────────────────────

/// A MIME type from the file's extension — enough for the OS to pick a
/// viewer and for the list to say "PDF". Anything else is bytes.
fn mime_for(name: &str) -> &'static str {
    let ext = std::path::Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-eelectric",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ofx" | "qfx" | "qif" => "text/plain",
        _ => "application/octet-stream",
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_attachments(state: State<AppState>, transaction_id: Option<String>, account_id: Option<String>) -> Result<Vec<Attachment>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::list_attachments(&conn, transaction_id.as_deref(), account_id.as_deref())
}

/// Attach the file at `path` to a transaction or an account. The bytes are
/// read here, in Rust — the webview never sees them — and stored in the
/// encrypted file. Undoable on a transaction, like any edit to it.
#[tauri::command(rename_all = "camelCase")]
pub fn add_attachment(state: State<AppState>, transaction_id: Option<String>, account_id: Option<String>, path: String) -> Result<Attachment, String> {
    let p = std::path::Path::new(&path);
    let name = p.file_name().and_then(|n| n.to_str()).ok_or_else(|| format!("{path} has no file name"))?.to_string();
    let meta = std::fs::metadata(p).map_err(|e| format!("could not read {path}: {e}"))?;
    if meta.len() as usize > queries::MAX_ATTACHMENT_BYTES {
        return Err(format!("{name} is {} MB; attachments are limited to {} MB", meta.len() / (1024 * 1024), queries::MAX_ATTACHMENT_BYTES / (1024 * 1024)));
    }
    let data = std::fs::read(p).map_err(|e| format!("could not read {path}: {e}"))?;
    let mime = mime_for(&name);
    let (_g, conn) = with_conn(&state)?;
    match transaction_id.as_deref() {
        Some(t) => {
            let ids = undo::related_ids(&conn, t)?;
            let (out, step) = undo::recording(&conn, "attach a file", &ids, || {
                queries::add_attachment(&conn, Some(t), None, &name, mime, &data)
            })?;
            push_undo(&state, step)?;
            Ok(out)
        }
        None => queries::add_attachment(&conn, None, account_id.as_deref(), &name, mime, &data),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn remove_attachment(state: State<AppState>, id: String) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    let a = queries::get_attachment(&conn, &id)?;
    match a.transaction_id.as_deref() {
        Some(t) => {
            let ids = undo::related_ids(&conn, t)?;
            let (out, step) = undo::recording(&conn, "remove an attachment", &ids, || queries::remove_attachment(&conn, &id))?;
            push_undo(&state, step)?;
            Ok(out)
        }
        None => queries::remove_attachment(&conn, &id),
    }
}

/// Write the attachment to a private temp folder and hand it to whatever
/// the OS opens that kind of file with. The temp copy is named after the
/// attachment and its id, so two receipts called `scan.pdf` do not fight.
#[tauri::command(rename_all = "camelCase")]
pub fn open_attachment(state: State<AppState>, id: String) -> Result<String, String> {
    let (a, data) = {
        let (_g, conn) = with_conn(&state)?;
        queries::attachment_bytes(&conn, &id)?
    };
    let dir = std::env::temp_dir().join("t-money").join("attachments").join(&a.id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make a temporary folder: {e}"))?;
    let safe: String = a.name.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c }).collect();
    let path = dir.join(safe);
    std::fs::write(&path, &data).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    let shown = path.to_string_lossy().to_string();
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| format!("could not open {shown}: {e}"))?;
    Ok(shown)
}

/// Save a copy of the attachment where the user chose (the path comes from
/// a save dialog on the other side).
#[tauri::command(rename_all = "camelCase")]
pub fn save_attachment(state: State<AppState>, id: String, path: String) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    let (_a, data) = queries::attachment_bytes(&conn, &id)?;
    std::fs::write(&path, &data).map_err(|e| format!("could not write {path}: {e}"))
}

// ── Account details (migration 0010) ───────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub fn get_account(state: State<AppState>, id: String) -> Result<Account, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::get_account(&conn, &id)
}

/// Money's "Change account details".
#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)]
pub fn update_account(
    state: State<AppState>,
    id: String,
    name: String,
    account_type: String,
    is_closed: bool,
    institution: Option<String>,
    account_number: Option<String>,
    routing_number: Option<String>,
    opened_on: Option<String>,
    credit_limit_cents: Option<i64>,
    contact_phone: Option<String>,
    contact_email: Option<String>,
    website: Option<String>,
    address: Option<String>,
    account_notes: Option<String>,
) -> Result<Account, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::update_account(
        &conn,
        &id,
        &name,
        &account_type,
        is_closed,
        institution.as_deref(),
        account_number.as_deref(),
        routing_number.as_deref(),
        opened_on.as_deref(),
        credit_limit_cents,
        contact_phone.as_deref(),
        contact_email.as_deref(),
        website.as_deref(),
        address.as_deref(),
        account_notes.as_deref(),
    )
}

// ── Payees (migration 0011) ────────────────────────────────────────────────

#[tauri::command(rename_all = "camelCase")]
pub fn list_payees(state: State<AppState>) -> Result<Vec<Payee>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::list_payees(&conn)
}

/// Descriptions split lines have carried, for the split dialog's completion.
#[tauri::command(rename_all = "camelCase")]
pub fn list_split_descriptions(state: State<AppState>) -> Result<Vec<UsedText>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::list_split_descriptions(&conn)
}

/// Rename a payee and/or set the category it defaults to. The rename also
/// rewrites `transactions.payee`, which is what the register displays.
// ── Search ─────────────────────────────────────────────────────────────────

/// The header's Search box. `account_id` scopes it; `None` is every account.
#[tauri::command(rename_all = "camelCase")]
pub fn search_transactions(
    state: State<AppState>,
    query: String,
    account_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<SearchHit>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::search_transactions(&conn, &query, account_id.as_deref(), limit.unwrap_or(200))
}

/// Add a payee by hand, from the Payees screen.
#[tauri::command(rename_all = "camelCase")]
pub fn create_payee(
    state: State<AppState>,
    name: String,
    last_category_id: Option<String>,
) -> Result<Payee, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::create_payee(&conn, &name, last_category_id.as_deref())
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_payee(
    state: State<AppState>,
    id: String,
    name: String,
    last_category_id: Option<String>,
) -> Result<Payee, String> {
    let (_g, conn) = with_conn(&state)?;
    // Recorded for undo; so are the name copies it now rewrites.
    let (payee, step) = queries::update_payee(&conn, &id, &name, last_category_id.as_deref())?;
    push_undo(&state, step)?;
    Ok(payee)
}

/// Undoable, like a category merge.
///
/// > *"I merged Best Buy into Chewy … CTRL+Z did not undo it."*
#[tauri::command(rename_all = "camelCase")]
pub fn merge_payees(
    state: State<AppState>,
    from_id: String,
    into_id: String,
) -> Result<Payee, String> {
    let (_g, conn) = with_conn(&state)?;
    let (payee, step) = queries::merge_payees(&conn, &from_id, &into_id)?;
    push_undo(&state, step)?;
    Ok(payee)
}

/// Recorded for undo; see `queries::delete_payee` for why that and
/// not `undo_stack_invalidated`.
#[tauri::command(rename_all = "camelCase")]
pub fn delete_payee(state: State<AppState>, id: String) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    let step = queries::delete_payee(&conn, &id)?;
    push_undo(&state, step)
}

// ── Reconcile ──────────────────────────────────────────────────────

/// The postponed statement for this account, if any — drives the resume dialog.
#[tauri::command(rename_all = "camelCase")]
pub fn get_open_statement(
    state: State<AppState>,
    account_id: String,
) -> Result<Option<Statement>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::get_open_statement(&conn, &account_id)
}

/// The last completed statement — "Last statement reconciled" / "Balanced on".
#[tauri::command(rename_all = "camelCase")]
pub fn get_last_statement(
    state: State<AppState>,
    account_id: String,
) -> Result<Option<Statement>, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::get_last_statement(&conn, &account_id)
}

#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)]
pub fn start_statement(
    state: State<AppState>,
    account_id: String,
    statement_date: String,
    starting_balance_cents: i64,
    ending_balance_cents: i64,
    service_charge_cents: Option<i64>,
    service_charge_category_id: Option<String>,
    interest_cents: Option<i64>,
    interest_category_id: Option<String>,
) -> Result<Statement, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::start_statement(
        &conn,
        &account_id,
        &statement_date,
        starting_balance_cents,
        ending_balance_cents,
        service_charge_cents,
        service_charge_category_id.as_deref(),
        interest_cents,
        interest_category_id.as_deref(),
    )
}

/// Securities with no symbol whose name reads as a ticker get it.
#[tauri::command]
pub fn fill_symbols_from_names(state: State<AppState>) -> Result<u32, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::fill_symbols_from_names(&conn)
}

/// Mark everything on or before a date reconciled. `dry_run` counts.
#[tauri::command(rename_all = "camelCase")]
pub fn reconcile_through(state: State<AppState>, account_id: String, through: String, dry_run: bool) -> Result<u32, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::reconcile_through(&conn, &account_id, &through, dry_run)
}

/// Toggle a row's cleared mark. Written per click so Postpone preserves them.
#[tauri::command(rename_all = "camelCase")]
pub fn set_cleared(
    state: State<AppState>,
    transaction_id: String,
    cleared_state: String,
) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::set_cleared(&conn, &transaction_id, &cleared_state)
}

/// Postpone — the user's Postpone behaves as Cancel: drop the statement header,
/// keep the cleared marks (they belong to the transactions).
#[tauri::command(rename_all = "camelCase")]
pub fn discard_statement(state: State<AppState>, statement_id: String) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    queries::discard_statement(&conn, &statement_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn finish_statement(
    state: State<AppState>,
    statement_id: String,
    adjustment_cents: Option<i64>,
    adjustment_category_id: Option<String>,
) -> Result<Statement, String> {
    let (_g, conn) = with_conn(&state)?;
    queries::finish_statement(
        &conn,
        &statement_id,
        adjustment_cents,
        adjustment_category_id.as_deref(),
    )
}

/// Void or un-void a transaction. The row stays in the register; the
/// money leaves every balance.
#[tauri::command(rename_all = "camelCase")]
pub fn set_void(state: State<AppState>, id: String, is_void: bool) -> Result<(), String> {
    let (_g, conn) = with_conn(&state)?;
    let ids = undo::related_ids(&conn, &id)?;
    let label = if is_void { "void a transaction" } else { "unvoid a transaction" };
    let (_, step) = undo::recording(&conn, label, &ids, || queries::set_void(&conn, &id, is_void))?;
    push_undo(&state, step)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Undo and redo.
// ---------------------------------------------------------------------------

fn push_undo(state: &State<AppState>, step: undo::Step) -> Result<(), String> {
    state.undo.lock().map_err(|_| "state lock poisoned".to_string())?.push(step);
    Ok(())
}

/// A write that cannot be undone INVALIDATES everything before it.
///
/// Imports are not on the undo stack and are not going to be: one file can
/// write hundreds of rows across several accounts, create securities, book
/// lots and link transfers. That was decided on purpose.
///
/// What that decision did not do is clear the stack, and that is the dangerous half.
/// A user edited a checking account, went to their TSP account, imported, and
/// **Undo was still offered — pointing at the checking edit.** Ctrl+Z there
/// does not undo the import; it reaches straight past it and takes back
/// something unrelated from before, while the import stays. That is precisely
/// the "shallow undo" `undo.rs`'s own header calls worse than no undo.
///
/// So an import empties the stack. Undo grays out, which is the truth: there
/// is nothing here that can be taken back, and the way out of a bad import is
/// the backup, not Ctrl+Z.
///
/// The rule is not about imports. It is about any write this app does
/// that undo does not photograph, and there are three: an import, deleting an
/// account, and merging two accounts. All three call this. A fourth belongs
/// here the day one is written, and the test for "does it belong" is the only
/// one that matters: **if Ctrl+Z after it would take back something else,
/// this function is missing from it.**
fn undo_stack_invalidated(state: &State<AppState>) -> Result<(), String> {
    state.undo.lock().map_err(|_| "state lock poisoned".to_string())?.clear();
    Ok(())
}

/// Run an import and put it on the undo stack.
///
/// > *"I'm just thinking if I've been updating other things and then go and
/// >  do an import of a few weeks of stuff from another account, I'm not
/// >  likely to do a backup before and if I don't and say I mistakenly import
/// >  to the wrong account well I have a lot of cleanup to do where undo could
/// >  just fix it right away."*
///
/// Every importer used to call `undo_stack_invalidated`, which threw the whole
/// stack away — honest, because an import could not be taken back, but it
/// meant the largest single write the app makes was also the only one with no
/// way out but a backup.
///
/// The ids of every transaction are taken before and after. The difference is
/// what the import created, whatever route it took: rows written, rows skipped
/// as duplicates, rows matched to something already there, and a QIF
/// `[Account]` line that wrote into an account nobody named. No importer has
/// to report anything, so no importer can forget to.
///
/// The pool guard is dropped before this runs, so `with_conn` can take it.
fn importing<T>(
    state: &State<AppState>,
    label: &str,
    op: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let before = {
        let (_g, conn) = with_conn(state)?;
        undo::all_txn_ids(&conn)?
    };
    let out = op()?;
    let step = {
        let (_g, conn) = with_conn(state)?;
        let after = undo::all_txn_ids(&conn)?;
        let created: std::collections::BTreeSet<String> =
            after.difference(&before).cloned().collect();
        if created.is_empty() {
            None
        } else {
            Some(undo::creations_step(&conn, label, &created)?)
        }
    };
    match step {
        // Nothing was written — every row was a duplicate, or matched to
        // something already in the register. There is nothing to undo, and
        // the stack behind it is still good.
        None => {}
        Some(step) => push_undo(state, step)?,
    }
    Ok(out)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoStatus {
    /// What Undo would take back, for the menu to name — or null when there
    /// is nothing, which is what grays the item out.
    pub undo: Option<String>,
    pub redo: Option<String>,
}

fn status_of(state: &State<AppState>) -> Result<UndoStatus, String> {
    let j = state.undo.lock().map_err(|_| "state lock poisoned".to_string())?;
    Ok(UndoStatus { undo: j.can_undo().map(str::to_string), redo: j.can_redo().map(str::to_string) })
}

#[tauri::command(rename_all = "camelCase")]
pub fn undo_status(state: State<AppState>) -> Result<UndoStatus, String> {
    status_of(&state)
}

/// Put the world back the way the last step found it.
///
/// The step is taken off the stack BEFORE the restore and only put on the
/// redo side if the restore succeeds — a step that failed halfway is not
/// something to offer to replay.
#[tauri::command(rename_all = "camelCase")]
pub fn undo_last(state: State<AppState>) -> Result<UndoStatus, String> {
    let (_g, conn) = with_conn(&state)?;
    let step = {
        let mut j = state.undo.lock().map_err(|_| "state lock poisoned".to_string())?;
        j.take_undo()
    };
    let Some(step) = step else { return status_of(&state) };
    // A refused restore rolls back whole (one SQL transaction), so the
    // file is as it was and the step still describes it. Put it back: dropped,
    // a merge refused because its old name was re-created could never be
    // undone, even after the user cleared the clash.
    if let Err(e) = undo::restore(&conn, &step.before, &step.after.accounts) {
        state.undo.lock().map_err(|_| "state lock poisoned".to_string())?.put_done(step);
        return Err(e);
    }
    state.undo.lock().map_err(|_| "state lock poisoned".to_string())?.put_undone(step);
    status_of(&state)
}

#[tauri::command(rename_all = "camelCase")]
pub fn redo_last(state: State<AppState>) -> Result<UndoStatus, String> {
    let (_g, conn) = with_conn(&state)?;
    let step = {
        let mut j = state.undo.lock().map_err(|_| "state lock poisoned".to_string())?;
        j.take_redo()
    };
    let Some(step) = step else { return status_of(&state) };
    // As `undo_last`: a refused redo leaves the step where it was.
    if let Err(e) = undo::restore(&conn, &step.after, &step.before.accounts) {
        state.undo.lock().map_err(|_| "state lock poisoned".to_string())?.put_undone(step);
        return Err(e);
    }
    state.undo.lock().map_err(|_| "state lock poisoned".to_string())?.put_done(step);
    status_of(&state)
}

#[cfg(test)]
mod key_tests {
    use super::*;

    /// The wrong-key path hangs entirely off recognizing SQLCipher's answer,
    /// and SQLCipher's answer never contains the word "key".
    #[test]
    fn a_file_that_will_not_decrypt_is_told_apart_from_a_file_that_is_missing() {
        assert!(is_undecryptable("migration failed: file is not a database"));
        assert!(is_undecryptable(
            "failed to acquire connection for migration: file is encrypted or is not a database"
        ));
        // Case, because the error arrives through two different wrappers.
        assert!(is_undecryptable("Error: File Is Not A Database"));

        // Everything else is a real failure and must NOT ask for a key —
        // "paste your master key" is a useless thing to say about a path that
        // is not there or a disk that is full.
        assert!(!is_undecryptable("there is no file at E:\\gone.tmny"));
        assert!(!is_undecryptable("failed to create data dir: access is denied"));
        assert!(!is_undecryptable("database is locked"));
        assert!(!is_undecryptable("disk I/O error"));
    }

    /// The UI branches on the token, not the sentence — so the token has to be
    /// at the front, where a `startsWith`/`includes` finds it, and the sentence
    /// has to still read as English once the token is stripped.
    #[test]
    fn the_two_key_sentinels_lead_the_message_they_carry() {
        let needs = format!("{NEEDS_KEY}: Sam.tmny was not created on this computer");
        let wrong = format!("{WRONG_KEY}: that key does not open Sam.tmny");
        assert!(needs.starts_with("NEEDS_KEY: "));
        assert!(wrong.starts_with("WRONG_KEY: "));
        assert_ne!(NEEDS_KEY, WRONG_KEY);
        // Neither may contain the other, or `includes` in the front end would
        // match both and always take the first branch.
        assert!(!NEEDS_KEY.contains(WRONG_KEY));
        assert!(!WRONG_KEY.contains(NEEDS_KEY));
    }

    /// The keyring refused the new key after the file was re-encrypted
    /// with it. The pool comes back up on the NEW key, so the session goes on
    /// working, and the message carries the key in full.
    #[test]
    fn a_keyring_that_refuses_the_new_key_leaves_the_file_open_on_it_and_says_the_key() {
        let mut dir = std::env::temp_dir();
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        dir.push(format!("tm-rekey-keyring-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("live.db");
        {
            let p = pool::init_pool(&path, "old-key").unwrap();
            // The balance and the row it comes from, so the check below
            // has a consistent file to agree with.
            let c = pool::get(&p).unwrap();
            c.execute("INSERT INTO accounts (id, name, type, balance_cents) VALUES ('a1','Checking','checking', 4242)", []).unwrap();
            c.execute("INSERT INTO transactions (id, account_id, date, payee, amount_cents) VALUES ('t1','a1','2026-01-01','Opening Balance', 4242)", []).unwrap();
        }
        pool::rekey_file(&path, "old-key", "new-key").unwrap();

        // What `change_master_key` holds at that moment: no pool.
        let slot: std::sync::Mutex<Option<DbPool>> = std::sync::Mutex::new(None);
        let msg = reopen_after_keyring_refused(&slot, &path, "new-key", "Access is denied");
        assert!(msg.contains("new-key"), "{msg}");
        assert!(msg.contains("Access is denied"), "{msg}");
        assert!(msg.contains("is open"), "{msg}");
        {
            let guard = slot.lock().unwrap();
            let conn = pool::get(guard.as_ref().expect("the pool was reopened")).unwrap();
            let cents: i64 = conn.query_row("SELECT balance_cents FROM accounts WHERE id = 'a1'", [], |r| r.get(0)).unwrap();
            assert_eq!(cents, 4242);
            crate::db::test_db::assert_consistent(&conn);
        }

        // Had the reopen failed too, the key is still said, and the pool stays empty.
        let empty: std::sync::Mutex<Option<DbPool>> = std::sync::Mutex::new(None);
        let msg = reopen_after_keyring_refused(&empty, &path, "not-the-key", "Access is denied");
        assert!(msg.contains("not-the-key") && msg.contains("failed too"), "{msg}");
        assert!(empty.lock().unwrap().is_none());

        drop(slot);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
