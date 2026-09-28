//! App settings (migration 0020) and saved reports (§39), which are kept in
//! one.

use rusqlite::{params, OptionalExtension};
use uuid::Uuid;
use super::*;

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Saved reports (§39)
// ---------------------------------------------------------------------------

const SAVED_REPORTS_KEY: &str = "reports.saved";

pub fn list_saved_reports(conn: &Conn) -> Result<Vec<crate::models::SavedReport>, String> {
    match get_setting(conn, SAVED_REPORTS_KEY)? {
        None => Ok(Vec::new()),
        Some(json) => serde_json::from_str(&json).map_err(|e| format!("saved reports are unreadable: {e}")),
    }
}

fn write_saved_reports(conn: &Conn, list: &[crate::models::SavedReport]) -> Result<(), String> {
    let json = serde_json::to_string(list).map_err(|e| e.to_string())?;
    set_setting(conn, SAVED_REPORTS_KEY, &json)
}

/// Save (or, with an existing id, replace) a named report. Names are unique,
/// case-insensitively, so two "By Category" entries cannot exist.
pub fn save_report(conn: &Conn, mut report: crate::models::SavedReport) -> Result<crate::models::SavedReport, String> {
    report.name = report.name.trim().to_string();
    if report.name.is_empty() {
        return Err("give the report a name".to_string());
    }
    let mut list = list_saved_reports(conn)?;
    if report.id.is_empty() {
        report.id = Uuid::new_v4().to_string();
    }
    if list.iter().any(|r| r.id != report.id && r.name.eq_ignore_ascii_case(&report.name)) {
        return Err(format!("a saved report named '{}' already exists", report.name));
    }
    match list.iter_mut().find(|r| r.id == report.id) {
        Some(slot) => *slot = report.clone(),
        None => list.push(report.clone()),
    }
    write_saved_reports(conn, &list)?;
    Ok(report)
}

pub fn delete_saved_report(conn: &Conn, id: &str) -> Result<(), String> {
    let mut list = list_saved_reports(conn)?;
    list.retain(|r| r.id != id);
    write_saved_reports(conn, &list)
}

// ---------------------------------------------------------------------------
// App settings (migration 0020)
// ---------------------------------------------------------------------------

pub fn get_setting(conn: &Conn, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn set_setting(conn: &Conn, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                         updated_at = datetime('now')",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries::test_support::*;

    #[test]
    fn a_setting_round_trips_and_overwrites() {
        let db = TestDb::new("settings");
        let c = db.conn();
        assert_eq!(get_setting(&c, "backup.folder").expect("get"), None);

        set_setting(&c, "backup.folder", "D:\\TMoneyBackups").expect("set");
        assert_eq!(
            get_setting(&c, "backup.folder").expect("get").as_deref(),
            Some("D:\\TMoneyBackups")
        );

        set_setting(&c, "backup.folder", "D:\\Elsewhere").expect("set again");
        assert_eq!(
            get_setting(&c, "backup.folder").expect("get").as_deref(),
            Some("D:\\Elsewhere"),
            "a second write should replace, not duplicate"
        );
    }

    #[test]
    fn saved_reports_round_trip_and_refuse_duplicate_names() {
        let db = TestDb::new("saved-reports");
        let c = db.conn();
        let mk = |name: &str, id: &str| crate::models::SavedReport {
            id: id.to_string(), name: name.to_string(), kind: "spending_by_category".to_string(),
            range_id: "previous_year".to_string(), from: "2025-01-01".to_string(), to: "2025-12-31".to_string(),
            account_ids: vec!["a-1".into()], category_ids: vec![], compare_from: None, compare_to: None, detail: None, options: None,
            ..Default::default()
        };
        let saved = save_report(&c, mk("By Category - Sam", "")).expect("save");
        assert!(!saved.id.is_empty());
        assert!(save_report(&c, mk("by category - sam", "")).is_err(), "names are unique, case-insensitively");
        let mut renamed = saved.clone();
        renamed.name = "By Category — Sam".to_string();
        renamed.account_ids = vec!["a-1".into(), "a-2".into()];
        save_report(&c, renamed).expect("replace by id");
        let list = list_saved_reports(&c).expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].account_ids.len(), 2);
        // §113: a report saved before the scope grew still loads — every new
        // field defaults rather than failing the whole list.
        set_setting(
            &c,
            SAVED_REPORTS_KEY,
            r#"[{"id":"old","name":"Old one","kind":"spending_by_category","range_id":"custom","from":"2025-01-01","to":"2025-12-31","account_ids":[],"category_ids":[]}]"#,
        )
        .unwrap();
        let old = list_saved_reports(&c).expect("old shape still reads");
        assert_eq!(old.len(), 1);
        assert!(old[0].payee_ids.is_empty() && !old[0].exclude_categories && old[0].class_value_ids.is_empty());
        write_saved_reports(&c, &[saved.clone()]).unwrap();
        delete_saved_report(&c, &saved.id).expect("delete");
        assert!(list_saved_reports(&c).expect("list").is_empty());
    }
}
