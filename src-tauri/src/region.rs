//! How a file writes numbers and dates: the region it was set up for.
//!
//! A region fixes the thousands separator, the decimal mark, which side of
//! the number the currency symbol goes on, and the order of a date's parts.
//! The same table lives in `src/lib/region.ts`; the two are kept identical so
//! a figure the backend writes into a report and one the frontend draws
//! beside it look the same.
//!
//! The table is explicit rather than taken from the operating system's
//! locale data: what a file shows should not change with the machine it is
//! opened on.
//!
//! Each command reads the open file's home currency and region into a
//! per-thread `Display` (`set_display`), so the formatting helpers here need
//! no connection. Outside a command — a test, a background job — the
//! defaults apply: US dollars, United States.

use crate::currency;
use chrono::{Datelike, NaiveDate};
use serde::Serialize;
use std::cell::RefCell;

/// The app setting that holds the file's region.
pub const REGION_KEY: &str = "file.region";
pub const DEFAULT_REGION: &str = "en-US";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DateOrder {
    Mdy,
    Dmy,
    Ymd,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct Region {
    /// BCP 47 tag.
    pub code: &'static str,
    pub name: &'static str,
    /// The currency people there use, written with its local symbol.
    pub currency: &'static str,
    pub group: &'static str,
    pub decimal: &'static str,
    /// The symbol follows the number ("1.234,56 €").
    pub symbol_after: bool,
    /// A space (no-break) between symbol and number.
    pub symbol_space: bool,
    pub date_order: DateOrder,
    pub date_sep: &'static str,
}

const NBSP: &str = "\u{a0}";
const NNBSP: &str = "\u{202f}";

pub const REGIONS: &[Region] = &[
    Region { code: "en-US", name: "United States", currency: "USD", group: ",", decimal: ".", symbol_after: false, symbol_space: false, date_order: DateOrder::Mdy, date_sep: "/" },
    Region { code: "en-CA", name: "Canada (English)", currency: "CAD", group: ",", decimal: ".", symbol_after: false, symbol_space: false, date_order: DateOrder::Ymd, date_sep: "-" },
    Region { code: "fr-CA", name: "Canada (French)", currency: "CAD", group: NBSP, decimal: ",", symbol_after: true, symbol_space: true, date_order: DateOrder::Ymd, date_sep: "-" },
    Region { code: "es-MX", name: "Mexico", currency: "MXN", group: ",", decimal: ".", symbol_after: false, symbol_space: false, date_order: DateOrder::Dmy, date_sep: "/" },
    Region { code: "en-GB", name: "United Kingdom", currency: "GBP", group: ",", decimal: ".", symbol_after: false, symbol_space: false, date_order: DateOrder::Dmy, date_sep: "/" },
    Region { code: "en-IE", name: "Ireland", currency: "EUR", group: ",", decimal: ".", symbol_after: false, symbol_space: false, date_order: DateOrder::Dmy, date_sep: "/" },
    Region { code: "de-DE", name: "Germany", currency: "EUR", group: ".", decimal: ",", symbol_after: true, symbol_space: true, date_order: DateOrder::Dmy, date_sep: "." },
    Region { code: "fr-FR", name: "France", currency: "EUR", group: NNBSP, decimal: ",", symbol_after: true, symbol_space: true, date_order: DateOrder::Dmy, date_sep: "/" },
    Region { code: "es-ES", name: "Spain", currency: "EUR", group: ".", decimal: ",", symbol_after: true, symbol_space: true, date_order: DateOrder::Dmy, date_sep: "/" },
    Region { code: "it-IT", name: "Italy", currency: "EUR", group: ".", decimal: ",", symbol_after: true, symbol_space: true, date_order: DateOrder::Dmy, date_sep: "/" },
    Region { code: "nl-NL", name: "Netherlands", currency: "EUR", group: ".", decimal: ",", symbol_after: false, symbol_space: true, date_order: DateOrder::Dmy, date_sep: "-" },
    Region { code: "en-AU", name: "Australia", currency: "AUD", group: ",", decimal: ".", symbol_after: false, symbol_space: false, date_order: DateOrder::Dmy, date_sep: "/" },
];

pub fn find(code: &str) -> Option<&'static Region> {
    REGIONS.iter().find(|r| r.code == code)
}

pub fn validate(code: &str) -> Result<&'static Region, String> {
    find(code.trim()).ok_or_else(|| format!("{} is not a region this app supports", code.trim()))
}

/// What the current command writes in: the open file's home currency and
/// region.
#[derive(Debug, Clone, Copy)]
pub struct Display {
    pub home: &'static str,
    pub region: &'static Region,
}

