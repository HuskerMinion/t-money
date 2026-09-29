//! Money's default category list.
//!
//! A brand-new Money file is not empty — it ships a standard chart of
//! categories and you prune it. An empty category list makes every picker in
//! the app useless (the Budget screen in particular offers nothing), so a
//! fresh database gets this set automatically (`pool::init_pool`), and an
//! existing one can pull in whatever it is missing via the
//! `seed_standard_categories` command.
//!
//! Seeding is **additive and idempotent**: it inserts by name, skips anything
//! already present, and never touches a category the user has edited. Running
//! it twice adds nothing the second time.
//!
//! Note the deliberate name collisions — `Automobile : Insurance` next to a
//! top-level `Insurance`, `Home : Repairs` next to
//! `Automobile : Repairs & Maintenance`. Money allows them; the original
//! schema's global `UNIQUE(name)` did not, which is why migration 0015 exists.

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

/// One row of the standard chart.
pub struct StdCategory {
    /// `None` for a top-level category, else the parent's exact name.
    pub parent: Option<&'static str>,
    pub name: &'static str,
    /// "income" | "expense". A child is forced to its parent's kind.
    pub kind: &'static str,
    /// Tax form line, where Money's mapping is unambiguous. These are the
    /// seed for the Taxes module — the reason to set them now
    /// rather than when Taxes is built.
    pub tax_line: Option<&'static str>,
}

const fn c(
    parent: Option<&'static str>,
    name: &'static str,
    kind: &'static str,
    tax_line: Option<&'static str>,
) -> StdCategory {
    StdCategory { parent, name, kind, tax_line }
}

