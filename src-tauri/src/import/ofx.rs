//! OFX (Open Financial Exchange) parser.
//!
//! OFX is a tag-based format (XML-like). We extract each `<STMTTRN>...</STMTTRN>`
//! block and pull out the fields we need: `TRNAMT`, `DTPOSTED`, `NAME`,
//! `PAYEEID`, `MEMO`, `FITID`, `CHECKNUM`, and `CATEGORYSUBFIELD`/`CATDESC`.
//!
//! **Two dialects.** OFX 2.x is XML and closes every element. OFX 1.x is SGML
//! — and it is what virtually every bank download and every `.qfx` actually
//! is — and it closes *aggregates* (`</STMTTRN>`) but **not leaf elements**:
//!
//! ```text
//! <STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260803<TRNAMT>-58.42<FITID>2026080301<NAME>KROGER</STMTTRN>
//! ```
//!
//! Until this was fixed, `tag_value` required a closing tag, so every leaf in a 1.x file
//! came back `None`, every block was skipped, and a real bank statement
//! imported "successfully" with zero rows — including `samples/sample-statement.ofx`,
//! the file the user was told to try. A leaf value now ends at the next `<`
//! or the end of the block, whichever comes first, which reads both dialects.
//!
//! This is a focused, dependency-free parser — it does not build a full DOM.

use crate::import::amount::{normalize_ofx_date, parse_amount_cents, parse_micro};

/// A parsed OFX transaction (pre-insertion).
#[derive(Debug, Clone)]
pub struct OfxTransaction {
    pub date: String,
    pub amount_cents: i64,
    pub payee: String,
    pub category: Option<String>,
    pub notes: Option<String>,
    /// `FITID` — the bank's own unique id for the transaction. The honest
    /// duplicate key for re-imports.
    pub fitid: Option<String>,
    /// `CHECKNUM`, when the bank sends one.
    pub check_number: Option<String>,
}

/// True if `text` is an OFX document in either dialect: XML (`<?xml` /
/// `<OFX>`) or SGML, which opens with an `OFXHEADER:100` text header well
/// before the first tag.
pub fn looks_like_ofx(text: &str) -> bool {
    let head: String = text.chars().take(4096).collect::<String>().to_ascii_uppercase();
    head.trim_start().starts_with("OFXHEADER") || head.contains("<OFX>")
}

/// Parse OFX text into a list of transactions.
pub fn parse_ofx(text: &str) -> Vec<OfxTransaction> {
    let mut out = Vec::new();
    for block in extract_blocks(text, "STMTTRN") {
        let trnamt = tag_value(&block, "TRNAMT");
        let dtposted = tag_value(&block, "DTPOSTED");
        let name = tag_value(&block, "NAME");
        let payeeid = tag_value(&block, "PAYEEID");
        let memo = tag_value(&block, "MEMO");
        let fitid = tag_value(&block, "FITID");
        let checknum = tag_value(&block, "CHECKNUM");
        let cat = tag_value(&block, "CATDESC")
            .or_else(|| tag_value(&block, "CATEGORYSUBFIELD"));

        let amount_cents = match trnamt.as_deref().and_then(|s| parse_amount_cents(s)) {
            Some(a) => a,
            None => continue,
        };
        let date = match dtposted.as_deref().and_then(|s| normalize_ofx_date(s)) {
            Some(d) => d,
            None => continue,
        };

        let payee = name
            .or(payeeid)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_default();

        out.push(OfxTransaction {
            date,
            amount_cents,
            payee,
            category: cat.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            notes: memo.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            fitid: fitid.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            check_number: checknum.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        });
    }
    out
}

// ---------------------------------------------------------------------------
// Investment statements: INVSTMTMSGSRSV1 + SECLIST
// ---------------------------------------------------------------------------

/// A security as the broker describes it in `<SECLIST>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfxSecurity {
    /// `UNIQUEID` — usually the CUSIP.
    pub unique_id: String,
    pub name: String,
    pub ticker: Option<String>,
    /// stock | mutual_fund | bond | other, from which `*INFO` block it sat in.
    pub kind: String,
}

