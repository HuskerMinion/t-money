//! Shared application state, managed by Tauri.

use crate::db::pool::DbPool;
use std::path::PathBuf;
use std::sync::Mutex;

/// The single shared state object, bound via `app.manage(AppState)`.
///
/// It owns the encrypted DB connection pool (behind a `Mutex<Option<…>>` so
/// that restore / master-key-change can drop and rebuild the pool in place —
/// dropping the pool releases the OS file handles, which Windows requires
/// before the DB file can be overwritten) and the path to the database file.
///
/// The master key itself is NOT held here — it lives in the OS keyring and is
/// applied per-connection by the pool.
pub struct AppState {
    pub pool: Mutex<Option<DbPool>>,
    /// §98: the file that is open NOW. Behind a lock because File → Open
    /// swaps it at runtime — the pool already worked that way, and the path
    /// beside it was the thing that could not move.
    pub db_path: Mutex<PathBuf>,
    /// The keyring account holding the open file's key. Moves with `db_path`,
    /// since each file has its own key (§98).
    pub key_account: Mutex<String>,
    /// Where `files.json` lives: the app's own config directory. Fixed for
    /// the life of the process — it is about the app, not about a file.
    pub config_dir: PathBuf,
    /// The database the app used before it could open others, and the one it
    /// falls back to. Its key keeps the original keyring account.
    pub default_db_path: PathBuf,
    /// Set when the app was started against a scratch data directory
    /// (`--data-dir` / `T_MONEY_DATA_DIR`, §38) rather than the real one.
    /// Reported through `get_db_info` so the UI can say so on screen.
    pub scratch_dir: Option<PathBuf>,
    /// §101 — the undo stack. In memory and per process: undo is for the last
    /// few minutes, and one that survived a restart would invite undoing back
    /// through a session nobody remembers.
    pub undo: Mutex<crate::db::undo::Journal>,
    /// §102 — why the app is not on the file you left it on. Set at startup
    /// when the remembered file could not be opened and the app fell back to
    /// its own; read once by the UI, which shows it and clears it. A silent
    /// fallback is how a user ends up entering a week of transactions into
    /// the wrong database.
    pub startup_note: Mutex<Option<String>>,
}
