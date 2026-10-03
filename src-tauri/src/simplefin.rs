//! SimpleFIN: read-only bank transactions from a SimpleFIN server — in
//! practice SimpleFIN Bridge (bridge.simplefin.org), a service the user
//! subscribes to themselves.
//!
//! The protocol (https://www.simplefin.org/protocol.html):
//! - The user connects their banks on the server and gets a **setup token**:
//!   base64 of a one-time "claim" URL.
//! - The app POSTs to the claim URL once and receives the **access URL**:
//!   `https://user:password@host/path`. That is a read-only credential to the
//!   user's bank data. It is kept in Windows Credential Manager, never in the
//!   file, never shown and never logged.
//! - `GET {access}/accounts` answers with accounts, balances and transactions.
//!   SimpleFIN Bridge asks apps for 24 requests a day or fewer and a date
//!   range of at most 90 days per request.
//!
//! Everything that reads or checks data is pure and tested without a
//! network; `claim` and `fetch_accounts` are the only functions that touch it.

use base64::Engine;
use percent_encoding::percent_decode_str;
use serde_json::Value;
use url::Url;

/// The widest date range SimpleFIN Bridge accepts in one request.
pub const MAX_WINDOW_DAYS: i64 = 90;
/// The most one request asks for. The guide allows 90, but SimpleFIN
/// Bridge now answers anything over 45 with "Requested date range exceeds
/// recommended range of 45 days. In the future, this may be capped." So a
/// longer reach is split into requests of at most this many days.
pub const MAX_REQUEST_DAYS: i64 = 45;
/// Each fetch reaches back this far before the last one, so a transaction the
/// bank posted late is not missed (the developer guide's advice).
pub const OVERLAP_DAYS: i64 = 5;
/// SimpleFIN Bridge asks for 24 or fewer a day; T-Money keeps a margin.
pub const DAILY_REQUESTS: u32 = 20;
/// The most of any one piece of server text shown or kept.
const MAX_TEXT: usize = 300;

