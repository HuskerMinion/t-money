//! T-Money files: which database is open, and which ones were open before.
//!
//! > *"for the database location it needs to be changeable … that needs to be
//! > selectable and is one of the reasons I wanted the File menu too so users
//! > could open/close different t-money files (named whatever they want)"*
//!
//! Until now there was exactly one database, at a path nobody chose, inside
//! `%APPDATA%\com.tmoney.desktop\t-money`. Money kept its file wherever you
//! put it and remembered the last few, and that is a difference in kind: a
//! file you chose the name and the folder of is a document, and a file the app
//! hid in AppData is a setting. This makes it a document.
//!
//! WHERE THE LIST LIVES. Everything else this app knows is inside the
//! database. The list of databases cannot be — a file cannot hold the record
//! of which file to open — so it is the one piece of state outside them all:
//! `files.json` in the app config directory, holding the recents and which
//! one to open next time. It is deliberately tiny and deliberately not
//! authoritative: a path in it that no longer exists is reported, never
//! silently dropped, because a missing file is news.
//!
//! KEYS. Each file is encrypted with its own master key, and each key lives
//! under its own keyring account derived from the file's path — see
//! `keyring::account_for`. Sharing one key across files would mean that
//! copying a file to another machine, or changing one file's key, quietly
//! changed the others.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// What a T-Money file is called on disk. `.db` still opens — every file that
/// existed before this section has that extension — but a new one gets an
/// extension of its own, so the file manager can tell what it is and so Open
/// has something to filter on.
pub const EXT: &str = "tmny";
pub const LEGACY_EXT: &str = "db";

/// How many recents are kept. Money showed four; eight costs nothing and a
/// long list is its own kind of clutter.
const KEEP: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecentFile {
    /// Absolute path, as it will be opened.
    pub path: String,
    /// The file's own name without its extension — what the user called it.
    pub name: String,
    /// ISO-8601 local time it was last opened.
    pub last_opened: String,
    /// False when the path is no longer there. Reported rather than removed:
    /// a database that has gone missing is the most important thing this list
    /// can tell you.
    pub exists: bool,
    /// True when this computer holds no key that opens this file.
    ///
    /// Always false out of `recent()`: this module knows about paths and the
    /// recents store, and deliberately not about the keyring. The command
    /// layer fills it in, where the keyring and the default database's path
    /// are both to hand. `serde(default)` so an older recents file — or any
    /// caller that builds one of these without thinking about keys — still
    /// deserializes.
    #[serde(default)]
    pub needs_key: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    /// Most recent first.
    recent: Vec<StoredFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredFile {
    path: String,
    last_opened: String,
}

/// The display name of a file: its stem, so `Sam 2026.tmny` is "Sam 2026".
pub fn display_name(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// Add `.tmny` when the user typed a bare name, and leave any extension they
/// did type alone — including `.db`, which is what every file made before
/// this section is called.
pub fn with_extension(path: &Path) -> PathBuf {
    match path.extension() {
        Some(_) => path.to_path_buf(),
        None => path.with_extension(EXT),
    }
}

/// Is this a name we will open? Anything, in truth — SQLCipher does not care
/// what a file is called — but the file dialog filters on these two and a
/// mistyped path is better caught here than by a migration.
pub fn looks_like_a_file(path: &Path) -> bool {
    match path.extension().map(|e| e.to_string_lossy().to_lowercase()) {
        Some(e) => e == EXT || e == LEGACY_EXT,
        None => false,
    }
}

fn store_path(config_dir: &Path) -> PathBuf {
    config_dir.join("files.json")
}

fn read_store(config_dir: &Path) -> Store {
    match std::fs::read_to_string(store_path(config_dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Store::default(),
    }
}

fn write_store(config_dir: &Path, store: &Store) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|e| format!("could not create {}: {e}", config_dir.display()))?;
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    // Written whole, to a temp file, then renamed: a half-written recents list
    // is how an app forgets where every one of your files is.
    let tmp = store_path(config_dir).with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, store_path(config_dir)).map_err(|e| format!("could not save the file list: {e}"))
}