/// One investment transaction, already mapped onto the app's activities.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfxInvestment {
    pub fitid: Option<String>,
    pub date: String,
    /// buy | sell | dividend | interest | ltcg_dist | stcg_dist |
    /// reinvest_* | add_shares | remove_shares | return_of_capital | split
    pub activity: String,
    pub unique_id: String,
    /// Shares moved (x 1,000,000); a split's new-per-old ratio.
    pub shares_micro: i64,
    pub price_micro: Option<i64>,
    /// Value of the shares before commission; a dividend's amount.
    pub gross_cents: i64,
    pub commission_cents: i64,
    pub memo: Option<String>,
}

/// A position's price as of the statement date (`<INVPOSLIST>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfxPrice {
    pub unique_id: String,
    pub date: String,
    pub price_micro: i64,
}

#[derive(Debug, Default)]
pub struct OfxInvestmentFile {
    pub securities: Vec<OfxSecurity>,
    pub transactions: Vec<OfxInvestment>,
    pub prices: Vec<OfxPrice>,
    /// Blocks the importer will not write, with why. Shown, never hidden.
    pub skipped: Vec<String>,
}

/// True when the file carries an investment statement at all.
pub fn has_investments(text: &str) -> bool {
    text.contains("<INVSTMTRS>") || text.contains("<INVTRANLIST>")
}

/// The activity aggregates OFX defines, and what each becomes.
const BUYS: &[&str] = &["BUYSTOCK", "BUYMF", "BUYOTHER", "BUYDEBT", "BUYOPT"];
const SELLS: &[&str] = &["SELLSTOCK", "SELLMF", "SELLOTHER", "SELLDEBT", "SELLOPT"];
const UNSUPPORTED: &[&str] = &["MARGININTEREST", "JRNLSEC", "JRNLFUND", "CLOSUREOPT", "INVEXPENSE"];

fn income_activity(income_type: Option<&str>, reinvest: bool) -> &'static str {
    let t = income_type.map(|s| s.trim().to_ascii_uppercase()).unwrap_or_default();
    match (t.as_str(), reinvest) {
        ("INTEREST", false) => "interest",
        ("INTEREST", true) => "reinvest_interest",
        ("CGLONG", false) => "ltcg_dist",
        ("CGLONG", true) => "reinvest_ltcg",
        ("CGSHORT", false) => "stcg_dist",
        ("CGSHORT", true) => "reinvest_stcg",
        // DIV, MISC and anything else: a dividend is the honest default.
        (_, false) => "dividend",
        (_, true) => "reinvest_dividend",
    }
}

fn money(block: &str, tag: &str) -> Option<i64> {
    tag_value(block, tag).and_then(|v| parse_amount_cents(&v))
}
fn micro(block: &str, tag: &str) -> Option<i64> {
    tag_value(block, tag).and_then(|v| parse_micro(&v))
}

