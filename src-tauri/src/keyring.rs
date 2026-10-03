//! Master-key management via the OS keyring (Windows Credential Manager,
//! macOS Keychain, Linux Secret Service).
//!
//! The AES-256 passphrase is stored in the OS keyring, never in the database
//! file or any plaintext config. On first run we generate a random key and
//! store it; on subsequent runs we retrieve it.

use keyring::Entry;
use rand::RngCore;
use std::sync::OnceLock;

const SERVICE: &str = "com.tmoney.desktop";
const ACCOUNT: &str = "master-key";

/// The keyring account name in use. `master-key` for the real database; a
/// name derived from the data directory when the app runs against a scratch
/// one. Set once at startup, before any other call here.
static ACCOUNT_NAME: OnceLock<String> = OnceLock::new();

/// Use a keyring entry private to `data_dir`, so a scratch database never
/// reads — and, on first run or Change Master Key, never OVERWRITES — the
/// entry that opens the real file. That risk is the whole reason first run
/// had never been tested. Returns the account name chosen.
pub fn use_scratch_entry(data_dir: &std::path::Path) -> String {
    let name = scratch_account_name(data_dir);
    let _ = ACCOUNT_NAME.set(name.clone());
    name
}

/// `master-key.scratch.<hash of the directory>` — stable for the same
/// directory across runs, distinct for different ones.
pub fn scratch_account_name(data_dir: &std::path::Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    crate::files::fold_case(&data_dir.to_string_lossy()).hash(&mut h);
    format!("{ACCOUNT}.scratch.{:016x}", h.finish())
}

fn account() -> &'static str {
    ACCOUNT_NAME.get().map(String::as_str).unwrap_or(ACCOUNT)
}

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, account()).map_err(|e| format!("keyring entry error: {e}"))
}

// ---------------------------------------------------------------------------
// A key per FILE.
//
// One key for the whole app was right while there was one database. With
// several, sharing a key would mean that changing one file's key silently
// changed every other file's — and that copying a file to another machine
// carried a key that machine also used for something else. So each file's key
// lives under its own account, derived from where the file is.
//
// THE DEFAULT FILE KEEPS THE OLD ACCOUNT. Every install that exists today has
// its key under plain `master-key`, and deriving a new account name for that
// same file would leave a database nobody could open. `account_for` returns
// the legacy name for the default path and a derived one for anything else.
// ---------------------------------------------------------------------------

/// The keyring account that holds `path`'s key. `default_path` is the app's
/// own database — the one that predates this section — and keeps the original
/// account name.
///
/// When the current spelling of the path names a different account from the
/// one used before it (`legacy_normalize`) and only the old account holds a
/// key, the key is copied forward, so a file that opened yesterday still
/// opens. The old entry is left in place — deleting a key is not something a
/// lookup should ever do.
pub fn account_for(path: &std::path::Path, default_path: Option<&std::path::Path>) -> String {
    if let Some(d) = default_path {
        if same_file(path, d) {
            return account().to_string();
        }
    }
    let name = file_account_name(&normalize(path));
    let legacy = file_account_name(&legacy_normalize(path));
    if legacy != name && !has_key_in(&name) {
        if let Ok(k) = get_key_in(&legacy) {
            if !k.is_empty() {
                if set_key_in(&name, &k).is_err() {
                    // Could not copy it: the old account still opens the file.
                    return legacy;
                }
            }
        }
    }
    name
}

/// `master-key.file.<hash of the normalized path>`.
fn file_account_name(normalized: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    normalized.hash(&mut h);
    format!("{ACCOUNT}.file.{:016x}", h.finish())
}

/// Two spellings of one path — case, separators, the `\\?\` prefix — must
/// name one key, or opening the same file two ways would ask for two.
///
/// **a file that does not exist yet resolves through its folder.**
/// `canonicalize` fails for it, and this used to hash the spelling as typed —
/// which is exactly when a new file's key is stored. The next launch found
/// the file, canonicalized it, and on a mapped network drive (`Z:\` becomes
/// `\\?\UNC\server\share\`), a `subst` drive or a path through a junction got
/// a different spelling, a different account, and "this file was not created
/// on this computer". Canonicalizing the parent and appending the name gives
/// the spelling the finished file will have. Only when the folder cannot be
/// resolved either is the path used as given.
///
/// And `\\?\UNC\server\share` is written `//server/share` — the same string a
/// UNC path typed by hand normalizes to — rather than `unc/server/share`.
fn normalize(path: &std::path::Path) -> String {
    let resolved = path
        .canonicalize()
        .ok()
        .or_else(|| {
            let name = path.file_name()?;
            let parent = path.parent().filter(|p| !p.as_os_str().is_empty())?;
            parent.canonicalize().ok().map(|p| p.join(name))
        })
        .unwrap_or_else(|| path.to_path_buf());
    spelling(&resolved.to_string_lossy())
}

