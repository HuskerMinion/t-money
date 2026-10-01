//! Database layer: encrypted pool, migrations, and queries.

// Classifications. NOT development-only: this was inserted directly
// above `demo` and silently took its `#[cfg(debug_assertions)]`, so the whole
// feature compiled in every test run and vanished from the release build,
// which failed to compile at all. Anything added here goes BELOW the demo
// lines, or gets its own line above this comment.
pub mod classes;
#[cfg(test)]
mod currency_tests;

// Demo data. This used to be gated: it was `#[cfg(debug_assertions)]`, compiled
// out of release entirely, so that a personal-finance app could not ship a
// "fill my file with fake transactions" path however well hidden.
//
// What changed is that the app now has a legitimate release use for it —
// `commands::create_sample_file`, for handing a build to somebody to try —
// and the guarantee moved from the compiler to two runtime guards: that
// command opens with `create = true`, which REFUSES a path that already
// exists, and then refuses to seed anything holding transactions. So the
// seeder can only ever write into a file the same call brought into being.
//
// This is a weaker promise than "the code is not in the binary" and it is
// worth saying so out loud. `commands::seed_demo_data` — the one that seeds
// into whatever file is already OPEN — is still stubbed out in release, and
// that is the path that would actually be dangerous.
pub mod demo;
pub mod loans;
pub mod lots;
pub mod migration_fixtures;
pub mod migrations;
// The year plan. Below the demo lines, as the rule below requires.
pub mod plan;
pub mod pool;
pub mod queries;
pub mod undo;
pub mod reports;
pub mod standard_categories;
// The tests' shared database and its whole-file check. Gated by
// `#![cfg(test)]` inside the file, like `migration_fixtures`.
pub mod test_db;

/// A `#[cfg(debug_assertions)]` in this file gates the line AFTER it, and
/// nothing warns when that turns out to be the wrong line: every test runs in
/// debug, so a module accidentally gated compiles everywhere the suite looks
/// and is missing only from the release build — which then fails to compile,
/// on Windows, after the tests have all passed. That happened once
/// and again from the other direction: `demo` WAS gated, a release
/// command was written against it, and `cargo test` passed while
/// `cargo check --release` did not.
///
/// So: NO module in this file may be gated. `demo` was the last one, and
/// The sample file ungated it — the guarantee it carried now lives in
/// `create_sample_file`'s runtime guards, which the whole test suite can
/// actually see. If a module ever needs to be development-only again, it
/// needs a reason good enough to reopen this hole, and this test is where
/// that argument gets made.
#[test]
fn no_module_is_compiled_out_of_release_builds() {
    let src = include_str!("mod.rs");
    let lines: Vec<&str> = src.lines().map(str::trim).collect();
    let mut gated = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("#[cfg(debug_assertions)]") {
            let next = lines[i + 1..]
                .iter()
                .find(|l| !l.is_empty() && !l.starts_with("//"))
                .copied()
                .unwrap_or("");
            gated.push(next.to_string());
        }
    }
    assert!(
        gated.is_empty(),
        "compiled out of release builds, so `cargo test` cannot see them: {gated:?}"
    );
}
