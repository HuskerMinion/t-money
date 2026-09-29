//! Automatic backups.
//!
//! The app is one encrypted file on one disk. Backup existed as a button in
//! Settings, and the honest expectation is that nobody presses it — so the
//! only backups that ever exist are the ones that happen without being asked.
//!
//! Deliberately simple, and deliberately conservative about deleting:
//!
//! - It runs **at startup**, at most once a day, and never blocks the UI.
//! - And **on the way out** — app exit and File → Close — when that is
//!   switched on. Same folder, same retention, same `VACUUM INTO`.
//! - It writes `t-money-YYYY-MM-DD-HHMM.db` — a `VACUUM INTO` copy, so it is
//!   a real database and **still encrypted with the same key**.
//! - Retention only ever removes files matching that exact name shape. A
//!   folder the user also keeps other things in is not ours to tidy.
//!
//! The backups are encrypted with the master key, which means a backup without
//! the key is unreadable. That is why the same change also made the key exportable — the
//! two features are one feature.

use crate::db::pool::DbPool;
use crate::db::queries;
use chrono::Local;
use std::path::{Path, PathBuf};

pub const FOLDER: &str = "backup.folder";
pub const ENABLED: &str = "backup.enabled";
pub const KEEP: &str = "backup.keep";
pub const LAST_AT: &str = "backup.last_at";
/// Take one when the app closes, or when a file is closed.
pub const ON_EXIT: &str = "backup.on_exit";

/// How long after the last backup an exit backup is worth taking.
///
/// NOT a change test, and the difference is worth stating. There is no cheap,
/// honest way to ask this file "has anything happened since 09:14" — WAL means
/// the database's own modification time barely moves, `data_version` only
/// reports other connections, and a real dirty flag would mean threading one
/// through every command that writes. So this is a floor on frequency instead:
/// close the app four times in an evening and you get one backup, not four.
///
/// That matters because retention is a fixed count. Without a floor, an
/// evening of opening and closing would push a fortnight of real history off
/// the end of `keep` and leave you with ten snapshots of the same hour.
const EXIT_MIN_GAP_MINUTES: i64 = 15;

const PREFIX: &str = "t-money-";
const SUFFIX: &str = ".db";
const DEFAULT_KEEP: usize = 10;

/// Write a `VACUUM INTO` copy to `target`, replacing whatever is already there.
///
/// **`VACUUM INTO` refuses to write a file that already exists.** The OS save
/// dialog's "a file with that name exists — replace it?" prompt only *chooses a
/// path*; it deletes nothing. So every backup taken over an existing name
/// failed, and the file the user had just been asked about, and agreed to
/// replace, still held whatever it held before. That is not a cosmetic error
/// message: it is how a restore hands back last week's data from a backup you
/// watched yourself take. It cost the user a morning's work.
///
/// The old file is moved aside rather than deleted, and put back if the vacuum
/// fails. A backup step must never be the reason a good backup stops existing.
pub fn vacuum_into(conn: &rusqlite::Connection, target: &Path) -> Result<(), String> {
    let previous = if target.exists() {
        let aside = target.with_extension("db.replacing");
        let _ = std::fs::remove_file(&aside);
        std::fs::rename(target, &aside)
            .map_err(|e| format!("could not replace {}: {e}", target.display()))?;
        Some(aside)
    } else {
        None
    };

    let escaped = target.to_string_lossy().replace('\'', "''");
    match conn.execute_batch(&format!("VACUUM INTO '{escaped}';")) {
        Ok(()) => {
            if let Some(aside) = previous {
                let _ = std::fs::remove_file(aside);
            }
            Ok(())
        }
        Err(e) => Err(restore_previous(target, previous.as_deref(), format!("backup failed: {e}"))),
    }
}

/// Put the user's previous backup back exactly as it was after a failed
/// vacuum, and return the error to report.
///
/// Both steps used to be `let _`. When the rename back failed — the
/// partial file still locked by a virus scanner, say — the user was told
/// "backup failed" and their previous backup was sitting under a name they
/// had never seen. Now the error says where it is. A partial target that
/// cannot be removed is said too, since it is not a backup.
fn restore_previous(target: &Path, previous: Option<&Path>, mut msg: String) -> String {
    let partial_stuck = match std::fs::remove_file(target) {
        Ok(()) => false,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    };
    if let Some(aside) = previous {
        if let Err(e) = std::fs::rename(aside, target) {
            msg.push_str(&format!(
                "; the previous backup could not be put back ({e}) and is still at {}",
                aside.display()
            ));
            return msg;
        }
    }
    if partial_stuck {
        msg.push_str(&format!(
            "; an incomplete file is left at {} and is not a usable backup",
            target.display()
        ));
    }
    msg
}