/// Text from the server, made safe to show: control characters (a bell, an
/// escape sequence, a right-to-left override) become spaces, runs of space
/// fold to one, and it is cut to a sane length. React escapes markup
/// anyway; this is SimpleFIN's own ask, that what comes from a server is
/// cleaned before a person reads it.
pub fn clean_text(s: &str) -> String {
    let mut out = String::new();
    let mut space = false;
    for ch in s.chars() {
        // Direction overrides and the invisible format characters.
        let invisible = matches!(
            ch,
            '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{206F}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}'
        );
        if ch.is_control() || ch.is_whitespace() || invisible {
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        if out.chars().count() >= MAX_TEXT {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

/// The claim URL inside a setup token. Only https is accepted: the reply
/// to it is a credential.
pub fn decode_setup_token(token: &str) -> Result<Url, String> {
    let t: String = token.chars().filter(|c| !c.is_whitespace()).collect();
    if t.is_empty() {
        return Err("Paste the setup token from SimpleFIN first.".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&t)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(&t))
        .map_err(|_| "That is not a SimpleFIN setup token. Copy the whole token from SimpleFIN and paste it again.".to_string())?;
    let s = String::from_utf8(bytes).map_err(|_| "That is not a SimpleFIN setup token.".to_string())?;
    let url = Url::parse(s.trim()).map_err(|_| "That is not a SimpleFIN setup token.".to_string())?;
    if url.scheme() != "https" {
        return Err("That setup token does not point to a secure (https) address, so it was not used.".to_string());
    }
    Ok(url)
}

/// An access URL, taken apart: the address to call and the credentials to
/// send with it.
#[derive(Clone, PartialEq, Eq)]
pub struct Access {
    /// The access URL without its credentials.
    pub base: Url,
    pub user: String,
    pub password: String,
}

impl std::fmt::Debug for Access {
    // Never print the credentials, not even in a test failure.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Access({})", self.base)
    }
}

impl Access {
    /// The server's name, for showing which service the file is connected to.
    pub fn host(&self) -> String {
        self.base.host_str().unwrap_or("").to_string()
    }
}

/// Read an access URL. It must be https and carry a user name and password.
pub fn parse_access(access_url: &str) -> Result<Access, String> {
    let mut url = Url::parse(access_url.trim()).map_err(|_| "The SimpleFIN access address could not be read.".to_string())?;
    if url.scheme() != "https" {
        return Err("The SimpleFIN access address is not secure (https), so it was not used.".to_string());
    }
    let user = percent_decode_str(url.username()).decode_utf8_lossy().to_string();
    let password = url.password().map(|p| percent_decode_str(p).decode_utf8_lossy().to_string()).unwrap_or_default();
    if user.is_empty() || password.is_empty() {
        return Err("The SimpleFIN access address has no credentials in it.".to_string());
    }
    url.set_username("").map_err(|_| "The SimpleFIN access address could not be read.".to_string())?;
    url.set_password(None).map_err(|_| "The SimpleFIN access address could not be read.".to_string())?;
    if !url.path().ends_with('/') {
        let p = format!("{}/", url.path());
        url.set_path(&p);
    }
    Ok(Access { base: url, user, password })
}

/// No redirects: a reply that sends T-Money elsewhere is refused rather than
/// followed, so the credentials go to the server the user connected to and
/// nowhere else.
fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().redirects(0).https_only(true).build()
}

/// Why SimpleFIN could not be reached, without the address: ureq's own
/// message names the URL, and the claim URL is the user's token.
fn unreachable(t: &ureq::Transport) -> String {
    format!("SimpleFIN could not be reached ({}).", t.kind())
}

/// POST to the claim URL once and return the access URL. The claim works a
/// single time; a second attempt is refused by the server.
pub fn claim(claim_url: &Url) -> Result<String, String> {
    let resp = agent()
        .post(claim_url.as_str())
        .set("User-Agent", "T-Money (personal finance)")
        .set("Content-Length", "0")
        .timeout(std::time::Duration::from_secs(30))
        .call();
    match resp {
        Ok(r) => {
            let body = r.into_string().map_err(|_| "SimpleFIN's reply could not be read.".to_string())?;
            let access = body.trim().to_string();
            // Checked before it is kept: anything else is not a credential.
            parse_access(&access)?;
            Ok(access)
        }
        Err(ureq::Error::Status(403, _)) => Err(
            "SimpleFIN refused the setup token. A token works only once. If you did not use it yourself, someone else may have: on the SimpleFIN site, disable that token and make a new one.".to_string(),
        ),
        Err(ureq::Error::Status(code, _)) => Err(format!("SimpleFIN answered HTTP {code} to the setup token.")),
        Err(ureq::Error::Transport(t)) => Err(unreachable(&t)),
    }
}

/// `GET /accounts` between two Unix times; `balances_only` leaves the
/// transactions out (for listing accounts to link). Pending transactions are
/// never asked for: they change and disappear, and a register is for what
/// the bank has posted.
pub fn fetch_accounts(access: &Access, start: i64, end: i64, balances_only: bool) -> Result<String, String> {
    let mut url = access.base.join("accounts").map_err(|_| "The SimpleFIN access address could not be read.".to_string())?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("version", "2");
        if balances_only {
            q.append_pair("balances-only", "1");
        } else {
            q.append_pair("start-date", &start.to_string());
            q.append_pair("end-date", &end.to_string());
        }
    }
    let auth = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", access.user, access.password));
    let resp = agent()
        .get(url.as_str())
        .set("User-Agent", "T-Money (personal finance)")
        .set("Authorization", &format!("Basic {auth}"))
        .set("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(60))
        .call();
    match resp {
        Ok(r) => r.into_string().map_err(|_| "SimpleFIN's reply could not be read.".to_string()),
        Err(ureq::Error::Status(403, _)) => Err(
            "SimpleFIN refused this file's access. It may have been turned off on the SimpleFIN site; connect again with a new setup token.".to_string(),
        ),
        Err(ureq::Error::Status(402, _)) => Err("SimpleFIN says your subscription has not been paid. Renew it on the SimpleFIN site.".to_string()),
        Err(ureq::Error::Status(code, _)) => Err(format!("SimpleFIN answered HTTP {code}.")),
        Err(ureq::Error::Transport(t)) => Err(unreachable(&t)),
    }
}

/// One account as SimpleFIN reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct SfAccount {
    pub id: String,
    pub name: String,
    /// The bank, when the server says.
    pub org: Option<String>,
    /// ISO code; None when the server gave a custom currency, which T-Money
    /// cannot account for.
    pub currency: Option<String>,
    pub balance_cents: Option<i64>,
    /// YYYY-MM-DD, UTC.
    pub balance_date: Option<String>,
    pub transactions: Vec<SfTxn>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SfTxn {
    pub id: String,
    /// YYYY-MM-DD, UTC: the day the bank posted it.
    pub date: String,
    pub amount_cents: i64,
    pub payee: String,
    pub memo: Option<String>,
}

/// What a fetch returned: the accounts, and the server's own messages,
/// which the user has to see (a bank needing to be signed in to again).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AccountSet {
    pub accounts: Vec<SfAccount>,
    pub messages: Vec<String>,
}

/// A Unix time as a UTC date. Banks post at midnight UTC or near it, and
/// the local date would put a US user's every transaction a day early.
pub fn utc_date(unix: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(unix, 0).map(|d| d.date_naive().format("%Y-%m-%d").to_string())
}

fn str_or_num(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Read `GET /accounts`. Both protocol versions are accepted: version 1's
/// `errors` (strings) and `org`, and version 2's `errlist` (objects) and
/// `connections`. A transaction whose amount or date cannot be read is left
/// out and said so, never guessed at.
pub fn parse_account_set(body: &str) -> Result<AccountSet, String> {
    let v: Value = serde_json::from_str(body).map_err(|_| "SimpleFIN's reply was not readable.".to_string())?;
    let mut out = AccountSet::default();
    if let Some(errs) = v["errors"].as_array() {
        out.messages.extend(errs.iter().filter_map(|e| e.as_str().map(clean_text)));
    }
    if let Some(errs) = v["errlist"].as_array() {
        for e in errs {
            let msg = e["msg"].as_str().or_else(|| e["message"].as_str()).or_else(|| e.as_str());
            if let Some(m) = msg {
                out.messages.push(clean_text(m));
            }
        }
    }
    let mut connections: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Some(cs) = v["connections"].as_array() {
        for c in cs {
            if let (Some(id), Some(name)) = (str_or_num(&c["conn_id"]), c["name"].as_str().or_else(|| c["org_name"].as_str())) {
                connections.insert(id, clean_text(name));
            }
        }
    }
    let Some(accounts) = v["accounts"].as_array() else {
        return Err(if out.messages.is_empty() {
            "SimpleFIN's reply had no account list.".to_string()
        } else {
            format!("SimpleFIN says: {}", out.messages.join(" "))
        });
    };
    for a in accounts {
        let Some(id) = str_or_num(&a["id"]).filter(|s| !s.is_empty()) else { continue };
        let name = Some(clean_text(a["name"].as_str().unwrap_or(""))).filter(|n| !n.is_empty()).unwrap_or_else(|| "Account".to_string());
        let org = a["org"]["name"]
            .as_str()
            .map(clean_text)
            .or_else(|| str_or_num(&a["conn_id"]).and_then(|c| connections.get(&c).cloned()));
        let currency = a["currency"]
            .as_str()
            .map(|c| c.trim().to_ascii_uppercase())
            .filter(|c| c.len() == 3 && c.chars().all(|ch| ch.is_ascii_uppercase()));
        let balance_cents = str_or_num(&a["balance"]).and_then(|b| crate::import::parse_amount_cents(&b));
        let balance_date = int(&a["balance-date"]).and_then(utc_date);
        let mut transactions = Vec::new();
        for t in a["transactions"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            if t["pending"].as_bool() == Some(true) {
                continue;
            }
            let tid = str_or_num(&t["id"]).filter(|s| !s.is_empty());
            let date = int(&t["posted"]).filter(|p| *p > 0).and_then(utc_date);
            let amount = str_or_num(&t["amount"]).and_then(|s| crate::import::parse_amount_cents(&s));
            match (tid, date, amount) {
                (Some(tid), Some(date), Some(amount_cents)) => {
                    let desc = clean_text(t["description"].as_str().unwrap_or(""));
                    let payee = t["payee"].as_str().map(clean_text).filter(|p| !p.is_empty()).unwrap_or_else(|| desc.clone());
                    let memo = t["memo"].as_str().map(clean_text).filter(|m| !m.is_empty()).or_else(|| {
                        // The description, when the payee came from elsewhere and it says more.
                        (!desc.is_empty() && desc != payee).then(|| desc.clone())
                    });
                    transactions.push(SfTxn { id: tid, date, amount_cents, payee, memo });
                }
                _ => out.messages.push(format!("A transaction in {name} could not be read and was left out.")),
            }
        }
        out.accounts.push(SfAccount { id, name, org, currency, balance_cents, balance_date, transactions });
    }
    Ok(out)
}

/// Write a fetch into the file: record the accounts SimpleFIN reported, and
/// for each one linked to a T-Money account import its transactions through
/// the ordinary import path (payee rules, the duplicate test). A linked
/// account whose currency no longer matches is skipped and said so; one that
/// imported has its `synced_through` moved to `today`. `progress` hears
/// (accounts done, linked accounts, the one starting) before each account.
pub fn apply_fetch(
    pool: &crate::db::pool::DbPool,
    set: &AccountSet,
    today: &str,
    from: &str,
    progress: &mut dyn FnMut(usize, usize, &str),
) -> Result<crate::models::SimplefinSync, String> {
    use crate::db::queries;
    use crate::models::{SimplefinSync, SimplefinSyncLine};
    let links = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        queries::upsert_simplefin_accounts(&conn, set)?;
        queries::list_simplefin_accounts(&conn)?
    };
    let mut out = SimplefinSync { lines: Vec::new(), messages: set.messages.clone(), unlinked: 0, from: from.to_string(), to: today.to_string() };
    let total = links.iter().filter(|l| l.account_id.is_some()).count();
    for link in &links {
        let Some(account_id) = link.account_id.clone() else {
            if set.accounts.iter().any(|a| a.id == link.sf_id) {
                out.unlinked += 1;
            }
            continue;
        };
        let account_name = link.account_name.clone().unwrap_or_default();
        progress(out.lines.len(), total, &account_name);
        let mut line = SimplefinSyncLine {
            sf_name: link.name.clone(),
            account_id: account_id.clone(),
            account_name: account_name.clone(),
            imported: 0,
            matched: 0,
            duplicates: 0,
            bank_balance_cents: None,
            balance_cents: 0,
            error: None,
            note: None,
        };
        match set.accounts.iter().find(|a| a.id == link.sf_id) {
            None => line.error = Some("SimpleFIN did not report this account this time.".to_string()),
            Some(a) => {
                line.bank_balance_cents = a.balance_cents;
                let currency: String = match pool
                    .get()
                    .map_err(|e| e.to_string())
                    .and_then(|conn| conn.query_row("SELECT currency FROM accounts WHERE id = ?1", [&account_id], |r| r.get(0)).map_err(|e| e.to_string()))
                {
                    Ok(c) => c,
                    Err(e) => {
                        line.error = Some(e);
                        out.lines.push(line);
                        continue;
                    }
                };
                if a.currency.as_deref() != Some(currency.as_str()) {
                    line.error = Some(format!(
                        "{} is in {} and {account_name} is kept in {currency}, so nothing was imported.",
                        a.name,
                        a.currency.as_deref().unwrap_or("a currency T-Money cannot account for")
                    ));
                } else {
                    let rows = a
                        .transactions
                        .iter()
                        .map(|t| crate::import::BankRow { id: t.id.clone(), date: t.date.clone(), amount_cents: t.amount_cents, payee: t.payee.clone(), memo: t.memo.clone() })
                        .collect();
                    match crate::import::import_bank_rows(pool, &account_id, rows) {
                        Ok(s) => {
                            // Last fetched before this window began: the
                            // days between were never asked for.
                            if let Some(last) = link.synced_through.as_deref().filter(|d| *d < from) {
                                line.note = Some(format!(
                                    "The last fetch was {}, and SimpleFIN reaches back only 90 days, so nothing from before {} was fetched this time. Import a statement for those days.",
                                    show_date(last),
                                    show_date(from),
                                ));
                            }
                            line.imported = s.imported;
                            line.matched = s.matched;
                            line.duplicates = s.duplicates;
                            if let Err(e) = pool.get().map_err(|e| e.to_string()).and_then(|conn| queries::set_simplefin_synced(&conn, &link.sf_id, today)) {
                                line.error = Some(e);
                            }
                        }
                        Err(e) => line.error = Some(e),
                    }
                }
            }
        }
        line.balance_cents = pool
            .get()
            .ok()
            .and_then(|conn| conn.query_row("SELECT balance_cents FROM accounts WHERE id = ?1", [&account_id], |r| r.get(0)).ok())
            .unwrap_or(0);
        out.lines.push(line);
    }
    Ok(out)
}

/// `window` cut into requests of at most `MAX_REQUEST_DAYS`, oldest first.
/// An ordinary fetch is one; only the first, 88 days back, is two.
pub fn request_windows(today: chrono::NaiveDate, synced_through: Option<chrono::NaiveDate>) -> Vec<(i64, i64)> {
    let (start, end) = window(today, synced_through);
    let step = MAX_REQUEST_DAYS * 86_400;
    let mut out = Vec::new();
    let mut s = start;
    while s < end {
        let e = (s + step).min(end);
        out.push((s, e));
        s = e;
    }
    out
}

/// Fold a later request's reply into an earlier one: each account once,
/// with every transaction once, and the newest name and balance.
pub fn merge_sets(into: &mut AccountSet, more: AccountSet) {
    for a in more.accounts {
        match into.accounts.iter_mut().find(|x| x.id == a.id) {
            Some(x) => {
                for t in a.transactions {
                    if !x.transactions.iter().any(|y| y.id == t.id) {
                        x.transactions.push(t);
                    }
                }
                x.name = a.name;
                x.org = a.org;
                x.currency = a.currency;
                x.balance_cents = a.balance_cents;
                x.balance_date = a.balance_date;
            }
            None => into.accounts.push(a),
        }
    }
    for m in more.messages {
        if !into.messages.contains(&m) {
            into.messages.push(m);
        }
    }
}

/// A YYYY-MM-DD date the way the open file writes dates.
fn show_date(iso: &str) -> String {
    chrono::NaiveDate::parse_from_str(iso, "%Y-%m-%d").map(crate::region::date).unwrap_or_else(|_| iso.to_string())
}

/// The date window for a fetch, as Unix times: from `OVERLAP_DAYS` before
/// the earliest day already fetched (or as far back as allowed, for an
/// account never fetched) to the start of tomorrow, so today's postings in
/// any time zone are in. A day short of `MAX_WINDOW_DAYS` in all, so a
/// server counting the ends inclusively still accepts it.
pub fn window(today: chrono::NaiveDate, synced_through: Option<chrono::NaiveDate>) -> (i64, i64) {
    let earliest = today - chrono::Duration::days(MAX_WINDOW_DAYS - 2);
    let from = match synced_through {
        Some(d) => (d - chrono::Duration::days(OVERLAP_DAYS)).max(earliest),
        None => earliest,
    };
    let start = from.and_hms_opt(0, 0, 0).expect("midnight").and_utc().timestamp();
    let end = (today + chrono::Duration::days(1)).and_hms_opt(0, 0, 0).expect("midnight").and_utc().timestamp();
    (start, end)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(url: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(url)
    }

    #[test]
    fn a_setup_token_is_a_secure_claim_url() {
        assert_eq!(decode_setup_token(&token("https://bridge.simplefin.org/simplefin/claim/abc")).unwrap().as_str(), "https://bridge.simplefin.org/simplefin/claim/abc");
        // Pasted with a line break in the middle still works.
        let t = token("https://bridge.simplefin.org/simplefin/claim/abc");
        assert!(decode_setup_token(&format!("{}\n{}", &t[..10], &t[10..])).is_ok());
        assert!(decode_setup_token(&token("http://bridge.simplefin.org/claim/abc")).unwrap_err().contains("https"));
        assert!(decode_setup_token("not a token!").is_err());
        assert!(decode_setup_token("").is_err());
        assert!(decode_setup_token(&token("file:///c:/windows")).is_err());
    }

    #[test]
    fn an_access_url_is_split_into_address_and_credentials() {
        let a = parse_access("https://user%40x:p%3Ass@bridge.simplefin.org/simplefin").unwrap();
        assert_eq!(a.base.as_str(), "https://bridge.simplefin.org/simplefin/");
        assert_eq!((a.user.as_str(), a.password.as_str()), ("user@x", "p:ss"));
        assert_eq!(a.host(), "bridge.simplefin.org");
        assert_eq!(a.base.join("accounts").unwrap().as_str(), "https://bridge.simplefin.org/simplefin/accounts");
        assert!(!format!("{a:?}").contains("p:ss"), "the password never prints");
        assert!(parse_access("http://u:p@bridge.simplefin.org/simplefin").is_err());
        assert!(parse_access("https://bridge.simplefin.org/simplefin").is_err());
        assert!(parse_access("garbage").is_err());
    }

    const V2: &str = r#"{
      "errlist": [{"code": "con.auth", "msg": "Example Bank needs you to sign in again."}],
      "connections": [{"conn_id": "c1", "name": "Example Bank"}],
      "accounts": [
        {"id": "A1", "name": "Everyday Checking", "conn_id": "c1", "currency": "USD",
         "balance": "1234.56", "balance-date": 1790812800,
         "transactions": [
           {"id": "T1", "posted": 1790726400, "amount": "-42.50", "description": "KROGER #123", "payee": "Kroger"},
           {"id": "T2", "posted": 1790812800, "amount": "1500.00", "description": "PAYROLL"},
           {"id": "T3", "posted": 1790812800, "amount": "-9.99", "description": "PENDING", "pending": true},
           {"id": "T4", "posted": 1790812800, "amount": "abc", "description": "BROKEN"}
         ]},
        {"id": "A2", "name": "Points", "currency": "https://example.com/points", "balance": "10"}
      ]
    }"#;

    #[test]
    fn a_reply_is_read_exactly_and_what_cannot_be_read_is_named() {
        let s = parse_account_set(V2).unwrap();
        assert_eq!(s.accounts.len(), 2);
        let a = &s.accounts[0];
        assert_eq!((a.id.as_str(), a.org.as_deref(), a.currency.as_deref()), ("A1", Some("Example Bank"), Some("USD")));
        assert_eq!((a.balance_cents, a.balance_date.as_deref()), (Some(123_456), Some("2026-10-01")));
        assert_eq!(a.transactions.len(), 2, "the pending row and the broken one are out");
        assert_eq!(a.transactions[0], SfTxn { id: "T1".into(), date: "2026-09-30".into(), amount_cents: -4_250, payee: "Kroger".into(), memo: Some("KROGER #123".into()) });
        assert_eq!((a.transactions[1].payee.as_str(), a.transactions[1].memo.as_deref()), ("PAYROLL", None));
        assert_eq!(s.accounts[1].currency, None, "a custom currency is not taken for a real one");
        assert!(s.messages.iter().any(|m| m.contains("sign in again")));
        assert!(s.messages.iter().any(|m| m.contains("could not be read")));
    }

    #[test]
    fn version_one_replies_are_read_too() {
        let v1 = r#"{"errors": ["You must reauthenticate."], "accounts": [{"org": {"name": "Old Bank"}, "id": "X", "name": "Savings", "currency": "usd", "balance": "5.00", "balance-date": "1790812800", "transactions": [{"id": 7, "posted": 1790726400, "amount": "2.5"}]}]}"#;
        let s = parse_account_set(v1).unwrap();
        assert_eq!(s.messages, vec!["You must reauthenticate.".to_string()]);
        let a = &s.accounts[0];
        assert_eq!((a.org.as_deref(), a.currency.as_deref()), (Some("Old Bank"), Some("USD")));
        assert_eq!(a.transactions[0].amount_cents, 250);
        assert_eq!(a.transactions[0].id, "7");
        assert!(parse_account_set("<html>").is_err());
        assert!(parse_account_set("{}").is_err());
    }

    #[test]
    fn server_text_is_cleaned_before_anyone_reads_it() {
        assert_eq!(clean_text("  KROGER\t#123\r\n ANYTOWN  "), "KROGER #123 ANYTOWN");
        assert_eq!(clean_text("bell\u{7}esc\u{1b}[31mred"), "bell esc [31mred");
        assert_eq!(clean_text("pay\u{202E}lam.exe"), "pay lam.exe");
        assert_eq!(clean_text("in\u{200B}vis\u{FEFF}ible\u{061C}"), "in vis ible");
        let long = "x".repeat(1000);
        assert_eq!(clean_text(&long).chars().count(), MAX_TEXT + 1);
        let s = parse_account_set(r#"{"errlist":[{"msg":"Sign in\u0007 again"}],"accounts":[{"id":"A","name":" \u001b ","currency":"USD","transactions":[{"id":"T","posted":1790726400,"amount":"-1","description":"A\nB"}]}]}"#).unwrap();
        assert_eq!(s.messages, vec!["Sign in again".to_string()]);
        assert_eq!(s.accounts[0].name, "Account");
        assert_eq!(s.accounts[0].transactions[0].payee, "A B");
    }

    #[test]
    fn no_request_asks_for_more_than_45_days() {
        let d = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        let day = |t: i64| utc_date(t).unwrap();
        // The first fetch: 88 days back, in two.
        let w = request_windows(d("2026-10-03"), None);
        assert_eq!(w.len(), 2);
        assert!(w.iter().all(|(s, e)| e - s <= MAX_REQUEST_DAYS * 86_400));
        assert_eq!((day(w[0].0), day(w[1].1)), ("2026-07-07".to_string(), "2026-10-04".to_string()));
        assert_eq!(w[0].1, w[1].0, "end to end, no gap and no overlap");
        // An ordinary one: a single request.
        assert_eq!(request_windows(d("2026-10-03"), Some(d("2026-10-01"))).len(), 1);
    }

    #[test]
    fn two_replies_fold_into_one() {
        let t = |id: &str| SfTxn { id: id.into(), date: "2026-09-01".into(), amount_cents: -1, payee: "X".into(), memo: None };
        let acct = |name: &str, bal: i64, txns: Vec<SfTxn>| SfAccount {
            id: "A".into(), name: name.into(), org: None, currency: Some("USD".into()), balance_cents: Some(bal), balance_date: None, transactions: txns,
        };
        let mut a = AccountSet { accounts: vec![acct("Old name", 1, vec![t("1"), t("2")])], messages: vec!["m".into()] };
        let b = AccountSet { accounts: vec![acct("New name", 2, vec![t("2"), t("3")])], messages: vec!["m".into(), "n".into()] };
        merge_sets(&mut a, b);
        assert_eq!(a.accounts.len(), 1);
        let ids: Vec<&str> = a.accounts[0].transactions.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["1", "2", "3"]);
        assert_eq!((a.accounts[0].name.as_str(), a.accounts[0].balance_cents), ("New name", Some(2)));
        assert_eq!(a.messages, vec!["m".to_string(), "n".to_string()]);
    }

    #[test]
    fn the_window_is_at_most_ninety_days_and_overlaps_the_last_fetch() {
        let d = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        let day = |t: i64| utc_date(t).unwrap();
        let (s, e) = window(d("2026-10-03"), None);
        assert_eq!((day(s), day(e)), ("2026-07-07".to_string(), "2026-10-04".to_string()));
        assert!(e - s < MAX_WINDOW_DAYS * 86_400);
        let (s, _) = window(d("2026-10-03"), Some(d("2026-10-01")));
        assert_eq!(day(s), "2026-09-26");
        // Long untouched: back to the limit, not further.
        let (s, _) = window(d("2026-10-03"), Some(d("2026-01-01")));
        assert_eq!(day(s), "2026-07-07");
    }
}