/// The recents, newest first, each marked with whether it is still there.
pub fn recent(config_dir: &Path) -> Vec<RecentFile> {
    read_store(config_dir)
        .recent
        .into_iter()
        .map(|f| {
            let p = PathBuf::from(&f.path);
            RecentFile {
                name: display_name(&p),
                exists: p.exists(),
                path: f.path,
                last_opened: f.last_opened,
                // Filled in by `commands::list_recent_files`; see the field.
                needs_key: false,
            }
        })
        .collect()
}

/// Note that `path` was just opened: to the front, deduplicated, capped.
pub fn remember(config_dir: &Path, path: &Path, now: &str) -> Result<(), String> {
    let canonical = canonical_string(path);
    let mut store = read_store(config_dir);
    store.recent.retain(|f| !same_path(&f.path, &canonical));
    store.recent.insert(
        0,
        StoredFile { path: canonical, last_opened: now.to_string() },
    );
    store.recent.truncate(KEEP);
    write_store(config_dir, &store)
}

/// Drop one from the list — for "the file is gone, stop offering it".
pub fn forget(config_dir: &Path, path: &Path) -> Result<(), String> {
    let canonical = canonical_string(path);
    let mut store = read_store(config_dir);
    store.recent.retain(|f| !same_path(&f.path, &canonical));
    write_store(config_dir, &store)
}

/// The file to open at startup: the most recent one that still exists, or
/// `None` for "use the default". A missing most-recent falls THROUGH to the
/// next rather than to the default — a user who keeps two files and loses one
/// wants the other, not an empty one they have never seen.
pub fn last_opened(config_dir: &Path) -> Option<PathBuf> {
    read_store(config_dir)
        .recent
        .into_iter()
        .map(|f| PathBuf::from(f.path))
        .find(|p| p.exists())
}