/// The name a backup taken now would get.
pub fn backup_name(now: chrono::DateTime<Local>) -> String {
    format!("{PREFIX}{}{SUFFIX}", now.format("%Y-%m-%d-%H%M"))
}

/// Is this one of ours? Retention must never touch anything else in the
/// folder — a user's backup directory is not the app's to prune.
///
/// The stamp itself is checked, digit by digit, not only its length.
/// Any 26-byte name with the prefix and suffix used to match — a user's own
/// `t-money-my-old-file-001.db` among them — and sorted in among the backups
/// for retention to delete.
pub fn is_ours(name: &str) -> bool {
    let Some(stamp) = name.strip_prefix(PREFIX).and_then(|s| s.strip_suffix(SUFFIX)) else {
        return false;
    };
    // YYYY-MM-DD-HHMM
    stamp.len() == 15
        && stamp.bytes().enumerate().all(|(i, b)| match i {
            4 | 7 | 10 => b == b'-',
            _ => b.is_ascii_digit(),
        })
}

/// Files we wrote, oldest first. The name sorts chronologically, which is why
/// it is shaped that way.
pub fn ours_in(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(is_ours)
                    .unwrap_or(false)
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    out.sort();
    out
}

/// Keep the newest `keep`, delete the rest. Returns how many were removed.
pub fn prune(dir: &Path, keep: usize) -> usize {
    let keep = keep.max(1);
    let files = ours_in(dir);
    if files.len() <= keep {
        return 0;
    }
    let mut removed = 0;
    for p in &files[..files.len() - keep] {
        if std::fs::remove_file(p).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Should a backup run now?
///
/// At most one a day. Comparing the DATE rather than an elapsed duration means
/// "once each day you use the app", which is what a person means by daily, and
/// it cannot be defeated by launching twice in an evening.
pub fn is_due(last_at: Option<&str>, today: &str) -> bool {
    match last_at {
        None => true,
        Some(prev) => prev.get(0..10).unwrap_or("") != today,
    }
}

/// Take a backup if one is due. Returns the path written, if any.
///
/// Every failure is soft: a backup that cannot be written must never stop the
/// app from opening. The caller logs and carries on.
pub fn run_if_due(pool: &DbPool, now: chrono::DateTime<Local>) -> Result<Option<PathBuf>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    if queries::get_setting(&conn, ENABLED)?.as_deref() != Some("1") {
        return Ok(None);
    }
    let Some(folder) = queries::get_setting(&conn, FOLDER)? else {
        return Ok(None);
    };
    if folder.trim().is_empty() {
        return Ok(None);
    }
    let today = now.format("%Y-%m-%d").to_string();
    let last = queries::get_setting(&conn, LAST_AT)?;
    if !is_due(last.as_deref(), &today) {
        return Ok(None);
    }

    take(&conn, &folder, now).map(Some)
}

/// Write the backup, stamp the time, prune. Shared by the startup rule and the
/// exit rule so the two can never drift into taking different KINDS of backup.
fn take(
    // The POOLED connection, not a bare `rusqlite::Connection`: `queries`
    // is written against the pool's type, and `vacuum_into` takes the bare one
    // by deref. Widening this to the bare type would compile everywhere except
    // the two `queries` calls below.
    conn: &r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>,
    folder: &str,
    now: chrono::DateTime<Local>,
) -> Result<PathBuf, String> {
    let dir = PathBuf::from(folder);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not use {folder}: {e}"))?;
    let target = dir.join(backup_name(now));

    // `VACUUM INTO` produces a real, still-encrypted database — the same
    // mechanism the manual button uses. Two "Back up now" presses in
    // the same minute land on the same name, so this has to replace.
    vacuum_into(conn, &target)?;

    queries::set_setting(conn, LAST_AT, &now.to_rfc3339())?;
    let keep = queries::get_setting(conn, KEEP)?
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(DEFAULT_KEEP);
    prune(&dir, keep);
    Ok(target)
}

/// Is an exit backup worth taking?
///
/// Never backed up at all: yes. A timestamp we cannot read: yes — an
/// unparseable setting is not a reason to skip a backup. A timestamp in the
/// FUTURE: yes, because a clock that has moved backwards would otherwise
/// suppress every backup until it caught up, and silently not backing up is
/// the one behavior this module must not have.
pub fn exit_is_due(
    last_at: Option<&str>,
    now: chrono::DateTime<Local>,
    min_gap_minutes: i64,
) -> bool {
    let Some(prev) = last_at else { return true };
    let Ok(t) = chrono::DateTime::parse_from_rfc3339(prev) else { return true };
    let gap = now.signed_duration_since(t.with_timezone(&Local));
    gap < chrono::Duration::zero() || gap.num_minutes() >= min_gap_minutes
}

/// A backup on the way out.
///
/// > *"How about a backup on exit?"*
///
/// The startup backup answers "you have not backed up today". This answers the
/// question that actually matters when a file lives on one machine and gets
/// carried to another: **is what I just did safe anywhere but here.** It runs
/// on app exit and on File → Close, which is what makes a synced backup folder
/// a workable way to move between computers — you leave, and a consistent
/// single-file copy is already on its way.
///
/// Soft in every direction, like the rest of this module. The caller logs and
/// carries on; a backup that will not write is never a reason the app cannot
/// close.
pub fn run_on_exit(pool: &DbPool, now: chrono::DateTime<Local>) -> Result<Option<PathBuf>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    // Its own switch, not `ENABLED`. "Back up once a day when I start" and
    // "back up whenever I leave" are different habits, and somebody who wants
    // the second should not have to take the first to get it. The FOLDER is
    // shared, because a second backup folder is a second thing to get wrong.
    if queries::get_setting(&conn, ON_EXIT)?.as_deref() != Some("1") {
        return Ok(None);
    }
    let Some(folder) = queries::get_setting(&conn, FOLDER)? else {
        return Ok(None);
    };
    if folder.trim().is_empty() {
        return Ok(None);
    }
    let last = queries::get_setting(&conn, LAST_AT)?;
    if !exit_is_due(last.as_deref(), now, EXIT_MIN_GAP_MINUTES) {
        return Ok(None);
    }
    take(&conn, &folder, now).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- vacuum_into: replacing an existing backup -------------------

    fn scratch(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("t-money-vac-{}-{}-{}", tag, std::process::id(), uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).expect("scratch dir");
        p
    }

    /// A source database with one row, encrypted the way the app encrypts.
    fn source(dir: &Path) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open(dir.join("live.db")).expect("open");
        conn.execute_batch("PRAGMA key = 'k';").expect("key");
        conn.execute_batch("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('today');")
            .expect("seed");
        conn
    }

    #[test]
    fn a_backup_replaces_a_file_that_is_already_there() {
        // The whole bug: VACUUM INTO refuses an existing target, so the file
        // the user agreed to replace kept its old contents and a later restore
        // handed back stale data.
        let dir = scratch("replace");
        let conn = source(&dir);
        let target = dir.join("t-money-backup.db");
        std::fs::write(&target, b"an older backup").expect("pre-existing file");

        vacuum_into(&conn, &target).expect("replacing an existing backup must work");

        let bytes = std::fs::read(&target).expect("read");
        assert_ne!(bytes, b"an older backup", "the old file was left in place");
        assert!(bytes.len() > 512, "the replacement is not a real database");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_replacement_is_still_encrypted() {
        // Replacing must not quietly change what a backup *is*.
        let dir = scratch("enc");
        let conn = source(&dir);
        let target = dir.join("t-money-backup.db");
        std::fs::write(&target, b"older").expect("pre-existing file");

        vacuum_into(&conn, &target).expect("vacuum");

        let bytes = std::fs::read(&target).expect("read");
        assert!(
            bytes.len() < 16 || &bytes[0..16] != b"SQLite format 3\0",
            "the replacement was written UNENCRYPTED"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_backup_puts_the_previous_one_back() {
        // A backup step must never be the reason a good backup stops existing.
        // The failure used here is the real one: a connection that cannot read
        // the source, because no key was applied to an encrypted file.
        let dir = scratch("rollback");
        drop(source(&dir)); // creates and closes an encrypted live.db

        let target = dir.join("t-money-backup.db");
        std::fs::write(&target, b"the only copy I have").expect("pre-existing file");

        let keyless = rusqlite::Connection::open(dir.join("live.db")).expect("open");
        let outcome = vacuum_into(&keyless, &target);
        assert!(outcome.is_err(), "an unreadable source should not report success");

        assert_eq!(
            std::fs::read(&target).expect("read"),
            b"the only copy I have",
            "the previous backup was destroyed by a failed one"
        );
        assert!(
            !dir.join("t-money-backup.db.replacing").exists(),
            "the moved-aside copy was left behind instead of being put back"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_replacing_sidecar_is_left_behind() {
        // The file moved aside during a successful replace is ours to clean up,
        // and `is_ours` would not prune it.
        let dir = scratch("sidecar");
        let conn = source(&dir);
        let target = dir.join("t-money-backup.db");
        std::fs::write(&target, b"older").expect("pre-existing file");

        vacuum_into(&conn, &target).expect("vacuum");

        assert!(
            !dir.join("t-money-backup.db.replacing").exists(),
            "a .replacing sidecar was left in the user's backup folder"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_backup_name_sorts_chronologically() {
        use chrono::TimeZone;
        let a = backup_name(Local.with_ymd_and_hms(2026, 9, 4, 8, 5, 0).unwrap());
        let b = backup_name(Local.with_ymd_and_hms(2026, 9, 4, 19, 30, 0).unwrap());
        let c = backup_name(Local.with_ymd_and_hms(2026, 10, 1, 1, 0, 0).unwrap());
        assert_eq!(a, "t-money-2026-09-04-0805.db");
        assert!(a < b && b < c, "names must sort by time: {a} {b} {c}");
    }

    #[test]
    fn only_our_own_files_are_recognized() {
        // Retention deletes things. It must never look at a folder and decide
        // somebody else's file is stale.
        assert!(is_ours("t-money-2026-09-04-0805.db"));
        assert!(!is_ours("t-money-backup.db"));
        assert!(!is_ours("taxes-2024.db"));
        assert!(!is_ours("t-money-2026-09-04-0805.db.bak"));
        assert!(!is_ours("photos.db"));
        assert!(!is_ours("t-money-.db"));
        // The right length is not enough.
        assert_eq!("t-money-my-old-file-001.db".len(), "t-money-2026-09-04-0805.db".len());
        assert!(!is_ours("t-money-my-old-file-001.db"));
        assert!(!is_ours("t-money-2026_09_04_0805.db"));
        assert!(!is_ours("t-money-2026-09-04-08O5.db"));
        assert!(!is_ours("t-money-20260904-080500.db"));
    }

    /// A lookalike next to real backups survives retention.
    #[test]
    fn retention_does_not_prune_a_lookalike_name() {
        let dir = scratch("lookalike");
        for n in ["t-money-2026-09-01-0800.db", "t-money-2026-09-02-0800.db", "t-money-2026-09-03-0800.db"] {
            std::fs::write(dir.join(n), b"backup").unwrap();
        }
        // Sorts before every real one, so it would be the first deleted.
        std::fs::write(dir.join("t-money-0ld-copy-keep12.db"), b"mine").unwrap();
        assert_eq!(prune(&dir, 1), 2);
        assert!(dir.join("t-money-0ld-copy-keep12.db").exists(), "retention deleted the user's file");
        assert!(dir.join("t-money-2026-09-03-0800.db").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// When the previous backup cannot be put back, the error says
    /// where it is rather than leaving it under a name the user never saw.
    #[test]
    fn a_previous_backup_that_cannot_be_put_back_is_named_in_the_error() {
        let dir = scratch("stuck");
        // A directory where the backup should be: it cannot be removed as a
        // file, and nothing can be renamed over it.
        let target = dir.join("t-money-backup.db");
        std::fs::create_dir_all(target.join("inside")).unwrap();
        let aside = dir.join("t-money-backup.db.replacing");
        std::fs::write(&aside, b"the only copy I have").unwrap();

        let msg = restore_previous(&target, Some(&aside), "backup failed: x".to_string());
        assert!(msg.starts_with("backup failed: x; the previous backup could not be put back"), "{msg}");
        assert!(msg.contains(&aside.display().to_string()), "{msg}");
        assert_eq!(std::fs::read(&aside).unwrap(), b"the only copy I have");

        // Nothing to put back and nothing left over: the error is unchanged.
        let clean = dir.join("t-money-other.db");
        assert_eq!(restore_previous(&clean, None, "backup failed: y".to_string()), "backup failed: y");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_backup_is_due_once_a_day() {
        assert!(is_due(None, "2026-09-04"), "never backed up");
        assert!(is_due(Some("2026-09-03T22:00:00+01:00"), "2026-09-04"));
        assert!(!is_due(Some("2026-09-04T08:00:00+01:00"), "2026-09-04"));
        // Launching twice in an evening must not take two.
        assert!(!is_due(Some("2026-09-04T23:59:00+01:00"), "2026-09-04"));
    }

    // --- The exit backup's frequency floor -------------------------

    fn at(s: &str) -> chrono::DateTime<Local> {
        chrono::DateTime::parse_from_rfc3339(s).expect("timestamp").with_timezone(&Local)
    }

    #[test]
    fn an_exit_backup_waits_out_the_gap_after_the_last_one() {
        let now = at("2026-09-10T21:00:00+01:00");
        assert!(exit_is_due(None, now, 15), "never backed up");
        assert!(exit_is_due(Some("2026-09-10T20:44:00+01:00"), now, 15), "16 minutes ago");
        assert!(exit_is_due(Some("2026-09-10T20:45:00+01:00"), now, 15), "exactly 15 minutes");
        assert!(!exit_is_due(Some("2026-09-10T20:46:00+01:00"), now, 15), "14 minutes ago");
        assert!(!exit_is_due(Some("2026-09-10T20:59:30+01:00"), now, 15), "half a minute ago");
    }

    /// Closing four times in an evening must leave a fortnight of history in
    /// the folder, not four snapshots of the same hour. This is the whole
    /// reason there is a floor.
    #[test]
    fn closing_repeatedly_does_not_churn_the_retention_window() {
        let start = at("2026-09-10T20:00:00+01:00");
        let mut last = Some("2026-09-10T19:58:00+01:00".to_string());
        let mut taken = 0;
        for minute in 0..40 {
            let now = start + chrono::Duration::minutes(minute);
            if exit_is_due(last.as_deref(), now, 15) {
                taken += 1;
                last = Some(now.to_rfc3339());
            }
        }
        assert_eq!(taken, 2, "40 minutes of open-and-close should take 2 backups, not 40");
    }

    #[test]
    fn a_timestamp_we_cannot_read_never_suppresses_a_backup() {
        let now = at("2026-09-10T21:00:00+01:00");
        assert!(exit_is_due(Some(""), now, 15));
        assert!(exit_is_due(Some("last tuesday"), now, 15));
        assert!(exit_is_due(Some("2026-09-10"), now, 15), "a bare date is not RFC-3339");
    }

    /// A clock that moved backwards would otherwise suppress every backup
    /// until it caught up — silently not backing up is the one behavior this
    /// module must not have.
    #[test]
    fn a_timestamp_from_the_future_still_backs_up() {
        let now = at("2026-09-10T21:00:00+01:00");
        assert!(exit_is_due(Some("2026-09-11T09:00:00+01:00"), now, 15));
    }

    #[test]
    fn pruning_keeps_the_newest_and_leaves_strangers_alone() {
        let dir = std::env::temp_dir().join(format!("tm-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let names = [
            "t-money-2026-09-01-0800.db",
            "t-money-2026-09-02-0800.db",
            "t-money-2026-09-03-0800.db",
            "t-money-2026-09-04-0800.db",
        ];
        for n in names {
            std::fs::write(dir.join(n), b"x").expect("write");
        }
        // Things that are not ours, including a near-miss.
        std::fs::write(dir.join("household-budget.db"), b"x").expect("write");
        std::fs::write(dir.join("t-money-backup.db"), b"x").expect("write");

        let removed = prune(&dir, 2);

        assert_eq!(removed, 2);
        assert!(!dir.join(names[0]).exists());
        assert!(!dir.join(names[1]).exists());
        assert!(dir.join(names[2]).exists(), "newest must survive");
        assert!(dir.join(names[3]).exists());
        assert!(dir.join("household-budget.db").exists(), "deleted a stranger's file");
        assert!(dir.join("t-money-backup.db").exists(), "deleted the manual backup");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pruning_never_empties_the_folder() {
        let dir = std::env::temp_dir().join(format!("tm-prune0-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(dir.join("t-money-2026-09-01-0800.db"), b"x").expect("write");
        // keep = 0 is a configuration mistake, not an instruction to delete
        // every backup the user has.
        assert_eq!(prune(&dir, 0), 0);
        assert!(dir.join("t-money-2026-09-01-0800.db").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pruning_a_missing_folder_is_harmless() {
        assert_eq!(prune(Path::new("/definitely/not/here"), 3), 0);
        assert!(ours_in(Path::new("/definitely/not/here")).is_empty());
    }
}
