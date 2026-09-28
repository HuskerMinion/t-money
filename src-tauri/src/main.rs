//! T-Money binary entry point.
//!
//! All logic lives in the `t_money` library crate; this is a thin wrapper so the
//! same code can be unit-tested and reused.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    t_money::run()
}