/// Parents must appear before their children.
pub const STANDARD_CATEGORIES: &[StdCategory] = &[
    // ── Income ────────────────────────────────────────────────────────────
    c(None, "Wages & Salary", "income", Some("Form 1040: Wages")),
    c(Some("Wages & Salary"), "Gross Pay", "income", None),
    c(Some("Wages & Salary"), "Bonus", "income", None),
    c(Some("Wages & Salary"), "Commission", "income", None),
    c(Some("Wages & Salary"), "Overtime", "income", None),
    c(Some("Wages & Salary"), "Tips", "income", None),
    c(None, "Interest Income", "income", Some("Schedule B: Interest income")),
    c(None, "Dividend Income", "income", Some("Schedule B: Dividend income")),
    c(None, "Investment Income", "income", None),
    c(Some("Investment Income"), "Capital Gains", "income", Some("Schedule D: Capital gains")),
    c(Some("Investment Income"), "Realized Gain/Loss", "income", None),
    c(None, "Retirement Income", "income", None),
    c(Some("Retirement Income"), "Pension", "income", Some("Form 1040: Pensions and annuities")),
    c(Some("Retirement Income"), "Social Security", "income", Some("Form 1040: Social security benefits")),
    c(Some("Retirement Income"), "IRA Distribution", "income", Some("Form 1040: IRA distributions")),
    c(None, "Other Income", "income", None),
    c(Some("Other Income"), "Gift Received", "income", None),
    c(Some("Other Income"), "Rebate/Refund", "income", None),
    c(Some("Other Income"), "Reimbursement", "income", None),
    c(Some("Other Income"), "Rental Income", "income", Some("Schedule E: Rents received")),
    c(Some("Other Income"), "Tax Refund", "income", None),

    // ── Expense ───────────────────────────────────────────────────────────
    c(None, "Automobile", "expense", None),
    c(Some("Automobile"), "Car Payment", "expense", None),
    c(Some("Automobile"), "Fuel", "expense", None),
    c(Some("Automobile"), "Insurance", "expense", None),
    c(Some("Automobile"), "Parking", "expense", None),
    c(Some("Automobile"), "Public Transportation", "expense", None),
    c(Some("Automobile"), "Registration", "expense", None),
    c(Some("Automobile"), "Repairs & Maintenance", "expense", None),
    c(None, "Bank Charges", "expense", None),
    c(Some("Bank Charges"), "ATM Fee", "expense", None),
    c(Some("Bank Charges"), "Interest Paid", "expense", None),
    c(Some("Bank Charges"), "Service Charge", "expense", None),
    c(None, "Bills & Utilities", "expense", None),
    c(Some("Bills & Utilities"), "Cable/Satellite", "expense", None),
    c(Some("Bills & Utilities"), "Electric", "expense", None),
    c(Some("Bills & Utilities"), "Internet", "expense", None),
    c(Some("Bills & Utilities"), "Mobile Phone", "expense", None),
    c(Some("Bills & Utilities"), "Natural Gas", "expense", None),
    c(Some("Bills & Utilities"), "Telephone", "expense", None),
    c(Some("Bills & Utilities"), "Trash", "expense", None),
    c(Some("Bills & Utilities"), "Water & Sewer", "expense", None),
    c(None, "Charity", "expense", None),
    c(Some("Charity"), "Cash Contributions", "expense", Some("Schedule A: Cash contributions")),
    c(Some("Charity"), "Non-Cash Contributions", "expense", Some("Schedule A: Non-cash contributions")),
    c(None, "Childcare", "expense", None),
    c(None, "Clothing", "expense", None),
    c(None, "Dining Out", "expense", None),
    c(None, "Education", "expense", None),
    c(Some("Education"), "Books & Supplies", "expense", None),
    c(Some("Education"), "Student Loan", "expense", Some("Form 1040: Student loan interest")),
    c(Some("Education"), "Tuition", "expense", Some("Form 8863: Qualified education expenses")),
    c(None, "Entertainment", "expense", None),
    c(Some("Entertainment"), "Books & Magazines", "expense", None),
    c(Some("Entertainment"), "Hobbies", "expense", None),
    c(Some("Entertainment"), "Movies & DVDs", "expense", None),
    c(Some("Entertainment"), "Music", "expense", None),
    c(Some("Entertainment"), "Sporting Events", "expense", None),
    c(Some("Entertainment"), "Subscriptions", "expense", None),
    c(None, "Gifts Given", "expense", None),
    c(None, "Groceries", "expense", None),
    c(None, "Healthcare", "expense", None),
    c(Some("Healthcare"), "Dentist", "expense", Some("Schedule A: Medical and dental expenses")),
    c(Some("Healthcare"), "Doctor", "expense", Some("Schedule A: Medical and dental expenses")),
    c(Some("Healthcare"), "Health Insurance", "expense", Some("Schedule A: Medical and dental expenses")),
    c(Some("Healthcare"), "Pharmacy", "expense", Some("Schedule A: Medical and dental expenses")),
    c(Some("Healthcare"), "Vision", "expense", Some("Schedule A: Medical and dental expenses")),
    c(None, "Home", "expense", None),
    c(Some("Home"), "Furnishings", "expense", None),
    c(Some("Home"), "HOA Dues", "expense", None),
    c(Some("Home"), "Home Improvement", "expense", None),
    c(Some("Home"), "Home Insurance", "expense", None),
    c(Some("Home"), "Lawn & Garden", "expense", None),
    c(Some("Home"), "Mortgage Interest", "expense", Some("Schedule A: Home mortgage interest")),
    c(Some("Home"), "Mortgage Principal", "expense", None),
    c(Some("Home"), "Rent", "expense", None),
    c(Some("Home"), "Repairs", "expense", None),
    c(None, "Insurance", "expense", None),
    c(Some("Insurance"), "Disability Insurance", "expense", None),
    c(Some("Insurance"), "Life Insurance", "expense", None),
    c(None, "Personal Care", "expense", None),
    c(Some("Personal Care"), "Hair Care", "expense", None),
    c(Some("Personal Care"), "Toiletries", "expense", None),
    c(None, "Pets", "expense", None),
    c(Some("Pets"), "Pet Food", "expense", None),
    c(Some("Pets"), "Veterinary", "expense", None),
    c(None, "Taxes", "expense", None),
    c(Some("Taxes"), "Federal Income Tax", "expense", Some("W-2: Federal income tax withheld")),
    c(Some("Taxes"), "Local Income Tax", "expense", Some("Schedule A: State and local income taxes")),
    c(Some("Taxes"), "Medicare Tax", "expense", Some("W-2: Medicare tax withheld")),
    c(Some("Taxes"), "Property Tax", "expense", Some("Schedule A: Real estate taxes")),
    c(Some("Taxes"), "Social Security Tax", "expense", Some("W-2: Social security tax withheld")),
    c(Some("Taxes"), "State Income Tax", "expense", Some("Schedule A: State and local income taxes")),
    c(None, "Travel", "expense", None),
    c(Some("Travel"), "Airfare", "expense", None),
    c(Some("Travel"), "Lodging", "expense", None),
    c(Some("Travel"), "Rental Car", "expense", None),
    c(None, "Miscellaneous", "expense", None),
];

