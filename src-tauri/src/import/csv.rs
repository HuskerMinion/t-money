//! CSV statements (§88). Every bank offers one; no two agree on the columns.
//! So the file is read twice: `preview` shows the first rows and GUESSES a
//! mapping from the header names; the user confirms or corrects it; then
//! `rows_to_txns` turns the file into the same `ParsedTxn`s QIF and OFX
//! produce and the shared writer takes over. Nothing is written by a preview.
//!
//! Shapes handled: one signed Amount column, or separate Debit / Credit
//! (Withdrawal / Deposit) columns; dates as M/D/YYYY, D/M/YYYY, YYYY-MM-DD,
//! with or without leading zeros, two- or four-digit years, month names
//! ("Sep 3, 2026"); amounts with $ , ( ) and a trailing minus; quoted
//! fields with embedded commas, quotes and newlines; comma, semicolon or
//! tab delimiters; a UTF-8 BOM. A card statement that lists charges as
//! positive numbers is handled by `negate`. Money is cents, as everywhere.

use super::amount::parse_amount_cents as parse_plain_cents;

/// A CSV amount cell → cents: "$1,234.56", "(150.00)", "150.00-", "-$42.50",
/// "42.50 CR" (credit → positive), "42.50 DR" (debit → negative), "USD 12".
pub fn parse_amount_cents(s: &str) -> Option<i64> {
    let mut t = s.trim().to_string();
    if t.is_empty() {
        return None;
    }
    let mut sign = 1i64;
    let upper = t.to_uppercase();
    if upper.ends_with(" CR") || upper.ends_with("CR") && upper.len() > 2 && upper.chars().rev().nth(2).map(|c| !c.is_ascii_alphabetic()).unwrap_or(false) {
        t = t[..t.len() - 2].trim().to_string();
    } else if upper.ends_with(" DR") || upper.ends_with("DR") && upper.len() > 2 && upper.chars().rev().nth(2).map(|c| !c.is_ascii_alphabetic()).unwrap_or(false) {
        sign = -1;
        t = t[..t.len() - 2].trim().to_string();
    }
    if t.starts_with('(') && t.ends_with(')') {
        sign = -sign;
        t = t[1..t.len() - 1].to_string();
    }
    if t.ends_with('-') {
        sign = -sign;
        t.pop();
    }
    if t.starts_with('-') {
        sign = -sign;
        t.remove(0);
    } else if t.starts_with('+') {
        t.remove(0);
    }
    let cleaned: String = t.chars().filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-' || *c == ',').collect();
    if cleaned.starts_with('-') {
        // "$-42.50"
        return parse_plain_cents(&cleaned).map(|c| c * sign);
    }
    parse_plain_cents(&cleaned).map(|c| c * sign)
}

/// Which column (0-based) holds what. `None` = not in this file.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct CsvMapping {
    pub date: Option<usize>,
    pub payee: Option<usize>,
    /// One signed column …
    pub amount: Option<usize>,
    /// … or two unsigned ones. Debit is money OUT.
    pub debit: Option<usize>,
    pub credit: Option<usize>,
    pub memo: Option<usize>,
    pub check_number: Option<usize>,
    pub category: Option<usize>,
    /// "auto" | "mdy" | "dmy" | "ymd" — how an ambiguous 3/4/2026 reads.
    #[serde(default = "default_date_order")]
    pub date_order: String,
    /// Flip the sign of every amount: for a card statement where a charge
    /// is written as a positive number.
    #[serde(default)]
    pub negate: bool,
    /// The first line is column names (else columns are numbered).
    #[serde(default = "default_true")]
    pub has_header: bool,
}

fn default_date_order() -> String {
    "auto".to_string()
}
fn default_true() -> bool {
    true
}