/// Parse the investment side of an OFX file. The cash side (`INVBANKTRAN`
/// wraps ordinary `STMTTRN` blocks) is read by `parse_ofx` as before.
pub fn parse_ofx_investments(text: &str) -> OfxInvestmentFile {
    let mut out = OfxInvestmentFile::default();

    // Securities, by which *INFO aggregate they sit in.
    for (tag, kind) in [("STOCKINFO", "stock"), ("MFINFO", "mutual_fund"), ("DEBTINFO", "bond"), ("OTHERINFO", "other"), ("OPTINFO", "other")] {
        for block in extract_blocks(text, tag) {
            let Some(unique_id) = tag_value(&block, "UNIQUEID") else { continue };
            let name = tag_value(&block, "SECNAME").unwrap_or_else(|| unique_id.clone());
            out.securities.push(OfxSecurity {
                unique_id,
                name,
                ticker: tag_value(&block, "TICKER").map(|t| t.trim().to_ascii_uppercase()),
                kind: kind.to_string(),
            });
        }
    }

    // Transactions live inside INVTRANLIST; the whole file is searched, since
    // an aggregate name like BUYSTOCK appears nowhere else.
    let common = |block: &str| -> Option<(Option<String>, String, String, Option<String>)> {
        let fitid = tag_value(block, "FITID");
        let date = tag_value(block, "DTTRADE").or_else(|| tag_value(block, "DTSETTLE")).and_then(|d| normalize_ofx_date(&d))?;
        let unique_id = tag_value(block, "UNIQUEID")?;
        let memo = tag_value(block, "MEMO");
        Some((fitid, date, unique_id, memo))
    };
    let mut push = |b: OfxInvestment| out.transactions.push(b);
    let mut skipped: Vec<String> = Vec::new();

    for tag in BUYS.iter().chain(SELLS.iter()) {
        let is_buy = BUYS.contains(tag);
        for block in extract_blocks(text, tag) {
            let Some((fitid, date, unique_id, memo)) = common(&block) else {
                skipped.push(format!("a {tag} without a date or security id"));
                continue;
            };
            let units = micro(&block, "UNITS").unwrap_or(0).abs();
            let price = micro(&block, "UNITPRICE").filter(|p| *p > 0);
            let commission = money(&block, "COMMISSION").unwrap_or(0).abs()
                + money(&block, "FEES").unwrap_or(0).abs()
                + money(&block, "TAXES").unwrap_or(0).abs()
                + money(&block, "LOAD").unwrap_or(0).abs();
            // TOTAL is the cash effect: negative on a buy (includes the
            // commission), positive on a sale (net of it). Gross is the
            // value of the shares themselves.
            let gross = match money(&block, "TOTAL") {
                Some(t) if is_buy => t.abs() - commission,
                Some(t) => t.abs() + commission,
                None => match price {
                    Some(p) => crate::db::lots::value_cents(units, p),
                    None => 0,
                },
            };
            if units == 0 {
                skipped.push(format!("{tag} on {date}: no share count"));
                continue;
            }
            push(OfxInvestment {
                fitid,
                date,
                activity: if is_buy { "buy" } else { "sell" }.to_string(),
                unique_id,
                shares_micro: units,
                price_micro: price,
                gross_cents: gross.max(0),
                commission_cents: commission,
                memo,
            });
        }
    }

    for block in extract_blocks(text, "INCOME") {
        let Some((fitid, date, unique_id, memo)) = common(&block) else { continue };
        let Some(total) = money(&block, "TOTAL") else { continue };
        push(OfxInvestment {
            fitid,
            date,
            activity: income_activity(tag_value(&block, "INCOMETYPE").as_deref(), false).to_string(),
            unique_id,
            shares_micro: 0,
            price_micro: None,
            gross_cents: total.abs(),
            commission_cents: 0,
            memo,
        });
    }

    for block in extract_blocks(text, "REINVEST") {
        let Some((fitid, date, unique_id, memo)) = common(&block) else { continue };
        let units = micro(&block, "UNITS").unwrap_or(0).abs();
        let total = money(&block, "TOTAL").map(|t| t.abs());
        let price = micro(&block, "UNITPRICE").filter(|p| *p > 0);
        let gross = total.or_else(|| price.map(|p| crate::db::lots::value_cents(units, p))).unwrap_or(0);
        if units == 0 {
            skipped.push(format!("REINVEST on {date}: no share count"));
            continue;
        }
        push(OfxInvestment {
            fitid,
            date,
            activity: income_activity(tag_value(&block, "INCOMETYPE").as_deref(), true).to_string(),
            unique_id,
            shares_micro: units,
            price_micro: price,
            gross_cents: gross,
            commission_cents: money(&block, "COMMISSION").unwrap_or(0).abs(),
            memo,
        });
    }

    for block in extract_blocks(text, "TRANSFER") {
        let Some((fitid, date, unique_id, memo)) = common(&block) else { continue };
        let units = micro(&block, "UNITS").unwrap_or(0).abs();
        if units == 0 {
            continue;
        }
        let action = tag_value(&block, "TFERACTION").map(|s| s.to_ascii_uppercase()).unwrap_or_else(|| "IN".to_string());
        let price = micro(&block, "UNITPRICE").filter(|p| *p > 0);
        let basis = price.map(|p| crate::db::lots::value_cents(units, p)).unwrap_or(0);
        push(OfxInvestment {
            fitid,
            date,
            activity: if action == "OUT" { "remove_shares" } else { "add_shares" }.to_string(),
            unique_id,
            shares_micro: units,
            price_micro: price,
            gross_cents: basis,
            commission_cents: 0,
            memo,
        });
    }

    for block in extract_blocks(text, "SPLIT") {
        let Some((fitid, date, unique_id, memo)) = common(&block) else { continue };
        let ratio = match (micro(&block, "NUMERATOR"), micro(&block, "DENOMINATOR")) {
            (Some(n), Some(d)) if d > 0 => crate::db::lots::mul_div(n, 1_000_000, d),
            _ => match (micro(&block, "NEWUNITS"), micro(&block, "OLDUNITS")) {
                (Some(n), Some(o)) if o > 0 => crate::db::lots::mul_div(n, 1_000_000, o),
                _ => 0,
            },
        };
        if ratio <= 0 {
            skipped.push(format!("SPLIT on {date}: no ratio"));
            continue;
        }
        push(OfxInvestment { fitid, date, activity: "split".to_string(), unique_id, shares_micro: ratio, price_micro: None, gross_cents: 0, commission_cents: 0, memo });
    }

    for block in extract_blocks(text, "RETOFCAP") {
        let Some((fitid, date, unique_id, memo)) = common(&block) else { continue };
        let Some(total) = money(&block, "TOTAL") else { continue };
        push(OfxInvestment { fitid, date, activity: "return_of_capital".to_string(), unique_id, shares_micro: 0, price_micro: None, gross_cents: total.abs(), commission_cents: 0, memo });
    }

    for tag in UNSUPPORTED {
        let n = extract_blocks(text, tag).len();
        if n > 0 {
            skipped.push(format!("{n} {tag} row{} — not an activity this app records", if n == 1 { "" } else { "s" }));
        }
    }

    // Positions carry the broker's price as of the statement date.
    for tag in ["POSSTOCK", "POSMF", "POSDEBT", "POSOTHER", "POSOPT"] {
        for block in extract_blocks(text, tag) {
            let (Some(unique_id), Some(price)) = (tag_value(&block, "UNIQUEID"), micro(&block, "UNITPRICE")) else { continue };
            let Some(date) = tag_value(&block, "DTPRICEASOF").and_then(|d| normalize_ofx_date(&d)) else { continue };
            if price > 0 {
                out.prices.push(OfxPrice { unique_id, date, price_micro: price });
            }
        }
    }

    out.transactions.sort_by(|a, b| a.date.cmp(&b.date));
    out.skipped = skipped;
    out
}

