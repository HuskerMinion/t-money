//! T-Money — local-first, encrypted personal finance desktop app.
//!
//! Entry point: `run()`. On startup we:
//! 1. Resolve the OS app-data directory and the encrypted DB path.
//! 2. Ensure a master key exists in the OS keyring (generate + store on first run).
//! 3. Open the SQLCipher-encrypted database, apply the key, run migrations.
//! 4. Bind the connection pool into Tauri managed state.
//! 5. Register all IPC commands.

pub mod commands;
pub mod currency;
pub mod db;
pub mod files;
pub mod import;
pub mod keyring;
pub mod models;
pub mod backup;
pub mod prices;
pub mod region;
pub mod schedule;
mod state;

use state::AppState;
use tauri::{Emitter, Manager};

/// Resolve the encrypted database path under the OS app-data directory.
fn db_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .resolve("t-money", tauri::path::BaseDirectory::AppData)
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(dir.join("t-money.db"))
}

/// A scratch data directory, if one was asked for.
///
/// `--data-dir <dir>` / `--data-dir=<dir>` on the command line, or the
/// `T_MONEY_DATA_DIR` environment variable. The database lives at
/// `<dir>/t-money.db`, and the master key for it lives in a keyring entry
/// named for that directory — so a scratch run can create a fresh file,
/// change its key, restore into it, and never touch the real database or the
/// entry that opens it. This is what makes first run testable at all.
pub fn scratch_data_dir<I: IntoIterator<Item = String>>(
    args: I,
    env: Option<String>,
) -> Option<std::path::PathBuf> {
    let mut args = args.into_iter();
    while let Some(a) = args.next() {
        if a == "--data-dir" {
            if let Some(v) = args.next() {
                return Some(std::path::PathBuf::from(v));
            }
        } else if let Some(v) = a.strip_prefix("--data-dir=") {
            return Some(std::path::PathBuf::from(v));
        }
    }
    env.map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
}

/// The file Windows handed us, if it did.
///
/// Double-clicking a `.tmny` in Explorer runs the app with the file's path as
/// an argument. That is the whole mechanism: the association registered in
/// `tauri.conf.json` tells Windows to launch T-Money with the path, and this
/// picks it out of the argument list.
///
/// Deliberately strict about WHICH arguments count. Anything beginning with a
/// dash is a flag (and `--data-dir` takes a value, which must not be mistaken
/// for a file to open); anything else has to end in a spelling of a T-Money
/// file. A stray argument from a shortcut, an installer or a debugger is not a
/// database, and opening whatever happened to be on the command line is how an
/// app ends up trying to decrypt its own log file.
///
/// The path is not checked for existence here — that is
/// `remembered_problem`'s job, so a file that was moved reports the same way
/// whether it came from Explorer or from the recents list.
pub fn file_argument<I: IntoIterator<Item = String>>(args: I) -> Option<std::path::PathBuf> {
    let mut args = args.into_iter();
    while let Some(a) = args.next() {
        if a == "--data-dir" {
            // Its value is a directory, not a file to open.
            let _ = args.next();
            continue;
        }
        if a.starts_with('-') {
            continue;
        }
        let lower = a.to_lowercase();
        if lower.ends_with(&format!(".{}", crate::files::EXT))
            || lower.ends_with(&format!(".{}", crate::files::LEGACY_EXT))
        {
            return Some(std::path::PathBuf::from(a));
        }
    }
    None
}

/// One line for the startup-error log.
///
/// A release build is compiled with `windows_subsystem = "windows"`, so it has
/// no console: if `setup` returns an error the process exits with no window and
/// nothing on screen. Every `eprintln!` in this file goes nowhere. This is the
/// only trace a user — or the next session — would otherwise have, so it is
/// written to a file beside the database.
/// May the remembered file be opened at all?
///
/// Pure so the rules can be tested without a Tauri app, a keyring or a
/// database. Two refusals, both learned the hard way:
///
/// * A file that is not there. Nothing to open, and inventing it would create
///   an empty database where the user's data used to be.
/// * A file that exists with no key stored on this machine. `ensure_key_in`
///   would generate one, the fresh key would not decrypt the file, and
///   SQLCipher would report "file is not a database" — the error that made
///   the installed app unstartable. A file whose key we do not have is a file
///   we cannot open; saying so is the whole job.
fn remembered_problem(exists: bool, has_key: bool) -> Option<&'static str> {
    if !exists {
        return Some("it is no longer there");
    }
    if !has_key {
        return Some("no master key for it is stored on this machine");
    }
    None
}