impl Default for Display {
    fn default() -> Self {
        Display { home: currency::DEFAULT_HOME, region: find(DEFAULT_REGION).expect("default region") }
    }
}

thread_local! {
    static DISPLAY: RefCell<Display> = RefCell::new(Display::default());
}

/// Use this file's home currency and region on this thread until the next
/// call. Unknown values fall back to the defaults rather than failing a
/// command over how it would print.
pub fn set_display(home: Option<&str>, region: Option<&str>) {
    let d = Display {
        home: home.and_then(|h| currency::find(h)).map(|c| c.code).unwrap_or(currency::DEFAULT_HOME),
        region: region.and_then(find).unwrap_or_else(|| find(DEFAULT_REGION).expect("default region")),
    };
    DISPLAY.with(|c| *c.borrow_mut() = d);
}

pub fn display() -> Display {
    DISPLAY.with(|c| *c.borrow())
}

/// The symbol `currency` is written with in `region`: the local one for the
/// region's own currency, the unambiguous one for any other.
pub fn symbol_in(currency: &str, region: &Region) -> String {
    match currency::find(currency) {
        Some(c) if c.code == region.currency => c.local_symbol.to_string(),
        Some(c) => c.symbol.to_string(),
        None => currency.to_string(),
    }
}

/// The digits of a magnitude in hundredths, grouped and with the decimal
/// mark: "1,234.56" / "1.234,56".
pub fn number_in(cents: u64, region: &Region) -> String {
    let whole = (cents / 100).to_string();
    let mut grouped = String::new();
    for (i, ch) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push_str(region.group);
        }
        grouped.push(ch);
    }
    format!("{grouped}{}{:02}", region.decimal, cents % 100)
}

/// An amount in `currency`, written the region's way. Negative with a
/// leading minus: "-$1,234.56", "-1.234,56 €".
pub fn money_in(cents: i64, currency: &str, region: &Region) -> String {
    let n = number_in(cents.unsigned_abs(), region);
    let sym = symbol_in(currency, region);
    let gap = if region.symbol_space { NBSP } else { "" };
    let body = if region.symbol_after { format!("{n}{gap}{sym}") } else { format!("{sym}{gap}{n}") };
    if cents < 0 { format!("-{body}") } else { body }
}

/// An amount in the current file's home currency.
pub fn money(cents: i64) -> String {
    let d = display();
    money_in(cents, d.home, d.region)
}

/// An amount in `currency`, in the current file's region.
pub fn money_of(cents: i64, currency: &str) -> String {
    money_in(cents, currency, display().region)
}

/// A number typed in `region`'s way, as "1234.56" — group marks gone, the
/// decimal mark a dot — or None when it cannot be one. The same rule as
/// `normalizeNumber` in `format.ts` (with its groups read first): the
/// region's own marks as the region writes them; the other mark forgiven
/// once, with no more than `max_decimals` digits after it; thousands groups
/// whole, so "1.2345" and "0.123" are refused rather than guessed.
pub fn typed_to_dot(s: &str, region: &Region, max_decimals: usize) -> Option<String> {
    let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    let (neg, body) = match s.strip_prefix('-') {
        Some(b) => (true, b.to_string()),
        None => (false, s.clone()),
    };
    let d = region.decimal;
    let g = region.group.trim();
    let o = if d == "," { "." } else { "," };
    let whole_groups = |t: &str, mark: &str| -> bool {
        let segs: Vec<&str> = t.split(mark).collect();
        segs.len() > 1
            && (1..=3).contains(&segs[0].len())
            && segs[0].chars().all(|c| c.is_ascii_digit())
            && !segs[0].starts_with('0')
            && segs[1..].iter().all(|x| x.len() == 3 && x.chars().all(|c| c.is_ascii_digit()))
    };
    let as_decimal = |t: &str, mark: &str| -> Option<String> {
        let parts: Vec<&str> = t.split(mark).collect();
        (parts.len() == 2
            && (1..=max_decimals).contains(&parts[1].len())
            && parts[0].chars().all(|c| c.is_ascii_digit())
            && parts[1].chars().all(|c| c.is_ascii_digit()))
        .then(|| format!("{}.{}", parts[0], parts[1]))
    };
    let out = if let Some(at) = body.find(d) {
        let mut whole = body[..at].to_string();
        let frac = &body[at + d.len()..];
        if frac.contains(d) {
            return None;
        }
        if !g.is_empty() && whole.contains(g) {
            if !whole_groups(&whole, g) {
                return None;
            }
            whole = whole.replace(g, "");
        }
        format!("{whole}.{frac}")
    } else if body.contains(o) {
        if o == g && whole_groups(&body, o) {
            body.replace(o, "")
        } else {
            as_decimal(&body, o)?
        }
    } else {
        body
    };
    Some(if neg { format!("-{out}") } else { out })
}