/// Insert every standard category that is not already present.
///
/// Matching is by (parent, name), so a user who renamed `Groceries` to
/// `Food` gets `Groceries` back — that is additive, not destructive, and it
/// is what "add the standard set" means. Returns how many rows were created.
pub fn seed(conn: &Connection) -> Result<usize, String> {
    let mut created = 0usize;

    // Two passes so a child never looks for a parent that has not landed yet,
    // regardless of the order of the table above.
    for pass in 0..2 {
        for cat in STANDARD_CATEGORIES {
            let is_child = cat.parent.is_some();
            if (pass == 0) == is_child {
                continue;
            }

            // The child takes the kind of the parent it lands under —
            // the user's parent, not the table's idea of it. A user who made
            // their own "Investment Income" an expense category got income
            // children under it, and a category picker that filters on kind
            // then hid them from the one screen that lists the parent.
            let (parent_id, kind): (Option<String>, String) = match cat.parent {
                None => (None, cat.kind.to_string()),
                Some(parent_name) => {
                    let found: Option<(String, String)> = conn
                        .query_row(
                            "SELECT id, kind FROM categories WHERE name = ?1 AND parent_id IS NULL",
                            params![parent_name],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .optional()
                        .map_err(|e| e.to_string())?;
                    match found {
                        Some((id, kind)) => (Some(id), kind),
                        // The parent was deleted by the user. Skip the child
                        // rather than resurrecting a branch they removed.
                        None => continue,
                    }
                }
            };

            let exists: bool = match &parent_id {
                None => conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM categories
                          WHERE name = ?1 AND parent_id IS NULL)",
                        params![cat.name],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?,
                Some(pid) => conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM categories
                          WHERE name = ?1 AND parent_id = ?2)",
                        params![cat.name, pid],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?,
            };
            if exists {
                continue;
            }

            conn.execute(
                "INSERT INTO categories (id, name, parent_id, kind, tax_line)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    Uuid::new_v4().to_string(),
                    cat.name,
                    parent_id,
                    kind,
                    cat.tax_line
                ],
            )
            .map_err(|e| e.to_string())?;
            created += 1;
        }
    }
    Ok(created)
}

/// True when the file has no categories at all — a brand-new database.
pub fn is_empty(conn: &Connection) -> Result<bool, String> {
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(n == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Connection {
        let mut conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::migrations::migrate(&mut conn).expect("migrate");
        conn
    }

    fn kind_of(conn: &Connection, parent: Option<&str>, name: &str) -> String {
        match parent {
            None => conn.query_row(
                "SELECT kind FROM categories WHERE name = ?1 AND parent_id IS NULL",
                params![name],
                |r| r.get(0),
            ),
            Some(p) => conn.query_row(
                "SELECT c.kind FROM categories c JOIN categories p ON p.id = c.parent_id
                  WHERE c.name = ?1 AND p.name = ?2 AND p.parent_id IS NULL",
                params![name, p],
                |r| r.get(0),
            ),
        }
        .unwrap_or_else(|e| panic!("{parent:?} : {name}: {e}"))
    }

    /// The user's "Investment Income" is an expense category. The
    /// standard children added under it are expense categories too, not the
    /// table's income.
    #[test]
    fn children_take_the_kind_of_the_parent_they_land_under() {
        let conn = fresh();
        conn.execute(
            "INSERT INTO categories (id, name, parent_id, kind) VALUES ('mine', 'Investment Income', NULL, 'expense')",
            [],
        )
        .unwrap();
        assert!(seed(&conn).unwrap() > 0);
        assert_eq!(kind_of(&conn, None, "Investment Income"), "expense", "the user's own parent is untouched");
        assert_eq!(kind_of(&conn, Some("Investment Income"), "Capital Gains"), "expense");
        assert_eq!(kind_of(&conn, Some("Investment Income"), "Realized Gain/Loss"), "expense");
        // A parent the seed created itself still gives the table's kind.
        assert_eq!(kind_of(&conn, Some("Wages & Salary"), "Bonus"), "income");
        // Idempotent, as before.
        assert_eq!(seed(&conn).unwrap(), 0);
        crate::db::test_db::assert_consistent(&conn); // 
    }
}