/// What the user is told when the app is not on the file they left it on.
/// Names the file, says why, and says what it did instead — a message that
/// leaves any of those three out just makes the user uneasy.
///
/// What it does instead CHANGED, and the wording with it. It used to
/// fall back to the app's own database, which is how "a week of transactions
/// in the wrong file" happens: a screen full of somebody's accounts looks
/// exactly like a screen full of yours until you look at the numbers. Now
/// nothing is opened, this line is shown on the start screen, and the choice
/// of what to open next is the user's.
fn fallback_note(path: &std::path::Path, why: &str) -> String {
    format!(
        "{} could not be opened ({why}), so T-Money did not open a file. Choose one below.",
        path.display()
    )
}

/// With no file remembered, may the app open its OWN database?
///
/// Once, yes, always: startup fell back to it and you got a full screen of
/// accounts whether or not they were the accounts you meant. That is the
/// behavior a user hit — File → Close, relaunch, and the app came up on its
/// own database looking exactly like a working file.
///
/// But there is one install for which the app's own database IS the user's
/// file: the old one that predates opening files of your own and has never opened anything else. Its
/// recents list is empty and its own database is sitting there full of data,
/// and showing that person a start screen would look exactly like their money
/// had been lost. So: open it only for that install, and only then.
///
/// Not called when a REMEMBERED file failed to open. There, the fallback is
/// the danger itself — the user is one file away from typing a week of
/// transactions into the wrong one — so nothing is opened and the start
/// screen says why.
fn open_own_database_unasked(own_database_exists: bool, has_recents: bool) -> bool {
    own_database_exists && !has_recents
}

/// Which file, if any, startup should treat as "the one you had open".
///
/// Two rules, and the second is the one that was broken:
///
/// 1. A file named on the command line wins — you double-clicked THAT
///    file, whatever it is, including the app's own database if that is what
///    you picked.
/// 2. The recents list is offered only when it does not name the app's own
///    database. T-Money's own file is not a file the user chose; treating it
///    as remembered is how the start screen gets skipped, which is precisely
///    what an earlier fix set out to stop.
///
/// Rule 2 was `p != &default_db_path`, a raw `PathBuf` comparison, and on
/// Windows the two spellings are never equal — see `files::is_same`. So the
/// guard never fired, the app opened its own database as though the user had
/// asked for it, and File → Close could not get you out of it: the close was
/// honored, the next launch read the same recents entry, and up came
/// t-money.db again.
fn startup_file(
    opened_with: Option<std::path::PathBuf>,
    last_opened: Option<std::path::PathBuf>,
    default_db: &std::path::Path,
) -> Option<std::path::PathBuf> {
    opened_with.or_else(|| last_opened.filter(|p| !files::is_same(p, default_db)))
}

/// Why a file was not opened when the keyring would not answer.
/// Written as a clause because `fallback_note` puts it in parentheses.
const KEYRING_UNREACHABLE: &str =
    "the Windows credential store could not be reached, so this file's key cannot be read or saved";

/// The key startup opens `exists`'s file with, as `(key, created)`.
///
/// It used to call `ensure_key_in` for every file and, when that failed,
/// generate a key, IGNORE whether storing it worked, and log that it had been
/// stored. For a file that exists that key cannot decrypt it — and if the
/// store came back between the calls, `set_key_in` overwrote the real key
/// with the made-up one, which is the file lost for good. For a file that
/// does not exist it created a database whose only key was in memory.
///
/// So: a file that exists is only ever READ a key (`get`), never given one,
/// and a new file gets one only if storing it succeeded (`ensure`, which
/// returns an error otherwise). Either failure is the caller's error to
/// report. The keyring calls are parameters so the rule is tested without a
/// credential store.
fn startup_key(
    exists: bool,
    get: impl FnOnce() -> Result<String, String>,
    ensure: impl FnOnce() -> Result<(String, bool), String>,
) -> Result<(String, bool), String> {
    if exists {
        get().map(|k| (k, false))
    } else {
        ensure()
    }
}

fn startup_error_line(now: chrono::DateTime<chrono::Local>, msg: &str) -> String {
    format!("{} {}\n", now.format("%Y-%m-%d %H:%M:%S"), msg.replace('\n', " "))
}

/// Append `msg` to `dir/startup-error.log`. Best effort, always.
///
/// This runs on a path where something has already gone wrong; failing to write
/// the note about the failure must not become a second failure.
fn write_startup_error(dir: &std::path::Path, msg: &str) {
    use std::io::Write;
    let _ = std::fs::create_dir_all(dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("startup-error.log"))
    {
        let _ = f.write_all(startup_error_line(chrono::Local::now(), msg).as_bytes());
    }
}