/// Return the inner text of every `<TAG>...</TAG>` block in `text`.
fn extract_blocks(text: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut blocks = Vec::new();
    let mut search_from = 0usize;
    while let Some(rel_start) = text[search_from..].find(&open) {
        let start = search_from + rel_start + open.len();
        if let Some(rel_end) = text[start..].find(&close) {
            let end = start + rel_end;
            blocks.push(text[start..end].to_string());
            search_from = end + close.len();
        } else {
            break;
        }
    }
    blocks
}

/// Every currency the file's statements name in `<CURDEF>`, upper-cased, in
/// order of appearance, once each. Empty when the file does not say. Every
/// one counts: a file can hold several statements, and the rows of all of
/// them are read.
pub fn statement_currencies(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("<CURDEF>") {
        rest = &rest[at..];
        if let Some(v) = tag_value(rest, "CURDEF").map(|v| v.trim().to_ascii_uppercase()) {
            if !out.contains(&v) {
                out.push(v);
            }
        }
        rest = &rest["<CURDEF>".len()..];
    }
    out
}

/// Return the value of the first `<TAG>value` in `block`, whether or not a
/// `</TAG>` follows it. The value runs to the next `<` — which in SGML is the
/// next element, and in XML is this element's closing tag — or to the end of
/// the block.
fn tag_value(block: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let start = block.find(&open)? + open.len();
    let rest = &block[start..];
    let end = rest.find('<').unwrap_or(rest.len());
    let v = unescape(rest[..end].trim());
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// The handful of entity escapes OFX allows in element text.
fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic() {
        let ofx = r#"
<OFX>
<BANKMSGSRSV1>
<STMTTRN>
<TRNUID>1</TRNUID>
<STMTTRNID>1</STMTTRNID>
<TRNAMT>-123.45</TRNAMT>
<DTPOSTED>20240115103000</DTPOSTED>
<NAME>Coffee Shop</NAME>
<CATDESC>Food:Drinks</CATDESC>
</STMTTRN>
<STMTTRN>
<TRNUID>2</TRNUID>
<TRNAMT>500.00</TRNAMT>
<DTPOSTED>20240116</DTPOSTED>
<NAME>Paycheck</NAME>
</STMTTRN>
</BANKMSGSRSV1>
</OFX>
"#;
        let txs = parse_ofx(ofx);
        assert_eq!(txs.len(), 2);
        assert_eq!(txs[0].date, "2024-01-15");
        assert_eq!(txs[0].amount_cents, -12345);
        assert_eq!(txs[0].payee, "Coffee Shop");
        assert_eq!(txs[0].category.as_deref(), Some("Food:Drinks"));
        assert_eq!(txs[1].amount_cents, 50000);
    }

    /// OFX 1.x / SGML: leaf elements have NO closing tag. This is the shape
    /// of essentially every bank download and every `.qfx`, and it is the
    /// shape of `samples/sample-statement.ofx`. It parsed to zero rows before.
    #[test]
    fn parses_sgml_ofx_where_leaf_tags_are_not_closed() {
        let ofx = "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n\
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>\n\
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260803120000<TRNAMT>-58.42<FITID>2026080301<NAME>KROGER #412<MEMO>GROCERIES</STMTTRN>\n\
<STMTTRN><TRNTYPE>CHECK<DTPOSTED>20260804<TRNAMT>-41.10<FITID>2026080401<CHECKNUM>1042<NAME>SHELL OIL &amp; GAS</STMTTRN>\n\
</BANKTRANLIST><LEDGERBAL><BALAMT>4218.87<DTASOF>20260831</LEDGERBAL>\n\
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>\n";
        assert!(looks_like_ofx(ofx));
        let txs = parse_ofx(ofx);
        assert_eq!(txs.len(), 2, "SGML leaves were not read");
        assert_eq!(txs[0].date, "2026-08-03");
        assert_eq!(txs[0].amount_cents, -5842);
        assert_eq!(txs[0].payee, "KROGER #412");
        assert_eq!(txs[0].notes.as_deref(), Some("GROCERIES"));
        assert_eq!(txs[0].fitid.as_deref(), Some("2026080301"));
        assert_eq!(txs[1].check_number.as_deref(), Some("1042"));
        assert_eq!(txs[1].payee, "SHELL OIL & GAS", "entity escapes are decoded");
    }

    #[test]
    fn the_shipped_sample_statement_is_readable() {
        // The file the user is told to try. If this ever reads as zero rows
        // again, the import button is broken for every real bank.
        let text = include_str!("../../../samples/sample-statement.ofx");
        assert!(looks_like_ofx(text));
        let txs = parse_ofx(text);
        assert_eq!(txs.len(), 8);
        let net: i64 = txs.iter().map(|t| t.amount_cents).sum();
        assert_eq!(net, 2 * 214_088 - 5_842 - 4_110 - 145_000 - 9_263 - 1_499 - 6_375);
    }
}