/// The string half of `normalize`, with no filesystem access — so the UNC
/// rule is tested without a test touching the network.
fn spelling(s: &str) -> String {
    let s = match s.strip_prefix("\\\\?\\UNC\\") {
        Some(rest) => format!("\\\\{rest}"),
        None => s.trim_start_matches("\\\\?\\").to_string(),
    };
    crate::files::fold_case(&s.replace('\\', "/"))
}

/// `normalize` as it was before its spelling changed, kept only so `account_for` can find a
/// key stored under it.
fn legacy_normalize(path: &std::path::Path) -> String {
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    crate::files::fold_case(&resolved.to_string_lossy().trim_start_matches("\\\\?\\").replace('\\', "/"))
}

fn same_file(a: &std::path::Path, b: &std::path::Path) -> bool {
    normalize(a) == normalize(b)
}

fn entry_named(name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, name).map_err(|e| format!("keyring entry error: {e}"))
}

// ---------------------------------------------------------------------------
// No keyring at all.
//
// Windows and macOS always have one. Linux has one on any GNOME or KDE
// desktop, but not on every system: a minimal desktop, a server, WSL. There,
// every save fails, and T-Money used to fail with the library's own words.
//
// So: say plainly that no keyring is running (the NO_KEYRING token, beside
// NEEDS_KEY and WRONG_KEY in commands.rs), and let the person keep the key
// themselves if they would rather. A key typed in on such a system is held
// in memory for this run only — never written anywhere — so the file stays
// usable until T-Money closes, and the key is asked for again next time.
// ---------------------------------------------------------------------------

/// The token an error starts with when no keyring is running.
pub const NO_KEYRING: &str = "NO_KEYRING";

/// What to say when there is none, after the token — in the words of the
/// system it is running on.
#[cfg(target_os = "macos")]
pub const NO_KEYRING_WHY: &str = "the macOS Keychain can't be reached (it may be locked), so T-Money cannot keep keys. Unlock it in Keychain Access, or keep the key yourself";
#[cfg(windows)]
pub const NO_KEYRING_WHY: &str = "Windows Credential Manager can't be reached, so T-Money cannot keep keys. Sign out and back in, or keep the key yourself";
#[cfg(not(any(windows, target_os = "macos")))]
pub const NO_KEYRING_WHY: &str = "no keyring is running on this computer, so T-Money cannot keep keys. Start or install one (GNOME Keyring or KWallet) and restart T-Money, or keep the key yourself";

/// Keys typed in this run while no keyring was running. Memory only.
fn session() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static S: OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

fn session_key(name: &str) -> Option<String> {
    session().lock().ok()?.get(name).cloned()
}

fn forget_session_key(name: &str) {
    if let Ok(mut s) = session().lock() {
        s.remove(name);
    }
}

/// True when `set_key_in` failed only because no keyring is running: the key
/// is then held for this run, which is all a caller that just used it needs.
pub fn is_no_keyring(err: &str) -> bool {
    err.starts_with(NO_KEYRING)
}

/// Is there a keyring to keep keys in? "No such entry" is an answer from a
/// working store; only a store that cannot be reached counts as none.
///
/// The keyring library connects to the store once per run. A keyring that
/// was not there when T-Money started is found only after a restart, which
/// is why every message about it says to restart T-Money.
pub fn store_available() -> bool {
    match entry_named("t-money.probe").and_then(|e| Ok(e.get_password())) {
        Ok(Ok(_)) | Ok(Err(keyring::Error::NoEntry)) => true,
        Ok(Err(keyring::Error::NoStorageAccess(_))) | Ok(Err(keyring::Error::PlatformFailure(_))) | Ok(Err(keyring::Error::NoDefaultStore)) => false,
        Ok(Err(_)) => true,
        Err(_) => false,
    }
}

/// Is there a key for this account?
pub fn has_key_in(name: &str) -> bool {
    session_key(name).is_some() || entry_named(name).map(|e| e.get_password().is_ok()).unwrap_or(false)
}

pub fn get_key_in(name: &str) -> Result<String, String> {
    if let Some(k) = session_key(name) {
        return Ok(k);
    }
    entry_named(name)?.get_password().map_err(|e| format!("keyring get failed: {e}"))
}