/// Record a fatal startup error and turn it into the boxed error `setup` wants.
fn fatal(dir: Option<&std::path::Path>, msg: String) -> Box<dyn std::error::Error> {
    eprintln!("[t-money] FATAL: {msg}");
    let dir = dir.map(|d| d.to_path_buf()).unwrap_or_else(std::env::temp_dir);
    write_startup_error(&dir, &msg);
    msg.into()
}

/// Application entry point.
pub fn run() {
    tauri::Builder::default()
        // One copy of the app.
        //
        // FIRST, before every other plugin: this one decides whether the
        // process lives at all, and anything set up ahead of it is set up in a
        // process that is about to exit.
        //
        // Two copies open on the same file are two writers against one SQLite
        // database. The file association makes that easy to do by
        // accident — double-click a .tmny while T-Money is running and Windows
        // starts a second process — so the second process hands its arguments
        // to the first and exits.
        //
        // What the running copy then does is the useful part: it OPENS that
        // file. Focusing an existing window and ignoring the file you just
        // double-clicked would be technically correct and infuriating.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Bring the window back first, whatever else happens: the user
            // just double-clicked something and expects to see the app.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            let Some(path) = file_argument(argv.into_iter().skip(1)) else {
                return;
            };
            // Already on it — say nothing rather than reloading the file the
            // user is looking at.
            // Through `files::is_same`, not `PathBuf` equality. A file
            // opened at startup is held in the recents list's `canonicalize`
            // spelling (`\\?\C:\…`) and Explorer passes `C:\…`, possibly in
            // another case — equal as files, never as `PathBuf`s, so the file
            // on screen was reloaded under the user (the path-comparison bug, again).
            let already = app
                .try_state::<AppState>()
                .and_then(|s| s.db_path.lock().ok().map(|p| files::is_same(&p, &path)))
                .unwrap_or(false);
            if already {
                return;
            }
            let Some(state) = app.try_state::<AppState>() else { return };
            let payload = match commands::open_file(
                state,
                path.to_string_lossy().to_string(),
                false,
                None,
            ) {
                Ok(f) => serde_json::json!({ "ok": true, "file": f }),
                // A file it cannot open is news, not silence: the frontend
                // shows it in the same banner a failed File → Open uses.
                Err(e) => serde_json::json!({ "ok": false, "error": e }),
            };
            let _ = app.emit("tm://file-opened", payload);
        }))
        .setup(|app| {
            let handle = app.handle().clone();

            // 1) DB path under the OS app-data dir — or a scratch directory,
            //    with its own keyring entry, when asked for.
            let scratch = scratch_data_dir(
                std::env::args_os().skip(1).map(|a| a.to_string_lossy().to_string()),
                std::env::var("T_MONEY_DATA_DIR").ok(),
            );
            let default_db_path = match &scratch {
                Some(dir) => {
                    let name = keyring::use_scratch_entry(dir);
                    eprintln!(
                        "[t-money] SCRATCH data dir {} (keyring entry {name})",
                        dir.display()
                    );
                    dir.join("t-money.db")
                }
                None => db_path(&handle).map_err(|e| fatal(None, e))?,
            };

            // The app's own config directory holds `files.json` — the
            // list of databases, which cannot live inside any of them.
            let config_dir = handle
                .path()
                .app_config_dir()
                .map_err(|e| fatal(None, format!("no config directory: {e}")))?;

            // Open the file that was open last, if it is still there, and the
            // app's own otherwise. A scratch run ignores the list entirely:
            // the whole point of `--data-dir` is that it touches nothing real.
            // A file named on the command line wins over the recents
            // list: you double-clicked THAT file, and "it opened the one I had
            // open last instead" would be indefensible. A scratch run still
            // ignores both.
            let opened_with = file_argument(std::env::args_os().skip(1).map(|a| a.to_string_lossy().to_string()));
            let remembered = match &scratch {
                Some(_) => None,
                None => startup_file(opened_with, files::last_opened(&config_dir), &default_db_path),
            };
            if let Some(p) = &remembered {
                eprintln!("[t-money] opening {} (last used)", p.display());
            }

            // 2) Ensure a master key exists for THIS file. Each file has its
            //    own; the app's own database keeps the original account
            //    name so every install that predates this still opens.
            //
            // 3) Open the encrypted DB, apply the key, run migrations.
            //
            //    THE REMEMBERED FILE CANNOT BE ALLOWED TO BRICK STARTUP.
            //    This used to be one path and one `fatal`, which meant a file
            //    that had moved, lost its key, or been written by a build that
            //    is no longer installed made the app unstartable: it opened a
            //    window with nothing in it, every launch, with no way back to
            //    the app's own database from inside the app. A file you opened
            //    once must never be able to do that. So the remembered file is
            //    tried, and its failure is a NOTE — the app falls back to its
            //    own database and says what happened.
            let mut note: Option<String> = None;
            let open = |p: &std::path::PathBuf| -> Result<(db::pool::DbPool, String), String> {
                let account = keyring::account_for(p, Some(&default_db_path));
                // NEVER invent a key for a file that already exists.
                //
                // `ensure_key_in` generates one when the keyring has none,
                // which is right for a database being created and disastrous
                // for one that is already there: the fresh key cannot decrypt
                // it, SQLCipher reports "file is not a database", and startup
                // died on it. That is what bricked the installed app — it was
                // pointed at a file whose key lives under another account, so
                // it made up a new key and then failed to open its own work.
                //
                // `open_file` already refuses this. Startup has to
                // refuse it too, and the refusal is a message, not a death.
                if let Some(why) = remembered_problem(true, keyring::has_key_in(&account)) {
                    if p.exists() {
                        return Err(why.to_string());
                    }
                }
                let (key, created) = startup_key(
                    p.exists(),
                    || keyring::get_key_in(&account),
                    || keyring::ensure_key_in(&account),
                )
                .map_err(|e| {
                    eprintln!("[t-money] keyring unavailable for {} ({e}); not opening it", p.display());
                    KEYRING_UNREACHABLE.to_string()
                })?;
                if created {
                    // True now: `ensure_key_in` returns a new key only after
                    // `set_key_in` succeeded.
                    eprintln!("[t-money] generated a new master key ({account}) and stored it in the OS keyring");
                }
                db::pool::init_pool(p, &key).map(|pool| (pool, account))
            };

            let mut path = default_db_path.clone();
            let mut opened: Option<(db::pool::DbPool, String)> = None;
            if let Some(p) = remembered {
                let account = keyring::account_for(&p, Some(&default_db_path));
                match remembered_problem(p.exists(), keyring::has_key_in(&account)) {
                    Some(why) => {
                        eprintln!("[t-money] not opening {}: {why}", p.display());
                        note = Some(fallback_note(&p, why));
                    }
                    None => match open(&p) {
                        Ok(v) => {
                            path = p;
                            opened = Some(v);
                        }
                        Err(e) => {
                            eprintln!("[t-money] {} would not open ({e}); falling back", p.display());
                            note = Some(fallback_note(&p, &e));
                        }
                    },
                }
            }
            // And if nothing was opened, NOTHING IS OPENED.
            //
            // The app used to fall back to its own database here, which is
            // where "it now defaults to opening without a database" came
            // from: after File → Close there is no remembered file, so the
            // next launch quietly opened T-Money's own empty database and
            // showed a complete, working, wrong set of accounts. There is a
            // start screen for exactly this moment; startup should use it
            // rather than guess. So the pool stays empty, `current_file`
            // reports `is_open: false`, and the start screen offers the file
            // that was open last, the recents, Open… and New.
            //
            // Nothing here is fatal any more either: there is no file to fail
            // to open. The first real open happens when the user picks one,
            // and it reports its own errors, on screen, with a way back.
            if opened.is_none() && note.is_none() && scratch.is_none() {
                // The old install whose only file IS the app's database.
                if open_own_database_unasked(default_db_path.exists(), !files::recent(&config_dir).is_empty()) {
                    match open(&default_db_path) {
                        Ok(v) => {
                            eprintln!("[t-money] opening the app's own database (no other file has ever been opened)");
                            opened = Some(v);
                        }
                        Err(e) => {
                            eprintln!("[t-money] the app's own database would not open ({e})");
                            note = Some(fallback_note(&default_db_path, &e));
                        }
                    }
                }
            }
            let (pool, key_account) = match opened {
                Some((p, a)) => (Some(p), a),
                None => {
                    eprintln!("[t-money] no file to open; starting on the start screen");
                    (None, keyring::account_for(&path, Some(&default_db_path)))
                }
            };

            // 4) Take the daily automatic backup, if one is configured and due.
            //
            //    Before the pool is handed to Tauri, and deliberately soft: a
            //    backup that cannot be written must never stop the app opening.
            //    The whole point is that this happens without being asked.
            //
            //    Never from a scratch run: a real backup restored into the
            //    scratch directory carries the real backup folder in its
            //    settings, and the scratch file would then be written there
            //    and PRUNE the genuine backups down to `keep`.
            if pool.is_none() {
                // Nothing open, nothing to back up. The backup runs on the
                // next launch that actually opens a file.
            } else if scratch.is_some() {
                eprintln!("[t-money] automatic backup disabled for a scratch data dir");
            } else if let Some(pool) = &pool {
                match backup::run_if_due(pool, chrono::Local::now()) {
                    Ok(Some(p)) => eprintln!("[t-money] automatic backup written to {}", p.display()),
                    Ok(None) => {}
                    Err(e) => eprintln!("[t-money] automatic backup skipped: {e}"),
                }
            }

            // 5) Bind into Tauri managed state (pool behind a Mutex<Option> so
            //    restore / master-key change can drop and rebuild it in place).
            // Remember what we opened, so next launch comes back to it —
            // only when something WAS opened: recording a file the app
            // did not open is how the start screen would be skipped next time.
            // And never the app's OWN database. Recents is the list of
            // files the user chose; T-Money's own is not one of them, and once
            // it is in the list every later launch reads it back as the file
            // that was open last. That is how this became sticky rather than a
            // one-off: the old-install exemption below opens it, step 5 wrote it
            // down, and from then on it was "remembered".
            if scratch.is_none() && pool.is_some() && !files::is_same(&path, &default_db_path) {
                let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
                if let Err(e) = files::remember(&config_dir, &path, &now) {
                    eprintln!("[t-money] could not record the open file: {e}");
                }
            }

            app.manage(AppState {
                pool: std::sync::Mutex::new(pool),
                db_path: std::sync::Mutex::new(path),
                key_account: std::sync::Mutex::new(key_account),
                config_dir,
                default_db_path,
                scratch_dir: scratch,
                undo: std::sync::Mutex::new(Default::default()),
                startup_note: std::sync::Mutex::new(note),
            });

            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        // Opens an attachment in whatever the OS uses for the type.
        .plugin(tauri_plugin_opener::init())
        // Window size / position / maximized state survive a restart: saved
        // on close to `.window-state.json` in the app config dir, restored
        // when the window is created (and so before it is shown). Nothing
        // financial lives there.
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            // Accounts
            commands::get_favorite_accounts,
            commands::get_all_accounts,
            commands::create_account,
            commands::set_account_currency,
            commands::list_currencies,
            commands::list_regions,
            commands::get_file_format,
            commands::set_region,
            commands::set_home_currency,
            commands::list_exchange_rates,
            commands::set_exchange_rate,
            commands::delete_exchange_rate,
            commands::fetch_exchange_rates,
            commands::delete_account,
            commands::merge_accounts,
            commands::update_holdings,
            commands::autobudget,
            commands::apply_autobudget,
            commands::get_occurrences,
            commands::set_transaction_tax_line,
            commands::export_qif,
            commands::get_ui_setting,
            commands::set_ui_setting,
            commands::reconcile_through,
            commands::fill_symbols_from_names,
            commands::get_roi,
            commands::get_performance,
            commands::set_favorite,
            commands::get_account,
            commands::update_account,
            // Transactions
            commands::get_transactions,
            commands::create_transaction,
            commands::update_transaction,
            commands::delete_transaction,
            commands::set_void,
            commands::get_register,
            // Payees
            commands::list_payees,
            commands::list_split_descriptions,
            commands::create_payee,
            // Search
            commands::search_transactions,
            commands::update_payee,
            commands::merge_payees,
            commands::delete_payee,
            // Reconcile
            commands::get_open_statement,
            commands::get_last_statement,
            commands::start_statement,
            commands::set_cleared,
            commands::discard_statement,
            commands::finish_statement,
            // Categories
            commands::list_categories,
            commands::create_category,
            commands::update_category,
            commands::delete_category,
            commands::merge_categories,
            commands::preview_category_merge,
            commands::seed_standard_categories,
            // Budgets & spending
            commands::get_spending_summary,
            commands::get_budget_grid,
            commands::get_budget_starter,
            commands::set_budget,
            commands::list_budgets,
            commands::delete_budget,
            // The year plan
            commands::get_year_plan,
            commands::set_budget_plan,
            commands::clear_budget_plan,
            commands::plan_from_history,
            commands::apply_year_plan,
            // Goals
            commands::list_goals,
            commands::create_goal,
            commands::update_goal,
            commands::delete_goal,
            commands::set_account_tax_included,
            commands::set_account_value_rounding,
            commands::verify_file,
            commands::list_payee_rules,
            commands::create_payee_rule,
            commands::delete_payee_rule,
            commands::apply_payee_rules,
            commands::find_duplicates,
            commands::write_text_file,
            commands::preview_csv,
            commands::import_csv,
            commands::preview_import,
            commands::import_with_decisions,
            commands::set_account_value,
            commands::set_account_security,
            commands::debts_by_asset,
            commands::get_loan_terms,
            commands::set_loan_terms,
            commands::clear_loan_terms,
            commands::loan_schedule,
            commands::next_loan_payment,
            commands::record_loan_payment,
            commands::set_transaction_goal,
            commands::contribute_to_goal,
            // Classifications
            commands::list_classifications,
            commands::create_classification,
            commands::rename_classification,
            commands::delete_classification,
            commands::create_classification_value,
            commands::rename_classification_value,
            commands::delete_classification_value,
            commands::set_transaction_classes,
            // Prices
            commands::price_status,
            // Scheduled bills and income — these replaced the one-off
            // payment commands, which migration 0019 folded into rules.
            commands::list_recurrences,
            commands::create_recurrence,
            commands::update_recurrence,
            commands::delete_recurrence,
            commands::set_recurrence_active,
            commands::get_upcoming,
            commands::enter_occurrence,
            commands::skip_occurrence,
            commands::clear_occurrence,
            commands::get_cash_forecast,
            // Investments
            commands::list_securities,
            commands::create_security,
            commands::update_security,
            commands::delete_security,
            commands::list_security_prices,
            commands::set_security_price,
            commands::delete_security_price,
            commands::create_investment_transaction,
            commands::update_investment_transaction,
            commands::create_share_transfer,
            commands::list_lots,
            commands::get_disposals,
            commands::get_portfolio,
            commands::refresh_investment_prices,
            // Common Transactions
            commands::list_common_transactions,
            commands::create_common_transaction,
            commands::touch_common_transaction,
            commands::delete_common_transaction,
            // Reports
            commands::list_reports,
            commands::run_report,
            commands::get_transaction_account,
            commands::list_saved_reports,
            commands::save_report,
            commands::delete_saved_report,
            // Import
            commands::import_qif_ofx,
            // Keyring
            commands::get_key_status,
            commands::change_master_key,
            commands::export_master_key,
            commands::save_master_key,
            // Automatic backup
            commands::get_backup_config,
            commands::set_backup_config,
            commands::backup_now,
            // Transfers
            commands::create_transfer,
            commands::update_transfer,
            commands::convert_to_transfer,
            commands::convert_from_transfer,
            commands::set_account_order,
            commands::list_attachments,
            commands::add_attachment,
            commands::remove_attachment,
            commands::open_attachment,
            commands::save_attachment,
            // Splits
            commands::list_splits,
            // Backup / restore
            commands::get_db_info,
            commands::current_file,
            commands::list_recent_files,
            commands::forget_file,
            commands::open_file,
            commands::create_sample_file,
            commands::close_file,
            commands::preview_payee_rules,
            commands::preview_tsp,
            commands::import_tsp,
            commands::startup_note,
            commands::undo_status,
            commands::undo_last,
            commands::redo_last,
            commands::backup_database,
            commands::restore_database,
            // Development only — refuses in a release build. The generator
            // itself ships (create_sample_file uses it). See `db::demo`.
            commands::seed_demo_data,
        ])
        .build(tauri::generate_context!())
        .expect("error while building T-Money")
        // The backup on the way out.
        //
        // `ExitRequested` and not `Exit`: the managed state is still alive
        // here, which is the only reason there is a pool to VACUUM from. It is
        // also deliberately BLOCKING — the window has gone, the process is
        // about to, and a backup that races the process death is not a backup.
        // A `VACUUM INTO` of a file this size is well under a second; the
        // switch is off by default and in Settings for anyone it is not.
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                backup_on_exit(app);
            }
        });
}