/// A date written the region's way: 10/1/2026 (the US leaves month and day
/// unpadded, as this app always has), 01.10.2026, 2026-10-01.
pub fn date_in(d: NaiveDate, region: &Region) -> String {
    let s = region.date_sep;
    match region.date_order {
        DateOrder::Mdy => format!("{}{s}{}{s}{}", d.month(), d.day(), d.year()),
        DateOrder::Dmy => format!("{:02}{s}{:02}{s}{}", d.day(), d.month(), d.year()),
        DateOrder::Ymd => format!("{}{s}{:02}{s}{:02}", d.year(), d.month(), d.day()),
    }
}

/// A date in the current file's region.
pub fn date(d: NaiveDate) -> String {
    date_in(d, display().region)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(code: &str) -> &'static Region {
        find(code).unwrap()
    }

    #[test]
    fn every_region_names_a_supported_currency_and_is_listed_once() {
        let mut codes: Vec<_> = REGIONS.iter().map(|r| r.code).collect();
        codes.sort();
        codes.dedup();
        assert_eq!(codes.len(), REGIONS.len());
        assert!(REGIONS.iter().all(|r| currency::find(r.currency).is_some()));
        assert!(REGIONS.iter().all(|r| r.group != r.decimal));
    }

    #[test]
    fn money_is_written_the_regions_way() {
        assert_eq!(money_in(123_456, "USD", r("en-US")), "$1,234.56");
        assert_eq!(money_in(-123_456, "USD", r("en-US")), "-$1,234.56");
        assert_eq!(money_in(123_456, "EUR", r("en-US")), "€1,234.56");
        assert_eq!(money_in(123_456, "CAD", r("en-US")), "CA$1,234.56");
        assert_eq!(money_in(123_456, "CAD", r("en-CA")), "$1,234.56");
        assert_eq!(money_in(123_456, "USD", r("en-CA")), "US$1,234.56");
        assert_eq!(money_in(123_456_789, "EUR", r("de-DE")), "1.234.567,89\u{a0}€");
        assert_eq!(money_in(-5, "EUR", r("de-DE")), "-0,05\u{a0}€");
        assert_eq!(money_in(123_456, "EUR", r("fr-FR")), "1\u{202f}234,56\u{a0}€");
        assert_eq!(money_in(123_456, "CAD", r("fr-CA")), "1\u{a0}234,56\u{a0}$");
        assert_eq!(money_in(123_456, "EUR", r("nl-NL")), "€\u{a0}1.234,56");
        assert_eq!(money_in(0, "GBP", r("en-GB")), "£0.00");
    }

    #[test]
    fn dates_are_written_in_the_regions_order() {
        let d = NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
        assert_eq!(date_in(d, r("en-US")), "10/1/2026");
        assert_eq!(date_in(d, r("en-GB")), "01/10/2026");
        assert_eq!(date_in(d, r("de-DE")), "01.10.2026");
        assert_eq!(date_in(d, r("en-CA")), "2026-10-01");
        assert_eq!(date_in(d, r("nl-NL")), "01-10-2026");
    }

    #[test]
    fn a_thread_without_a_file_writes_the_defaults_and_bad_values_fall_back() {
        std::thread::spawn(|| {
            assert_eq!(money(100), "$1.00");
            set_display(Some("EUR"), Some("de-DE"));
            assert_eq!(money(100), "1,00\u{a0}€");
            assert_eq!(money_of(100, "USD"), "1,00\u{a0}US$");
            set_display(Some("XXX"), Some("xx-XX"));
            assert_eq!(money(100), "$1.00");
        })
        .join()
        .unwrap();
    }
}

#[cfg(test)]
mod report_text_tests {
    use super::*;

    #[test]
    fn report_text_follows_the_files_region() {
        std::thread::spawn(|| {
            set_display(Some("EUR"), Some("de-DE"));
            assert_eq!(crate::db::lots::fmt_shares(12_345_600), "12,3456");
            let d = NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
            assert_eq!(crate::db::reports::range_label(d, d), "01.10.2026 through 01.10.2026");
            assert_eq!(crate::models::format_cents(-123_456), "-1.234,56\u{a0}€");
            assert_eq!(crate::models::format_cents_in(500, "USD"), "5,00\u{a0}US$");
        })
        .join()
        .unwrap();
    }
}