/// Keep a key. With no keyring running it is held for this run instead,
/// and the answer is a NO_KEYRING error, so a caller that must not carry on
/// without it (changing the master key) knows.
pub fn set_key_in(name: &str, key: &str) -> Result<(), String> {
    let keep_for_session = || {
        if let Ok(mut s) = session().lock() {
            s.insert(name.to_string(), key.to_string());
        }
        Err(format!("{NO_KEYRING}: {NO_KEYRING_WHY}"))
    };
    // No store at all: not even an entry can be made.
    let Ok(entry) = entry_named(name) else { return keep_for_session() };
    match entry.set_password(key) {
        Ok(()) => {
            forget_session_key(name);
            Ok(())
        }
        // A keyring that is there but cannot store (locked with nothing to
        // unlock it, or with no collection to keep keys in) is no keyring.
        Err(e) if unreachable(&e) || !store_available() => keep_for_session(),
        Err(e) => Err(format!("keyring set failed: {e}")),
    }
}

/// Remove an entry. One that is not there is not an error: the point is
/// that afterwards it is gone.
pub fn delete_key_in(name: &str) -> Result<(), String> {
    if let Ok(mut s) = session().lock() {
        s.remove(name);
    }
    // No store at all: nothing in it to delete.
    let Ok(entry) = entry_named(name) else { return Ok(()) };
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(_) if !store_available() => Ok(()),
        Err(e) if !has_key_in(name) => {
            let _ = e;
            Ok(())
        }
        Err(e) => Err(format!("keyring delete failed: {e}")),
    }
}

/// The key for an account, generating and storing one if there is none.
/// Returns `(key, created_new)` — the caller cares, because a brand new key
/// against a file that already has data means the file will not open.
///
/// With no keyring it does NOT make one up: a key held only in memory would
/// lock the person out of their new file the moment T-Money closed. It
/// answers NO_KEYRING, and the screen offers to let them keep a key
/// themselves.
pub fn ensure_key_in(name: &str) -> Result<(String, bool), String> {
    if let Ok(k) = get_key_in(name) {
        if !k.is_empty() {
            return Ok((k, false));
        }
    }
    if !store_available() {
        return Err(format!("{NO_KEYRING}: {NO_KEYRING_WHY}"));
    }
    let k = generate_key();
    // Straight to the store, not through `set_key_in`: a key made up here
    // must not be held for the session when the store refuses it.
    let Ok(entry) = entry_named(name) else { return Err(format!("{NO_KEYRING}: {NO_KEYRING_WHY}")) };
    match entry.set_password(&k) {
        Ok(()) => {
            forget_session_key(name);
            Ok((k, true))
        }
        Err(e) if unreachable(&e) => Err(format!("{NO_KEYRING}: {NO_KEYRING_WHY}")),
        Err(e) => Err(format!("keyring set failed: {e}")),
    }
}

/// An error that means the store itself cannot be used, as opposed to a
/// problem with one entry.
fn unreachable(e: &keyring::Error) -> bool {
    matches!(
        e,
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) | keyring::Error::NoDefaultStore
    )
}

/// True if a master key already exists in the keyring.
pub fn has_key() -> bool {
    entry().map(|e| e.get_password().is_ok()).unwrap_or(false)
}

/// Retrieve the stored master key.
pub fn get_key() -> Result<String, String> {
    entry()?.get_password().map_err(|e| format!("keyring get failed: {e}"))
}

/// Store a master key in the keyring.
pub fn set_key(key: &str) -> Result<(), String> {
    entry()?
        .set_password(key)
        .map_err(|e| format!("keyring set failed: {e}"))
}