/// Take the exit backup, and never let it stop the app closing.
///
/// Every branch here is a reason to do nothing rather than to fail: a lock we
/// cannot take, a file that is not open, a scratch run. Scratch is excluded for
/// the same reason startup excludes it — a scratch database carries the REAL
/// backup folder in its settings, so backing it up there would write a toy file
/// into the genuine folder and prune the real history down to `keep`.
fn backup_on_exit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state.scratch_dir.is_some() {
        eprintln!("[t-money] backup on exit disabled for a scratch data dir");
        return;
    }
    let Ok(guard) = state.pool.lock() else { return };
    let Some(pool) = guard.as_ref() else { return };
    match backup::run_on_exit(pool, chrono::Local::now()) {
        Ok(Some(p)) => eprintln!("[t-money] backup on exit written to {}", p.display()),
        Ok(None) => {}
        Err(e) => eprintln!("[t-money] backup on exit skipped: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, m: u32, d: u32, h: u32, mi: u32, s: u32) -> chrono::DateTime<chrono::Local> {
        chrono::Local.with_ymd_and_hms(y, m, d, h, mi, s).unwrap()
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// An existing file is read its key and never given one; the
    /// keyring failing is an error either way, not an unstored key.
    #[test]
    fn startup_never_invents_a_key_and_never_opens_with_an_unstored_one() {
        let refuse = || -> Result<String, String> { Err("keyring get failed".into()) };
        let must_not_ensure = || -> Result<(String, bool), String> {
            panic!("an existing file must never be given a new key")
        };
        assert!(startup_key(true, refuse, must_not_ensure).is_err());
        assert_eq!(
            startup_key(true, || Ok("k1".into()), must_not_ensure).unwrap(),
            ("k1".to_string(), false)
        );

        let must_not_get = || -> Result<String, String> { panic!("a new file has nothing to read") };
        assert!(startup_key(false, must_not_get, || Err("keyring set failed".into())).is_err());
        assert_eq!(
            startup_key(false, must_not_get, || Ok(("k2".into(), true))).unwrap(),
            ("k2".to_string(), true)
        );
        // The reason reads as a clause inside the start screen's note.
        let note = fallback_note(std::path::Path::new(r"E:\Money\Sam.tmny"), KEYRING_UNREACHABLE);
        assert!(note.contains("(the Windows credential store could not be reached"), "{note}");
    }

    #[test]
    fn the_scratch_dir_comes_from_the_flag_then_the_env_then_nowhere() {
        let p = std::path::PathBuf::from;
        assert_eq!(scratch_data_dir(args(&["--data-dir", "E:\\scratch"]), None), Some(p("E:\\scratch")));
        assert_eq!(scratch_data_dir(args(&["--data-dir=E:\\scratch"]), None), Some(p("E:\\scratch")));
        assert_eq!(
            scratch_data_dir(args(&["--other"]), Some("E:\\fromenv".into())),
            Some(p("E:\\fromenv"))
        );
        // The flag wins over the variable.
        assert_eq!(
            scratch_data_dir(args(&["--data-dir", "E:\\flag"]), Some("E:\\env".into())),
            Some(p("E:\\flag"))
        );
        assert_eq!(scratch_data_dir(args(&[]), None), None);
        assert_eq!(scratch_data_dir(args(&["--data-dir"]), Some("  ".into())), None);
    }

    /// The rules that decide whether the file you left the app on is
    /// opened at all. One installed build died on the second of these:
    /// it was pointed at a file whose key was under another account, invented
    /// a key, and SQLCipher answered "file is not a database" — every launch,
    /// with no way back to the user's own data from inside the app.
    /// Double-clicking a .tmny in Explorer runs the app with the path
    /// as an argument. Which arguments count is the part worth pinning: an
    /// app that opens whatever is on its command line ends up trying to
    /// decrypt its own log file.
    #[test]
    fn the_file_windows_hands_us_is_picked_out_of_the_arguments() {
        let p = std::path::PathBuf::from;
        assert_eq!(file_argument(args(&[r"E:\Money\Sam.tmny"])), Some(p(r"E:\Money\Sam.tmny")));
        // Case does not matter on Windows, and the legacy extension still opens.
        assert_eq!(file_argument(args(&[r"E:\Money\SAM.TMNY"])), Some(p(r"E:\Money\SAM.TMNY")));
        assert_eq!(file_argument(args(&[r"E:\old\t-money.db"])), Some(p(r"E:\old\t-money.db")));

        // Flags are not files.
        assert_eq!(file_argument(args(&["--verbose"])), None);
        // And `--data-dir`'s VALUE is a directory, not something to open —
        // mistaking it for one would have a scratch run open the real file.
        assert_eq!(file_argument(args(&["--data-dir", r"E:\scratch"])), None);
        assert_eq!(
            file_argument(args(&["--data-dir", r"E:\scratch", r"E:\Money\Sam.tmny"])),
            Some(p(r"E:\Money\Sam.tmny"))
        );
        // Anything that is not a T-Money file is ignored rather than opened.
        assert_eq!(file_argument(args(&[r"E:\Money\notes.txt"])), None);
        assert_eq!(file_argument(args(&[])), None);
    }

    #[test]
    fn a_remembered_file_is_refused_rather_than_guessed_at() {
        // The ordinary case: there, and we hold its key.
        assert_eq!(remembered_problem(true, true), None);
        // Moved, renamed, or on a drive that is not plugged in.
        assert_eq!(remembered_problem(false, true), Some("it is no longer there"));
        // The brick. Never generate a key for a file that already exists.
        assert_eq!(
            remembered_problem(true, false),
            Some("no master key for it is stored on this machine")
        );
        // A path that is neither there nor keyed is still "not there" — the
        // simplest true thing, and the one the user can act on.
        assert_eq!(remembered_problem(false, false), Some("it is no longer there"));
    }

    /// The bug that was hit: File → Close, exit, relaunch, and up came
    /// t-money.db again.
    ///
    /// `last_opened` returns what `canonicalize` stored, and on Windows that
    /// carries the verbatim `\\?\` prefix. `default_db_path` never does. The
    /// guard was `!=` on `PathBuf`, so the two spellings of one file compared
    /// unequal and the app's own database was opened as a remembered file —
    /// every launch, with no way out from inside the app.
    #[test]
    fn the_apps_own_database_is_never_the_remembered_file_however_it_is_spelled() {
        use std::path::{Path, PathBuf};
        let default_db = Path::new(r"C:\Users\sam\AppData\Roaming\T-Money\t-money.db");

        // The spelling `canonicalize` produces on Windows. This is the one
        // that mattered, and the one a `!=` comparison lets through.
        let verbatim = PathBuf::from(r"\\?\C:\Users\sam\AppData\Roaming\T-Money\t-money.db");
        assert_ne!(verbatim, default_db.to_path_buf(), "the two spellings really are unequal");
        assert_eq!(startup_file(None, Some(verbatim), default_db), None);

        // And the plain spelling, and a case-different one.
        assert_eq!(startup_file(None, Some(default_db.to_path_buf()), default_db), None);
        let shouty = PathBuf::from(r"C:\USERS\SAM\AppData\Roaming\T-Money\T-MONEY.DB");
        assert_eq!(startup_file(None, Some(shouty), default_db), None);

        // A real file of the user's own is remembered, as it always was.
        let real = PathBuf::from(r"\\?\E:\Money\Sam.tmny");
        assert_eq!(startup_file(None, Some(real.clone()), default_db), Some(real));

        // A file named on the command line wins over the list, and is
        // NOT filtered: double-clicking a file is choosing it, even that one.
        let named = PathBuf::from(r"E:\Money\Other.tmny");
        assert_eq!(
            startup_file(Some(named.clone()), Some(PathBuf::from(r"E:\Money\Sam.tmny")), default_db),
            Some(named)
        );
        assert_eq!(
            startup_file(Some(default_db.to_path_buf()), None, default_db),
            Some(default_db.to_path_buf()),
            "you asked for it by name"
        );

        // Nothing anywhere is nothing — the start screen's case.
        assert_eq!(startup_file(None, None, default_db), None);
    }

    #[test]
    fn the_fallback_note_names_the_file_the_reason_and_what_it_did() {
        let note = fallback_note(
            std::path::Path::new(r"E:\Money\Sam.tmny"),
            "no master key for it is stored on this machine",
        );
        assert!(note.contains("Sam.tmny"), "name the file: {note}");
        assert!(note.contains("no master key"), "say why: {note}");
        // What it did is now "nothing" — the start screen asks. The old
        // wording promised a fallback that no longer happens, and a message
        // that says the app opened something when it did not is worse than no
        // message at all.
        assert!(note.contains("did not open a file"), "say what it did: {note}");
        assert!(
            !note.contains("your own file instead"),
            "no silent fallback to the app's own database any more: {note}"
        );
    }

    #[test]
    fn the_app_opens_its_own_database_unasked_only_for_the_install_that_has_no_other(
    ) {
        // The old install: its own database is the file, and a start
        // screen would look like the money had gone.
        assert!(open_own_database_unasked(true, false));
        // A user who has opened their own file: an empty app database is
        // NOT what they meant by launching. The start screen asks instead.
        assert!(!open_own_database_unasked(true, true));
        // Fresh install, nothing anywhere: there is nothing to open, so ask.
        assert!(!open_own_database_unasked(false, false));
        assert!(!open_own_database_unasked(false, true));
    }

    #[test]
    fn a_startup_error_line_is_timestamped_and_ends_in_a_newline() {
        let line = startup_error_line(at(2026, 9, 4, 7, 5, 3), "database init failed: bad key");
        assert_eq!(line, "2026-09-04 07:05:03 database init failed: bad key\n");
    }

    #[test]
    fn a_multi_line_message_stays_on_one_line() {
        // The log is read by eye and by `tail`; one failure must be one line.
        let line = startup_error_line(at(2026, 9, 4, 7, 5, 3), "first\nsecond");
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.ends_with("first second\n"));
    }

    #[test]
    fn errors_append_rather_than_replace_each_other() {
        let dir = std::env::temp_dir().join(format!("tm-startup-{}", uuid::Uuid::new_v4()));
        write_startup_error(&dir, "first failure");
        write_startup_error(&dir, "second failure");
        let body = std::fs::read_to_string(dir.join("startup-error.log")).unwrap();
        assert!(body.contains("first failure"), "the first error was lost: {body}");
        assert!(body.contains("second failure"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_directory_is_created_if_it_does_not_exist() {
        // The failure we most need to record is "the app data directory could
        // not be used", so writing the note cannot assume it is there.
        let dir = std::env::temp_dir()
            .join(format!("tm-startup-{}", uuid::Uuid::new_v4()))
            .join("nested");
        write_startup_error(&dir, "could not resolve app data dir");
        assert!(dir.join("startup-error.log").is_file());
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }
}
