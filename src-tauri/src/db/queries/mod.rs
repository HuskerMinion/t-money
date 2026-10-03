//! SQL queries. Every function takes a pooled connection and returns typed
//! models. Money is stored as integer cents (i64).
//!
//! One file per area; everything is re-exported here, so callers keep
//! writing `queries::name`.

mod common;
mod accounts;
mod attachments;
mod categories;
mod transactions;
mod splits;
mod budgets;
mod goals;
mod investments;
mod payees;
mod reconcile;
mod common_transactions;
mod recurrences;
mod search;
mod settings;
mod verify;
mod fx;
mod simplefin;

#[cfg(test)]
mod test_support;

pub use common::*;
pub use accounts::*;
pub use attachments::*;
pub use categories::*;
pub use transactions::*;
pub use splits::*;
pub use budgets::*;
pub use goals::*;
pub use investments::*;
pub use payees::*;
pub use reconcile::*;
pub use common_transactions::*;
pub use recurrences::*;
pub use search::*;
pub use settings::*;
pub use verify::*;
pub use fx::*;
pub use simplefin::*;