/// Generate a cryptographically random 32-byte key, hex-encoded (64 chars).
///
/// Uses the OS CSPRNG (`rand::rngs::OsRng`, backed by `getrandom` —
/// `BCryptGenRandom` on Windows, `getrandom(2)` on Linux, `SecRandomCopyBytes`
/// on macOS). No user input or time-based seeding.
pub fn generate_key() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Ensure a master key exists: return the stored one, or generate + store a new
/// one. Returns `(key, created_new)`.
pub fn ensure_key() -> Result<(String, bool), String> {
    if let Ok(k) = get_key() {
        if !k.is_empty() {
            return Ok((k, false));
        }
    }
    let k = generate_key();
    set_key(&k)?;
    Ok((k, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scratch_entry_is_named_for_its_directory_and_never_the_real_one() {
        let a = scratch_account_name(std::path::Path::new("C:\\scratch\\one"));
        let b = scratch_account_name(std::path::Path::new("C:\\scratch\\two"));
        assert_ne!(a, ACCOUNT);
        assert_ne!(b, ACCOUNT);
        assert_ne!(a, b);
        assert!(a.starts_with("master-key.scratch."));
        // Case-insensitive where the filesystem is (Windows, macOS); on
        // Linux the case is part of the name.
        let upper = scratch_account_name(std::path::Path::new("c:\\SCRATCH\\one"));
        if cfg!(any(windows, target_os = "macos")) {
            assert_eq!(a, upper);
        } else {
            assert_ne!(a, upper);
        }
    }

    fn temp(tag: &str) -> std::path::PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let d = std::env::temp_dir().join(format!("tm-keyring-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// The key is stored when the file does not exist yet and looked
    /// up after it does. Both must name one account. The spelling here goes
    /// through `sub\..`, which `canonicalize` resolves exactly as it resolves
    /// a mapped drive or a junction: a path that is not the one typed.
    #[test]
    fn a_file_names_the_same_account_before_and_after_it_exists() {
        let dir = temp("before-after");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let typed = dir.join("sub").join("..").join("New.tmny");
        let before = normalize(&typed);
        let before_account = file_account_name(&before);
        // What the old spelling hashed: the path as typed, `..` and all.
        assert_ne!(legacy_normalize(&typed), legacy_normalize(&dir.join("New.tmny")));

        std::fs::write(dir.join("New.tmny"), b"x").unwrap();
        assert_eq!(normalize(&typed), before);
        assert_eq!(normalize(&dir.join("New.tmny")), before);
        // Another case of the name is the same file only where the
        // filesystem ignores case.
        assert_eq!(
            file_account_name(&normalize(&dir.join("new.TMNY"))) == before_account,
            cfg!(any(windows, target_os = "macos"))
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_path_whose_folder_does_not_exist_either_is_used_as_given() {
        let p = std::path::Path::new(r"Q:\no\such\folder\f.tmny");
        assert_eq!(normalize(p), crate::files::fold_case("Q:/no/such/folder/f.tmny"));
    }

    #[test]
    fn a_verbatim_unc_path_and_a_typed_one_normalize_alike() {
        // `\\?\UNC\server\share` is what a mapped drive canonicalizes
        // to; it used to become `unc/server/share`, never `//server/share`.
        // `spelling`, not `normalize`: resolving a made-up server would wait
        // on the network.
        let verbatim = spelling(r"\\?\UNC\nas\money\Sam.tmny");
        assert_eq!(verbatim, crate::files::fold_case("//nas/money/Sam.tmny"));
        assert_eq!(verbatim, spelling(r"\\nas\money\Sam.tmny"));
        assert_eq!(spelling(r"\\?\C:\Money\f.tmny"), crate::files::fold_case("C:/Money/f.tmny"));
    }

    /// The real key store of the computer it runs on: Credential Manager,
    /// the macOS Keychain, or a Linux Secret Service. Ignored by default
    /// because it writes to that store; run it by name on a new platform:
    /// `cargo test --lib os_key_store -- --ignored --nocapture`.
    /// It uses a throwaway entry and removes it.
    #[test]
    #[ignore]
    fn os_key_store_round_trip() {
        let name = format!("test.round-trip.{}", std::process::id());
        assert!(!has_key_in(&name), "a fresh name is not there yet");
        let (key, created) = ensure_key_in(&name).expect("the OS key store took a new key");
        assert!(created);
        assert_eq!(get_key_in(&name).unwrap(), key, "read back what was written");
        let (again, created) = ensure_key_in(&name).unwrap();
        assert_eq!((again.as_str(), created), (key.as_str(), false), "a second ask finds the same key");
        delete_key_in(&name).unwrap();
        assert!(!has_key_in(&name), "deleted");
        delete_key_in(&name).expect("deleting what is gone is not an error");
        println!("OS key store round trip ok");
    }

    /// With NO keyring running (a Linux system with none): nothing is made
    /// up, a typed key lasts the run, and the errors say NO_KEYRING. Run by
    /// hand where no keyring is reachable:
    /// `cargo test --lib no_keyring -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn no_keyring_session_only() {
        // Either no keyring at all, or one that cannot store: both must
        // come out as NO_KEYRING.
        let name = format!("test.no-keyring.{}", std::process::id());
        println!("store_available() = {}", store_available());
        let e = ensure_key_in(&name).unwrap_err();
        assert!(e.starts_with(NO_KEYRING), "a new file gets no invented key: {e}");
        assert!(!has_key_in(&name));
        let typed = generate_key();
        let e = set_key_in(&name, &typed).unwrap_err();
        assert!(e.starts_with(NO_KEYRING), "{e}");
        // ...but the typed key opens the file for the rest of this run.
        assert!(has_key_in(&name));
        assert_eq!(get_key_in(&name).unwrap(), typed);
        assert_eq!(ensure_key_in(&name).unwrap(), (typed, false));
        delete_key_in(&name).unwrap();
        assert!(!has_key_in(&name));
        println!("no-keyring session ok");
    }
}