/// What the user sees before committing: the columns, the first rows, the
/// guessed mapping, and how the guess reads the first few rows.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CsvPreview {
    pub delimiter: String,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    pub mapping: CsvMapping,
    /// The sample rows as the mapping reads them — the dialog's proof.
    pub parsed: Vec<PreviewRow>,
    /// §132 — this file is a tsp.gov activity detail and belongs in the TSP
    /// importer, which is the only one that can read its funds, units and
    /// prices. The dialog says so rather than importing it flat.
    #[serde(default)]
    pub looks_like_tsp: bool,
    /// §175 — a brokerage or plan history (Symbol and Quantity columns:
    /// Fidelity, Schwab, Vanguard exports). Imported flat, every row would
    /// be a bare cash entry with no fund, no shares and no price.
    pub looks_like_brokerage: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PreviewRow {
    pub date: Option<String>,
    pub payee: Option<String>,
    pub amount_cents: Option<i64>,
    pub error: Option<String>,
    /// §165 — the rest of what the mapping writes, so the preview shows
    /// every field the import will put in the register, not only three.
    #[serde(default)]
    pub memo: Option<String>,
    #[serde(default)]
    pub check_number: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
}

pub fn parse_sample(sample: &[Vec<String>], m: &CsvMapping) -> Vec<PreviewRow> {
    sample
        .iter()
        .map(|r| match row_to_txn(r, m) {
            Ok(t) => PreviewRow { date: Some(t.date), payee: Some(t.payee), amount_cents: Some(t.amount_cents), error: None, memo: t.memo, check_number: t.check_number, category: t.category },
            Err(e) => PreviewRow { date: None, payee: None, amount_cents: None, error: Some(e), memo: None, check_number: None, category: None },
        })
        .collect()
}

/// Split a CSV text into records. RFC 4180: fields may be quoted; a quote
/// inside a quoted field is doubled; a quoted field may span lines. Blank
/// lines are dropped.
pub fn parse_records(text: &str, delimiter: char) -> Vec<Vec<String>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut records = Vec::new();
    let mut record: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => in_quotes = true,
            '\r' => {}
            '\n' => {
                record.push(std::mem::take(&mut field));
                if record.iter().any(|f| !f.trim().is_empty()) {
                    records.push(std::mem::take(&mut record));
                } else {
                    record.clear();
                }
            }
            c if c == delimiter => record.push(std::mem::take(&mut field)),
            c => field.push(c),
        }
    }
    if !field.is_empty() || !record.is_empty() {
        record.push(field);
        if record.iter().any(|f| !f.trim().is_empty()) {
            records.push(record);
        }
    }
    records
}

/// The delimiter that splits the first non-blank line into the most fields.
pub fn sniff_delimiter(text: &str) -> char {
    let first = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let count = |d: char| parse_records(first, d).first().map(|r| r.len()).unwrap_or(0);
    let (mut best, mut n) = (',', count(','));
    for d in [';', '\t', '|'] {
        let c = count(d);
        if c > n {
            best = d;
            n = c;
        }
    }
    best
}