/// Resolve for comparison, falling back to the path as given — a file that
/// does not exist yet cannot be canonicalized, and that is the normal case
/// when creating one.
fn canonical_string(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

/// `same_path` over two `Path`s.
///
/// The reason this exists as its own function: startup compared a remembered
/// path with the app's own with plain `PathBuf` equality, and on Windows they
/// are never equal. `last_opened` returns what `canonical_string` stored,
/// which `canonicalize` gives the verbatim `\\?\` prefix; `default_db_path`
/// comes from Tauri's config dir and has no prefix at all. So the one guard
/// meant to stop the app treating its own database as a remembered file
/// compared `\\?\C:\…\t-money.db` with `C:\…\t-money.db`, found them
/// different, and opened it. Any path comparison in this application goes
/// through here.
pub fn is_same(a: &Path, b: &Path) -> bool {
    same_path(&a.to_string_lossy(), &b.to_string_lossy())
}

/// Windows paths differ only by case and by the `\\?\` prefix canonicalize
/// adds; two spellings of one file must not both sit in the list.
pub fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.trim_start_matches("\\\\?\\")
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_lowercase()
    };
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The comparison startup got wrong. `canonicalize` writes the
    /// verbatim prefix on Windows and Tauri's config dir does not, so the two
    /// spellings of one file are unequal as `PathBuf`s and identical as files.
    #[test]
    fn is_same_sees_through_the_verbatim_prefix_the_slashes_and_the_case() {
        let plain = Path::new(r"C:\Users\sam\AppData\Roaming\T-Money\t-money.db");
        assert!(is_same(Path::new(r"\\?\C:\Users\sam\AppData\Roaming\T-Money\t-money.db"), plain));
        assert!(is_same(Path::new(r"C:\USERS\SAM\AppData\Roaming\T-Money\T-MONEY.DB"), plain));
        assert!(is_same(plain, plain));
        // Two genuinely different files stay different.
        assert!(!is_same(Path::new(r"E:\Money\Sam.tmny"), plain));
        assert!(!is_same(Path::new(r"C:\Users\sam\AppData\Roaming\T-Money\other.db"), plain));
    }

    fn temp(tag: &str) -> PathBuf {
        let mut d = std::env::temp_dir();
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        d.push(format!("tm-files-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_name_becomes_a_file_name_and_an_extension_the_user_typed_is_left_alone() {
        assert_eq!(with_extension(Path::new("/x/Sam 2026")), PathBuf::from("/x/Sam 2026.tmny"));
        // The files that already exist are .db and must keep opening.
        assert_eq!(with_extension(Path::new("/x/t-money.db")), PathBuf::from("/x/t-money.db"));
        assert!(looks_like_a_file(Path::new("/x/a.tmny")));
        assert!(looks_like_a_file(Path::new("/x/a.DB")));
        assert!(!looks_like_a_file(Path::new("/x/a.txt")));
        assert_eq!(display_name(Path::new("/x/Sam 2026.tmny")), "Sam 2026");
    }

    #[test]
    fn the_recents_are_newest_first_deduplicated_and_capped() {
        let dir = temp("recents");
        let f = |n: &str| dir.join(format!("{n}.tmny"));
        for n in ["a", "b", "c"] {
            std::fs::write(f(n), b"x").unwrap();
        }
        remember(&dir, &f("a"), "2026-09-01T10:00:00").unwrap();
        remember(&dir, &f("b"), "2026-09-02T10:00:00").unwrap();
        remember(&dir, &f("c"), "2026-09-03T10:00:00").unwrap();
        // Opening `a` again moves it to the front rather than listing it twice.
        remember(&dir, &f("a"), "2026-09-04T10:00:00").unwrap();

        // Newest first: `a` was opened last, then `c`, then `b`. Not
        // alphabetical and not insertion order — the list answers "what was I
        // just working on", so re-opening a file moves it to the top.
        let r = recent(&dir);
        assert_eq!(r.iter().map(|x| x.name.clone()).collect::<Vec<_>>(), ["a", "c", "b"]);
        assert_eq!(r[0].last_opened, "2026-09-04T10:00:00");
        assert!(r.iter().all(|x| x.exists));

        for i in 0..10 {
            let p = dir.join(format!("many{i}.tmny"));
            std::fs::write(&p, b"x").unwrap();
            remember(&dir, &p, "2026-09-05T10:00:00").unwrap();
        }
        assert_eq!(recent(&dir).len(), KEEP);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_that_has_gone_missing_is_reported_not_quietly_dropped() {
        // The single most useful thing this list can say. Removing the entry
        // would leave the user with no idea the file was ever there.
        let dir = temp("missing");
        let gone = dir.join("gone.tmny");
        std::fs::write(&gone, b"x").unwrap();
        remember(&dir, &gone, "2026-09-01T10:00:00").unwrap();
        std::fs::remove_file(&gone).unwrap();

        let r = recent(&dir);
        assert_eq!(r.len(), 1);
        assert!(!r[0].exists, "the entry stays, marked missing");

        // And it is not what we open at startup.
        assert_eq!(last_opened(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn startup_falls_through_a_missing_file_to_the_next_one_that_is_there() {
        let dir = temp("fallthrough");
        let kept = dir.join("kept.tmny");
        let lost = dir.join("lost.tmny");
        std::fs::write(&kept, b"x").unwrap();
        std::fs::write(&lost, b"x").unwrap();
        remember(&dir, &kept, "2026-09-01T10:00:00").unwrap();
        remember(&dir, &lost, "2026-09-02T10:00:00").unwrap();
        std::fs::remove_file(&lost).unwrap();

        // Not the default, and not nothing: the other file the user keeps.
        assert_eq!(last_opened(&dir).map(|p| display_name(&p)), Some("kept".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_spellings_of_one_windows_path_are_one_entry() {
        assert!(same_path("C:\\Users\\t\\M.tmny", "c:/users/t/m.tmny"));
        assert!(same_path("\\\\?\\C:\\x\\a.tmny", "C:\\x\\a.tmny"));
        assert!(!same_path("C:\\x\\a.tmny", "C:\\x\\b.tmny"));
    }

    #[test]
    fn forgetting_removes_exactly_one() {
        let dir = temp("forget");
        for n in ["a", "b"] {
            let p = dir.join(format!("{n}.tmny"));
            std::fs::write(&p, b"x").unwrap();
            remember(&dir, &p, "2026-09-01T10:00:00").unwrap();
        }
        forget(&dir, &dir.join("a.tmny")).unwrap();
        assert_eq!(recent(&dir).iter().map(|x| x.name.clone()).collect::<Vec<_>>(), ["b"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