fn norm(h: &str) -> String {
    // §175 — "Trans. Date" (Discover) is "trans date", one space, so the
    // exact matches below can name it.
    h.trim().trim_matches('"').to_lowercase().replace(['_', '-', '.'], " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Guess the mapping from the header names. Conservative: a column is
/// claimed only by a name that means one thing; the user sees the guess.
pub fn guess_mapping(headers: &[String], sample: &[Vec<String>]) -> CsvMapping {
    let mut m = CsvMapping { date_order: "auto".into(), negate: false, has_header: true, ..Default::default() };
    let find = |preds: &[&dyn Fn(&str) -> bool]| -> Option<usize> {
        for pred in preds {
            if let Some(i) = headers.iter().position(|h| pred(&norm(h))) {
                return Some(i);
            }
        }
        None
    };
    m.date = find(&[
        // The day it happened beats the day it posted (Discover ships both).
        &|h| h == "date" || h == "transaction date" || h == "trans date" || h == "run date",
        &|h| h == "posted date" || h == "post date" || h == "posting date",
        &|h| h.contains("date") && !h.contains("effective") && !h.contains("settle"),
        &|h| h.contains("date"),
    ]);
    m.payee = find(&[
        &|h| h == "payee" || h == "description" || h == "name" || h == "merchant" || h == "transaction description",
        &|h| h.contains("payee") || h.contains("description") || h.contains("merchant") || h.contains("name"),
    ]);
    m.debit = find(&[&|h| h == "debit" || h == "withdrawal" || h == "withdrawals" || h == "debit amount" || h == "amount debit" || h == "money out" || h == "paid out" || h == "charge"]);
    m.credit = find(&[&|h| h == "credit" || h == "deposit" || h == "deposits" || h == "credit amount" || h == "amount credit" || h == "money in" || h == "paid in"]);
    if m.debit.is_none() || m.credit.is_none() {
        m.amount = find(&[&|h| h == "amount" || h == "amount (usd)" || h == "transaction amount", &|h| h.contains("amount") && !h.contains("balance")]);
        if m.amount.is_some() {
            // One signed column beats a lone debit or credit column.
            m.debit = None;
            m.credit = None;
        }
    }
    m.memo = find(&[&|h| h == "memo" || h == "notes" || h == "note" || h == "reference" || h == "details" || h == "extended description" || h == "original description"]);
    m.check_number = find(&[&|h| h == "check number" || h == "check" || h == "check #" || h == "cheque" || h == "num" || h == "check no", &|h| h.contains("check") && h.contains("num")]);
    m.category = find(&[&|h| h == "category"]);
    // Payee fallback for a header-less or oddly named file: the widest text column.
    if m.payee.is_none() {
        let taken = [m.date, m.amount, m.debit, m.credit, m.memo, m.check_number, m.category];
        let mut best: Option<(usize, usize)> = None;
        for i in 0..headers.len() {
            if taken.contains(&Some(i)) {
                continue;
            }
            let width: usize = sample.iter().filter_map(|r| r.get(i)).map(|v| v.len()).sum();
            let numeric = sample.iter().filter_map(|r| r.get(i)).all(|v| parse_amount_cents(v).is_some() || v.trim().is_empty());
            if !numeric && best.map(|b| width > b.1).unwrap_or(true) {
                best = Some((i, width));
            }
        }
        m.payee = best.map(|b| b.0);
    }
    // A date order the sample settles: any day > 12 in the first slot means D/M.
    if m.date_order == "auto" {
        if let Some(d) = m.date {
            let mut first_gt12 = false;
            let mut second_gt12 = false;
            for r in sample {
                if let Some(v) = r.get(d) {
                    let parts: Vec<&str> = v.trim().split(['/', '-', '.']).collect();
                    if parts.len() == 3 && parts[0].len() <= 2 {
                        if parts[0].parse::<u32>().map(|n| n > 12).unwrap_or(false) {
                            first_gt12 = true;
                        }
                        if parts[1].parse::<u32>().map(|n| n > 12).unwrap_or(false) {
                            second_gt12 = true;
                        }
                    }
                }
            }
            if first_gt12 && !second_gt12 {
                m.date_order = "dmy".into();
            }
        }
    }
    m
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// A date cell → ISO. `order` is "mdy" | "dmy" | "ymd" | "auto" (auto =
/// ISO if it looks like it, else M/D/Y — the US default — unless the
/// first number cannot be a month).
pub fn parse_csv_date(s: &str, order: &str) -> Option<String> {
    let s = s.trim().trim_matches('"');
    if s.is_empty() {
        return None;
    }
    // "2026-09-03", "2026/09/03", possibly with a time after.
    let head = s.split([' ', 'T']).next().unwrap_or(s);
    let parts: Vec<&str> = head.split(['/', '-', '.']).collect();
    let build = |y: i64, m: i64, d: i64| -> Option<String> {
        let y = if y < 100 { if y < 70 { 2000 + y } else { 1900 + y } } else { y };
        let date = chrono::NaiveDate::from_ymd_opt(y as i32, m as u32, d as u32)?;
        Some(date.format("%Y-%m-%d").to_string())
    };
    if parts.len() == 3 {
        let nums: Option<Vec<i64>> = parts.iter().map(|p| p.trim().parse::<i64>().ok()).collect();
        if let Some(n) = nums {
            if parts[0].len() == 4 || order == "ymd" {
                return build(n[0], n[1], n[2]);
            }
            return match order {
                "dmy" => build(n[2], n[1], n[0]),
                "mdy" => build(n[2], n[0], n[1]),
                _ => {
                    if n[0] > 12 && n[1] <= 12 {
                        build(n[2], n[1], n[0])
                    } else {
                        build(n[2], n[0], n[1])
                    }
                }
            };
        }
    }
    // "Sep 3, 2026", "3 Sep 2026", "September 03 2026"
    let words: Vec<&str> = s.split(|c: char| c == ' ' || c == ',' || c == '-').filter(|w| !w.is_empty()).collect();
    if words.len() == 3 {
        let month_of = |w: &str| MONTHS.iter().position(|m| w.to_lowercase().starts_with(m)).map(|i| i as i64 + 1);
        if let (Some(m), Ok(d), Ok(y)) = (month_of(words[0]), words[1].parse::<i64>(), words[2].parse::<i64>()) {
            return build(y, m, d);
        }
        if let (Ok(d), Some(m), Ok(y)) = (words[0].parse::<i64>(), month_of(words[1]), words[2].parse::<i64>()) {
            return build(y, m, d);
        }
    }
    None
}

/// One row of the file → what the writer needs, or why it cannot be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CsvRow {
    pub date: String,
    pub payee: String,
    pub amount_cents: i64,
    pub memo: Option<String>,
    pub check_number: Option<String>,
    pub category: Option<String>,
}

pub fn row_to_txn(row: &[String], m: &CsvMapping) -> Result<CsvRow, String> {
    let cell = |i: Option<usize>| -> String { i.and_then(|i| row.get(i)).map(|s| s.trim().to_string()).unwrap_or_default() };
    let date_cell = cell(m.date);
    let date = parse_csv_date(&date_cell, &m.date_order).ok_or_else(|| format!("no date in \"{date_cell}\""))?;
    let amount_cents = if let Some(a) = m.amount {
        let v = cell(Some(a));
        parse_amount_cents(&v).ok_or_else(|| format!("no amount in \"{v}\""))?
    } else {
        let d = cell(m.debit);
        let c = cell(m.credit);
        let debit = if d.is_empty() { 0 } else { parse_amount_cents(&d).ok_or_else(|| format!("no amount in \"{d}\""))?.abs() };
        let credit = if c.is_empty() { 0 } else { parse_amount_cents(&c).ok_or_else(|| format!("no amount in \"{c}\""))?.abs() };
        if d.is_empty() && c.is_empty() {
            return Err("neither a debit nor a credit".to_string());
        }
        credit - debit
    };
    let amount_cents = if m.negate { -amount_cents } else { amount_cents };
    let payee = cell(m.payee);
    let opt = |s: String| if s.is_empty() { None } else { Some(s) };
    Ok(CsvRow {
        date,
        payee: if payee.is_empty() { "(no payee)".to_string() } else { payee },
        amount_cents,
        memo: opt(cell(m.memo)),
        check_number: opt(cell(m.check_number)),
        category: opt(cell(m.category)),
    })
}

/// The preview: delimiter, headers (or "Column 1…"), the first `n` data
/// rows, the row count, and the guessed mapping.
pub fn preview(text: &str, n: usize, has_header: Option<bool>, given: Option<&CsvMapping>) -> Result<CsvPreview, String> {
    let delimiter = sniff_delimiter(text);
    let records = parse_records(text, delimiter);
    if records.is_empty() {
        return Err("the file has no rows".to_string());
    }
    // A header row is one whose cells are mostly not numbers or dates.
    let looks_like_header = records[0].iter().filter(|c| parse_amount_cents(c).is_none() && parse_csv_date(c, "auto").is_none() && !c.trim().is_empty()).count() * 2 > records[0].len();
    let has_header = has_header.unwrap_or(looks_like_header);
    let width = records.iter().map(|r| r.len()).max().unwrap_or(0);
    let headers: Vec<String> = if has_header {
        (0..width).map(|i| records[0].get(i).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| format!("Column {}", i + 1))).collect()
    } else {
        (0..width).map(|i| format!("Column {}", i + 1)).collect()
    };
    let data: Vec<Vec<String>> = records.into_iter().skip(if has_header { 1 } else { 0 }).collect();
    let sample: Vec<Vec<String>> = data.iter().take(n).cloned().collect();
    let mut mapping = if has_header { guess_mapping(&headers, &sample) } else { guess_mapping(&[], &sample) };
    mapping.has_header = has_header;
    if !has_header {
        // Numbered columns: guess by content — first date-looking column,
        // first signed-number column, widest text column.
        for i in 0..width {
            let vals: Vec<&String> = sample.iter().filter_map(|r| r.get(i)).collect();
            if vals.is_empty() {
                continue;
            }
            if mapping.date.is_none() && vals.iter().all(|v| parse_csv_date(v, "auto").is_some()) {
                mapping.date = Some(i);
            } else if mapping.amount.is_none() && vals.iter().all(|v| parse_amount_cents(v).is_some()) {
                mapping.amount = Some(i);
            }
        }
        if mapping.payee.is_none() {
            mapping.payee = (0..width).filter(|i| Some(*i) != mapping.date && Some(*i) != mapping.amount).max_by_key(|i| sample.iter().filter_map(|r| r.get(*i)).map(|v| v.len()).sum::<usize>());
        }
    }
    let mapping = match given {
        Some(g) => CsvMapping { has_header, ..g.clone() },
        None => mapping,
    };
    let parsed = if mapping.date.is_some() && (mapping.amount.is_some() || mapping.debit.is_some() || mapping.credit.is_some()) {
        parse_sample(&sample, &mapping)
    } else {
        Vec::new()
    };
    // §132 — before offering to import this flat, check it is not a file
    // that has a reader of its own.
    let looks_like_tsp = crate::import::tsp::looks_like_tsp(&headers);
    let looks_like_brokerage = !looks_like_tsp && looks_like_brokerage(&headers);
    Ok(CsvPreview {
        delimiter: delimiter.to_string(),
        headers,
        rows: sample,
        total_rows: data.len(),
        mapping,
        parsed,
        looks_like_tsp,
        looks_like_brokerage,
    })
}

/// §175 — a Symbol (or Ticker) column beside a Quantity (or Shares, Units)
/// column is a holdings history, not a bank statement.
pub fn looks_like_brokerage(headers: &[String]) -> bool {
    let has = |pred: &dyn Fn(&str) -> bool| headers.iter().any(|h| pred(&norm(h)));
    has(&|h| h == "symbol" || h == "ticker" || h.starts_with("symbol")) && has(&|h| h == "quantity" || h == "shares" || h == "units" || h.starts_with("quantity"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quotes_embedded_commas_and_doubled_quotes() {
        let r = parse_records("a,\"b, c\",\"say \"\"hi\"\"\"\r\n1,2,3\n\n", ',');
        assert_eq!(r, vec![vec!["a", "b, c", "say \"hi\""], vec!["1", "2", "3"]]);
    }

    #[test]
    fn reads_the_amount_shapes_banks_use() {
        assert_eq!(parse_amount_cents("$1,234.56"), Some(123_456));
        assert_eq!(parse_amount_cents("(150.00)"), Some(-15_000));
        assert_eq!(parse_amount_cents("150.00-"), Some(-15_000));
        assert_eq!(parse_amount_cents("-$42.50"), Some(-4_250));
        assert_eq!(parse_amount_cents("$-42.50"), Some(-4_250));
        assert_eq!(parse_amount_cents("42.50 CR"), Some(4_250));
        assert_eq!(parse_amount_cents("42.50 DR"), Some(-4_250));
        assert_eq!(parse_amount_cents("USD 12"), Some(1_200));
        assert_eq!(parse_amount_cents(""), None);
        assert_eq!(parse_amount_cents("Opening"), None);
    }

    #[test]
    fn sniffs_the_delimiter() {
        assert_eq!(sniff_delimiter("Date;Amount;Payee\n1;2;3"), ';');
        assert_eq!(sniff_delimiter("Date\tAmount\n"), '\t');
        assert_eq!(sniff_delimiter("Date,Amount,Payee\n"), ',');
    }

    #[test]
    fn reads_the_date_shapes_banks_use() {
        assert_eq!(parse_csv_date("9/3/2026", "auto").as_deref(), Some("2026-09-03"));
        assert_eq!(parse_csv_date("09/03/26", "auto").as_deref(), Some("2026-09-03"));
        assert_eq!(parse_csv_date("2026-09-03", "auto").as_deref(), Some("2026-09-03"));
        assert_eq!(parse_csv_date("2026-09-03 14:22:01", "auto").as_deref(), Some("2026-09-03"));
        assert_eq!(parse_csv_date("25/09/2026", "auto").as_deref(), Some("2026-09-25"), "a day past 12 in front reads D/M");
        assert_eq!(parse_csv_date("03/09/2026", "dmy").as_deref(), Some("2026-09-03"));
        assert_eq!(parse_csv_date("Sep 3, 2026", "auto").as_deref(), Some("2026-09-03"));
        assert_eq!(parse_csv_date("3 September 2026", "auto").as_deref(), Some("2026-09-03"));
        assert_eq!(parse_csv_date("", "auto"), None);
        assert_eq!(parse_csv_date("Opening", "auto"), None);
    }

    #[test]
    fn guesses_a_chase_shaped_header_and_a_debit_credit_one() {
        let h = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let m = guess_mapping(&h(&["Transaction Date", "Post Date", "Description", "Category", "Type", "Amount", "Memo"]), &[]);
        assert_eq!((m.date, m.payee, m.amount, m.category, m.memo), (Some(0), Some(2), Some(5), Some(3), Some(6)));
        let m = guess_mapping(&h(&["Date", "Check Number", "Description", "Withdrawal", "Deposit", "Balance"]), &[]);
        assert_eq!((m.date, m.check_number, m.payee, m.debit, m.credit, m.amount), (Some(0), Some(1), Some(2), Some(3), Some(4), None));
    }

    // §175 — the first hour: the headers real banks ship. Each must land
    // date, payee and an amount without the user touching the mapping.
    #[test]
    fn guesses_the_headers_real_banks_ship() {
        let h = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // Capital One: separate Debit / Credit columns.
        let m = guess_mapping(&h(&["Transaction Date", "Posted Date", "Card No.", "Description", "Category", "Debit", "Credit"]), &[]);
        assert_eq!((m.date, m.payee, m.debit, m.credit, m.category), (Some(0), Some(3), Some(5), Some(6), Some(4)));
        // Discover lists purchases POSITIVE. The header cannot say so; the
        // dialog's "amounts are the wrong way round" switch (negate) is the
        // user's job, and the review's first row shows it plainly.
        let m = guess_mapping(&h(&["Trans. Date", "Post Date", "Description", "Amount", "Category"]), &[]);
        assert_eq!((m.date, m.payee, m.amount, m.category), (Some(0), Some(2), Some(3), Some(4)));
        // American Express: three columns, purchases positive too.
        let m = guess_mapping(&h(&["Date", "Description", "Amount"]), &[]);
        assert_eq!((m.date, m.payee, m.amount), (Some(0), Some(1), Some(2)));
        // First National.
        let m = guess_mapping(&h(&["Date", "Description", "Original Description", "Category", "Amount", "Status"]), &[]);
        assert_eq!((m.date, m.payee, m.memo, m.amount, m.category), (Some(0), Some(1), Some(2), Some(4), Some(3)));
        // Bank of America: "Running Bal." must not be taken for the amount.
        let m = guess_mapping(&h(&["Date", "Description", "Amount", "Running Bal."]), &[]);
        assert_eq!((m.date, m.payee, m.amount), (Some(0), Some(1), Some(2)));
        // A bank whose export has no header row at all.
        let p = preview("\"01/05/2026\",\"-45.00\",\"*\",\"\",\"FRESH MARKET #0123 ANYTOWN US\"\n\"01/06/2026\",\"1500.00\",\"*\",\"\",\"PAYROLL DEPOSIT\"\n", 10, None, None).unwrap();
        assert_eq!((p.mapping.date, p.mapping.amount, p.mapping.payee, p.mapping.has_header), (Some(0), Some(1), Some(4), false));
        assert_eq!(p.parsed.len(), 2);
        // Fidelity's brokerage history is NOT a cash register, and the guess
        // will happily map it as one — which is what §175 says the dialog
        // has to catch: Symbol / Quantity / Price columns mean "use the
        // Investing import", not a bank import.
        let fidelity = h(&["Run Date", "Action", "Symbol", "Description", "Type", "Quantity", "Price ($)", "Commission ($)", "Fees ($)", "Accrued Interest ($)", "Amount ($)", "Settlement Date"]);
        let m = guess_mapping(&fidelity, &[]);
        assert_eq!((m.date, m.payee, m.amount), (Some(0), Some(3), Some(10)));
        assert!(looks_like_brokerage(&fidelity), "…so the preview flags it and the dialog shuts the door");
        assert!(looks_like_brokerage(&h(&["Date", "Transaction", "Symbol", "Shares", "Price", "Amount"])), "Vanguard-shaped");
        assert!(!looks_like_brokerage(&h(&["Date", "Description", "Amount", "Running Bal."])), "a bank statement is not");
        let p = preview("Run Date,Action,Symbol,Description,Quantity,Amount ($)\n01/05/2026,YOU BOUGHT,VTSAX,VANGUARD TOTAL STOCK,10,-1200.00\n", 10, None, None).unwrap();
        assert!(p.looks_like_brokerage && !p.looks_like_tsp);
    }

    #[test]
    fn a_row_becomes_signed_cents_either_shape_and_negate_flips_a_card_statement() {
        let m = CsvMapping { date: Some(0), payee: Some(1), debit: Some(2), credit: Some(3), ..Default::default() };
        let r = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let out = row_to_txn(&r(&["9/3/2026", "Kroger", "$42.50", ""]), &m).unwrap();
        assert_eq!((out.date.as_str(), out.amount_cents), ("2026-09-03", -4250));
        let out = row_to_txn(&r(&["9/4/2026", "Paycheck", "", "1,500.00"]), &m).unwrap();
        assert_eq!(out.amount_cents, 150_000);
        assert!(row_to_txn(&r(&["9/4/2026", "Nothing", "", ""]), &m).is_err());
        let m = CsvMapping { date: Some(0), payee: Some(1), amount: Some(2), negate: true, ..Default::default() };
        let out = row_to_txn(&r(&["09/05/2026", "Shell", "20.00"]), &m).unwrap();
        assert_eq!(out.amount_cents, -2000, "a card lists charges positive; negate makes them payments");
        let out = row_to_txn(&r(&["09/05/2026", "Payment - thank you", "(150.00)"]), &m).unwrap();
        assert_eq!(out.amount_cents, 15_000);
    }

    #[test]
    fn preview_names_columns_and_guesses_without_a_header_too() {
        let p = preview("Date,Description,Amount\n9/3/2026,Kroger,-42.50\n9/4/2026,Paycheck,1500\n", 10, None, None).unwrap();
        assert_eq!(p.parsed.len(), 2);
        assert_eq!((p.parsed[0].date.as_deref(), p.parsed[0].amount_cents), (Some("2026-09-03"), Some(-4250)));
        assert_eq!(p.headers, vec!["Date", "Description", "Amount"]);
        assert_eq!((p.total_rows, p.rows.len(), p.mapping.has_header), (2, 2, true));
        assert_eq!((p.mapping.date, p.mapping.payee, p.mapping.amount), (Some(0), Some(1), Some(2)));
        let p = preview("9/3/2026,Kroger,-42.50\n9/4/2026,Paycheck,1500\n", 10, None, None).unwrap();
        assert_eq!(p.headers, vec!["Column 1", "Column 2", "Column 3"]);
        assert!(!p.mapping.has_header);
        assert_eq!((p.mapping.date, p.mapping.payee, p.mapping.amount), (Some(0), Some(1), Some(2)));
        assert!(preview("\n\n", 10, None, None).is_err());
        // A mapping handed in is used as given (the dialog re-previews on every change).
        let given = CsvMapping { date: Some(0), payee: Some(1), amount: Some(2), negate: true, ..Default::default() };
        let p = preview("Date,Description,Amount\n9/3/2026,Kroger,42.50\n", 10, None, Some(&given)).unwrap();
        assert_eq!(p.parsed[0].amount_cents, Some(-4250));
        assert!(p.mapping.has_header);
    }
}
