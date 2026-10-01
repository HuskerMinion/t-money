//! Share prices, fetched on demand.
//!
//! # The one thing in this app that talks to the outside world
//!
//! T-Money is local-first: one encrypted file on one machine, no server, no
//! account. This module is the single exception, and it is deliberately
//! narrow:
//!
//! - **Nothing fetches unless the user said so.** By default a request leaves
//!   this machine only when the user presses "Refresh prices". A later change added an
//!   opt-in timer (Settings → Money → Prices: once a day or once a week, off
//!   by default) that runs only while T-Money is open with a file open
//!   — no background service, nothing while the app is closed.
//! - **Only ticker symbols leave.** Not quantities, not cost basis, not
//!   account names, not balances. The remote end learns which symbols were
//!   asked about and nothing else — no holding sizes, no identity.
//! - **It degrades to nothing.** Offline, blocked, or a symbol the source has
//!   never heard of: the holding keeps the value it had and the screen says
//!   which symbols failed. There is no state that only works online.
//!
//! # The source
//!
//! Yahoo Finance's chart endpoint, keyless:
//! `query1.finance.yahoo.com/v8/finance/chart/<symbol>?range=1d&interval=1d`,
//! reading `chart.result[0].meta.regularMarketPrice`.
//!
//! **This replaced Stooq, which stopped working.** Checked on 2026-09-03,
//! not guessed:
//!
//! | URL | Result |
//! |---|---|
//! | `stooq.com/q/l/?s=aapl.us&…&e=csv` | **404**, Stooq's own error page — in the app *and* in a browser |
//! | `stooq.com/q/d/l/?s=aapl.us&i=d` | 200, but an HTML `<noscript>` anti-bot challenge, not CSV |
//! | `query1.../chart/AAPL` | 200, `regularMarketPrice` 327.44 USD |
//! | `query1.../chart/VTSAX` | 200, 183.44 USD — **mutual funds are covered**, which Stooq's endpoint never did |
//! | `query1.../chart/ZZZZNOTREAL` | 404 with a clean JSON error |
//!
//! Still no API key and no account, so there is no per-user token tying this
//! file to an identity — the property that mattered when the source was
//! chosen.
//!
//! **Be honest about what this is:** an undocumented endpoint that Yahoo
//! publishes for its own site, not a public API with a contract. It can change
//! or start refusing without notice, and hammering it would be abuse. That is
//! survivable here precisely because the feature is manual, occasional, and
//! degrades to nothing — but if it breaks, the fix is to check what the
//! endpoint now returns (as was done here), not to retry harder.
//!
//! The HTTP call is one small function (`fetch_body`). Everything else here —
//! JSON parsing, the currency guard, the quantity x price arithmetic — is pure
//! and tested, because that is where the bugs that would corrupt a portfolio
//! live.

use crate::models::{PriceFailure, PriceRefreshSummary};
use chrono::NaiveDate;
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::{Decimal, RoundingStrategy};
use std::str::FromStr;

/// How old the source's latest quote may be before it is refused.
/// A week covers a long weekend plus a market holiday with room to spare; a
/// quote older than that is a delisted or halted symbol whose "current" price
/// is history, and writing it would make the staleness line say the
/// holding was priced today.
pub const MAX_QUOTE_AGE_DAYS: i64 = 7;

/// A parsed quote: the price and the trading day it is from.
#[derive(Debug, Clone, PartialEq)]
pub struct Quote {
    pub price: Decimal,
    /// The day of `meta.regularMarketTime` in the exchange's own time zone
    /// (`meta.gmtoffset`). A price refreshed on Monday morning is
    /// Friday's close, and storing it under Monday invents a price for a day
    /// that has none. `None` only when the reply omits the timestamp — every
    /// reply measured has it, so this is the endpoint changing shape, and the
    /// caller falls back to today rather than refusing every symbol.
    pub date: Option<NaiveDate>,
}

impl Quote {
    /// The date to store this price under: the quote's own trading day, never
    /// later than `today` (an exchange east of the user can already be on
    /// tomorrow), and `today` when the reply had no timestamp.
    pub fn store_date(&self, today: NaiveDate) -> NaiveDate {
        self.date.map_or(today, |d| d.min(today))
    }
}

/// Why a quote could not be had — split so a refresh can tell "this symbol"
/// from "the price source". Twenty symbols against a machine with no
/// network would otherwise wait out twenty ten-second timeouts and print the
/// same line twenty times.
#[derive(Debug, Clone, PartialEq)]
pub enum QuoteError {
    /// The source itself could not be used: no connection, a timeout, or an
    /// HTTP status that refuses every request alike (401, 403, 429, 5xx).
    /// Every later symbol would fail the same way; a caller should stop.
    Source(String),
    /// This symbol only: unknown, not in dollars, stale, or unreadable.
    Symbol(String),
}

impl QuoteError {
    pub fn is_source(&self) -> bool {
        matches!(self, QuoteError::Source(_))
    }
    pub fn message(&self) -> &str {
        match self {
            QuoteError::Source(m) | QuoteError::Symbol(m) => m,
        }
    }
}

impl std::fmt::Display for QuoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl From<QuoteError> for String {
    fn from(e: QuoteError) -> String {
        match e {
            QuoteError::Source(m) | QuoteError::Symbol(m) => m,
        }
    }
}

/// The symbol as the endpoint wants it: trimmed and upper-cased. Unlike
/// Stooq, no market suffix is added — Yahoo takes the plain ticker, and a
/// `.us` appended here is what would make a valid symbol 404.
pub fn quote_symbol(symbol: &str) -> String {
    symbol.trim().to_ascii_uppercase()
}

/// `quote_symbol`, percent-encoded for use in a URL path. Yahoo spells
/// share classes with a hyphen (`BRK-B`), but a user who types `BRK/B` or
/// pastes something with a `?` must not rewrite the request's path or query.
/// Letters, digits, `-`, `.`, `_` and `^` pass through; everything else is
/// encoded.
pub fn quote_symbol_encoded(symbol: &str) -> String {
    let mut out = String::new();
    for b in quote_symbol(symbol).bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'^' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Parse the chart endpoint's JSON and return the current price and the
/// trading day it is from, refusing a quote older than `MAX_QUOTE_AGE_DAYS`
/// before `today`.
///
/// The shape, trimmed to what matters:
/// ```json
/// {"chart":{"result":[{"meta":{"currency":"USD","regularMarketPrice":327.44,
///   "regularMarketTime":1788465600,"gmtoffset":-14400}}],"error":null}}
/// ```
/// and on a bad symbol:
/// ```json
/// {"chart":{"result":null,"error":{"code":"Not Found","description":"No data found…"}}}
/// ```
/// `parse_quote_json_in` for a dollar file — what the tests read quotes as.
#[cfg(test)]
pub fn parse_quote_json(body: &str, today: NaiveDate) -> Result<Quote, String> {
    parse_quote_json_in(body, today, crate::currency::DEFAULT_HOME)
}

/// `parse_quote_json` for a file whose home currency is `currency`: a quote
/// in any other currency is refused.
pub fn parse_quote_json_in(body: &str, today: NaiveDate, currency: &str) -> Result<Quote, String> {
    let (price, meta_time) = parse_price_and_time(body, currency)?;
    let date = match meta_time {
        Some((secs, offset)) => Some(
            chrono::DateTime::from_timestamp(secs.saturating_add(offset), 0)
                .ok_or_else(|| format!("the price source returned an impossible quote time {secs}"))?
                .date_naive(),
        ),
        None => None,
    };
    if let Some(d) = date {
        if (today - d).num_days() > MAX_QUOTE_AGE_DAYS {
            return Err(format!(
                "the price source's latest quote is from {}",
                crate::region::date(d)
            ));
        }
    }
    Ok(Quote { price, date })
}

/// The price, and `(regularMarketTime, gmtoffset)` when the reply has a
/// timestamp. A missing `gmtoffset` is read as UTC: the date can then be a
/// day off near midnight, which is still nearer than "today" was.
fn parse_price_and_time(body: &str, currency: &str) -> Result<(Decimal, Option<(i64, i64)>), String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|_| "the price source did not return JSON".to_string())?;

    // A stated error beats guessing at a missing field.
    if let Some(desc) = v["chart"]["error"]["description"].as_str() {
        return Err(desc.to_string());
    }
    if let Some(code) = v["chart"]["error"]["code"].as_str() {
        return Err(code.to_string());
    }

    let meta = &v["chart"]["result"][0]["meta"];
    if meta.is_null() {
        return Err("the price source returned no data for this symbol".to_string());
    }

    // This app stores one currency: cents of the user's own. A price in GBP
    // written into the same i64 as everything else is not a small error, it is
    // a silently wrong portfolio — so refuse rather than convert.
    match meta["currency"].as_str() {
        Some(c) if c == currency => {}
        Some(other) => {
            return Err(format!(
                "priced in {other}; this app stores one currency and will not convert"
            ))
        }
        None => return Err("the price source did not say what currency this is".to_string()),
    }

    // The number arrives as a JSON float. Going through its decimal STRING
    // rather than an f64 keeps the app's no-binary-floats rule intact all the
    // way to the cent.
    let raw = meta["regularMarketPrice"]
        .as_f64()
        .ok_or("the price source did not return a price for this symbol")?;
    if !raw.is_finite() {
        return Err("the price source returned a non-finite price".to_string());
    }
    let price =
        Decimal::from_str(&format!("{raw}")).map_err(|_| format!("unreadable price {raw}"))?;
    if price <= Decimal::ZERO {
        // Never write a zero or negative price: it would silently zero the
        // holding's value, which looks exactly like a real loss.
        return Err(format!("the price source returned {price}, which cannot be a price"));
    }
    let time = meta["regularMarketTime"]
        .as_i64()
        .map(|t| (t, meta["gmtoffset"].as_i64().unwrap_or(0)));
    Ok((price, time))
}

/// A price in whole cents. Prices with sub-cent precision do exist; the app
/// stores money as i64 cents everywhere and this is where that rounding
/// happens.
///
/// **Half away from zero**, matching `import::amount::parse_amount_cents` —
/// the conventional money rounding, and the rule already used on every
/// imported amount. `Decimal::round()` is *banker's* rounding (half to even),
/// which sent 1.005 to 1.00 here while the import path sent it to 1.01. Two
/// rounding conventions in one money application is a defect even when each
/// is defensible on its own; the tests here pin this one.
pub fn price_to_cents(price: Decimal) -> Result<i64, String> {
    (price * Decimal::from(100))
        .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
        .to_i64()
        .ok_or_else(|| format!("price {price} does not fit in i64 cents"))
}

/// A price in millionths of a dollar — the unit `security_prices` stores,
/// because fund NAVs carry four decimals. Same rounding rule as
/// `price_to_cents`.
pub fn price_to_micro(price: Decimal) -> Result<i64, String> {
    let micro = (price * Decimal::from(1_000_000))
        .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
        .to_i64()
        .ok_or_else(|| format!("price {price} does not fit in i64 micro-dollars"))?;
    // The parser refuses a zero price because a zero silently wipes a
    // holding's value — and 0.0000004 passed that check and then rounded to
    // exactly the zero it exists to keep out.
    if price > Decimal::ZERO && micro == 0 {
        return Err(format!(
            "the price source returned {price}, which is less than a millionth of a dollar"
        ));
    }
    Ok(micro)
}

/// `quantity` x `price`, in cents. Quantity is stored as a decimal string to
/// keep fractional shares exact, so this parses rather than trusting an f64.
pub fn holding_value_cents(quantity: &str, price: Decimal) -> Result<i64, String> {
    let q = quantity.trim();
    if q.is_empty() {
        return Err("this holding has no quantity".to_string());
    }
    let qty = Decimal::from_str(q).map_err(|_| format!("unreadable quantity {q:?}"))?;
    if qty < Decimal::ZERO {
        return Err(format!("negative quantity {q:?}"));
    }
    (qty * price * Decimal::from(100))
        .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
        .to_i64()
        .ok_or_else(|| "the resulting value does not fit in i64 cents".to_string())
}

/// The URL a quote is fetched from. Public so the error text can quote it —
/// the fastest way to diagnose a failure is to paste this into a browser,
/// which is exactly how the Stooq breakage was pinned down.
pub fn quote_url(symbol: &str) -> String {
    format!(
        "https://query1.finance.yahoo.com/v8/finance/chart/{}?range=1d&interval=1d",
        quote_symbol_encoded(symbol)
    )
}

/// The only function here that touches the network.
///
/// Kept deliberately tiny so everything around it can be tested without one.
/// `ureq` is blocking, so callers must run this off the async runtime.
///
/// A 404 here is normal and meaningful — it is how the endpoint says it has
/// never heard of a symbol — so its JSON body is parsed rather than discarded,
/// and the endpoint's own wording is what reaches the user.
///
/// Any OTHER non-2xx status is an error that names the status. Before,
/// every status's body went to the parser, so a 429 or a 503 with an HTML
/// page read as "the price source did not return JSON" — true, and no help
/// at all in working out that the source was refusing or down.
pub fn fetch_body(symbol: &str) -> Result<String, QuoteError> {
    let url = quote_url(symbol);
    let resp = ureq::get(&url)
        .set("User-Agent", "Mozilla/5.0 (compatible; T-Money/0.1; personal finance)")
        .set("Accept", "application/json,text/plain,*/*")
        .timeout(std::time::Duration::from_secs(10))
        .call();

    match resp {
        Ok(r) => r.into_string().map_err(|e| {
            QuoteError::Source(format!("could not read the reply from {url}: {e}"))
        }),
        // A 404 carries a JSON explanation; hand the body back so the parser
        // can surface the endpoint's own words instead of a bare status.
        Err(ureq::Error::Status(404, r)) => r.into_string().map_err(|e| {
            QuoteError::Symbol(format!("could not read the error reply from {url}: {e}"))
        }),
        Err(ureq::Error::Status(code, r)) => {
            let status_text = r.status_text().to_string();
            let body = r.into_string().unwrap_or_default();
            Err(status_error(code, &status_text, &body, &url))
        }
        Err(ureq::Error::Transport(t)) => Err(QuoteError::Source(format!(
            "could not reach the price source at {url}: {t}"
        ))),
    }
}

/// The error for a non-404 HTTP failure: the status always, the endpoint's
/// own description when the body has one, and which side of `QuoteError` it
/// falls on. Pure, so the classification is tested without a network.
pub fn status_error(code: u16, status_text: &str, body: &str, url: &str) -> QuoteError {
    let described = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["chart"]["error"]["description"].as_str().map(str::to_string));
    let mut msg = format!("the price source answered HTTP {code}");
    if !status_text.trim().is_empty() {
        msg.push_str(&format!(" {}", status_text.trim()));
    }
    if let Some(d) = described {
        msg.push_str(&format!(": {d}"));
    }
    msg.push_str(&format!(" ({url})"));
    // Authentication, rate limiting and server errors refuse every symbol
    // alike; any other 4xx is about the request, which here means the symbol.
    if matches!(code, 401 | 403 | 429) || code >= 500 {
        QuoteError::Source(msg)
    } else {
        QuoteError::Symbol(msg)
    }
}

/// A quote for one symbol, with its trading day and a `QuoteError` that says
/// whether the failure was this symbol or the source. `today` is the
/// user's local date, for the staleness check. Only a quote in `currency` —
/// the file's home currency — is taken.
pub fn quote_dated_in(symbol: &str, today: NaiveDate, currency: &str) -> Result<Quote, QuoteError> {
    let body = fetch_body(symbol)?;
    parse_quote_json_in(&body, today, currency).map_err(QuoteError::Symbol)
}

/// An empty summary, so callers can build one up.
pub fn empty_summary() -> PriceRefreshSummary {
    PriceRefreshSummary {
        updated: 0,
        skipped: 0,
        failures: Vec::new(),
    }
}

/// Record a failure against a symbol, for the UI to show verbatim.
pub fn fail(summary: &mut PriceRefreshSummary, symbol: &str, reason: impl Into<String>) {
    summary.failures.push(PriceFailure {
        symbol: symbol.to_string(),
        reason: reason.into(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The endpoint's real shape, trimmed. Captured on 2026-09-03 rather
    /// than invented, so these fixtures match what the code
    /// will actually meet.
    fn ok_json(currency: &str, price: &str) -> String {
        format!(
            r#"{{"chart":{{"result":[{{"meta":{{"currency":"{currency}","symbol":"AAPL",
               "regularMarketPrice":{price},"exchangeName":"NMS"}}}}],"error":null}}}}"#
        )
    }

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 9, 14).unwrap()
    }

    /// The reply as it really arrives, with the quote's own time.
    /// 1789156800 is 2026-09-11 20:00 UTC — 4:00 p.m. in New York (EDT,
    /// gmtoffset -14400), Friday's close.
    fn timed_json(price: &str, time: i64, gmtoffset: i64) -> String {
        format!(
            r#"{{"chart":{{"result":[{{"meta":{{"currency":"USD","symbol":"VTSAX",
               "exchangeName":"NAS","instrumentType":"MUTUALFUND",
               "regularMarketTime":{time},"gmtoffset":{gmtoffset},"timezone":"EDT",
               "exchangeTimezoneName":"America/New_York",
               "regularMarketPrice":{price},"chartPreviousClose":182.9}},
               "timestamp":[{time}],"indicators":{{"quote":[{{}}]}}}}],"error":null}}}}"#
        )
    }

    const NOT_FOUND: &str = r#"{"chart":{"result":null,
        "error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}"#;

    #[test]
    fn the_symbol_is_the_plain_ticker() {
        // Stooq needed a `.us` suffix; Yahoo does not, and adding one is
        // exactly what would turn a valid symbol into a 404.
        assert_eq!(quote_symbol(" aapl "), "AAPL");
        assert_eq!(quote_symbol("vtsax"), "VTSAX");
    }

    #[test]
    fn the_quote_url_is_quotable_in_an_error() {
        // The error text hands this to the user to paste into a browser; if it
        // is not a URL a browser can open, the diagnostic is worthless. This
        // is how the Stooq breakage was actually found.
        let u = quote_url("AAPL");
        assert!(u.starts_with("https://"), "{u}");
        assert!(u.contains("/chart/AAPL"), "{u}");
    }

    #[test]
    fn reads_the_current_price() {
        assert_eq!(
            parse_quote_json(&ok_json("USD", "327.44"), today()).unwrap().price,
            Decimal::from_str("327.44").unwrap()
        );
    }

    #[test]
    fn the_quote_is_dated_by_its_own_trading_day_not_the_refresh_day() {
        // Refreshed Monday the 14th, the price is Friday the 11th's
        // close, and that is the row it belongs in.
        let q = parse_quote_json(&timed_json("183.44", 1_789_156_800, -14_400), today()).unwrap();
        assert_eq!(q.price, Decimal::from_str("183.44").unwrap());
        assert_eq!(q.date, NaiveDate::from_ymd_opt(2026, 9, 11));
        assert_eq!(q.store_date(today()), NaiveDate::from_ymd_opt(2026, 9, 11).unwrap());
    }

    #[test]
    fn the_date_is_the_exchanges_not_utcs() {
        // 00:30 UTC on the 12th is 8:30 p.m. on the 11th in New York: a UTC
        // date would put Friday's after-hours quote on Saturday.
        let q = parse_quote_json(&timed_json("10", 1_789_173_000, -14_400), today()).unwrap();
        assert_eq!(q.date, NaiveDate::from_ymd_opt(2026, 9, 11));
        let utc = parse_quote_json(&timed_json("10", 1_789_173_000, 0), today()).unwrap();
        assert_eq!(utc.date, NaiveDate::from_ymd_opt(2026, 9, 12));
    }

    #[test]
    fn a_quote_more_than_a_week_old_is_a_failure_not_a_price() {
        // 28 August is seventeen days before the 14th: a halted or
        // delisted symbol, whose last price must not be written as today's.
        let err = parse_quote_json(&timed_json("50", 1_787_947_200, -14_400), today()).unwrap_err();
        assert_eq!(err, "the price source's latest quote is from 8/28/2026");
        // Exactly a week is still a price — a holiday week is not stale.
        let week = NaiveDate::from_ymd_opt(2026, 9, 18).unwrap();
        assert!(parse_quote_json(&timed_json("50", 1_789_156_800, -14_400), week).is_ok());
        let eight = NaiveDate::from_ymd_opt(2026, 9, 19).unwrap();
        assert!(parse_quote_json(&timed_json("50", 1_789_156_800, -14_400), eight).is_err());
    }

    #[test]
    fn a_quote_is_never_stored_after_today_and_an_undated_one_uses_today() {
        let ahead = Quote {
            price: Decimal::ONE,
            date: NaiveDate::from_ymd_opt(2026, 9, 15),
        };
        assert_eq!(ahead.store_date(today()), today());
        // No timestamp in the reply: today, as before.
        let q = parse_quote_json(&ok_json("USD", "1"), today()).unwrap();
        assert_eq!(q.date, None);
        assert_eq!(q.store_date(today()), today());
    }

    #[test]
    fn an_http_failure_names_its_status_and_says_whose_failure_it_is() {
        // A 503's HTML page used to surface as "did not return JSON".
        let url = quote_url("AAPL");
        let e = status_error(503, "Service Unavailable", "<html>down</html>", &url);
        assert!(e.is_source(), "{e:?}");
        assert!(e.message().contains("HTTP 503 Service Unavailable"), "{e}");
        assert!(e.message().contains(&url), "{e}");
        assert!(status_error(429, "Too Many Requests", "", &url).is_source());
        assert!(status_error(403, "", "", &url).is_source());
        // A 400 about this request is this symbol's, and keeps the endpoint's
        // own words.
        let bad = r#"{"chart":{"result":null,"error":{"code":"Bad Request","description":"Invalid symbol"}}}"#;
        let e = status_error(400, "Bad Request", bad, &url);
        assert!(!e.is_source(), "{e:?}");
        assert!(e.message().contains("HTTP 400") && e.message().contains("Invalid symbol"), "{e}");
        assert_eq!(String::from(e.clone()), e.to_string());
    }

    #[test]
    fn a_positive_price_that_rounds_to_zero_micro_dollars_is_refused() {
        // It passed the parser's zero check and then became the zero.
        assert!(price_to_micro(Decimal::from_str("0.0000004").unwrap()).is_err());
        assert_eq!(price_to_micro(Decimal::from_str("0.0000005").unwrap()).unwrap(), 1);
        assert_eq!(price_to_micro(Decimal::from_str("183.4412").unwrap()).unwrap(), 183_441_200);
    }

    #[test]
    fn an_unknown_symbol_reports_the_endpoints_own_words() {
        // THE case to get right. A missing price parsed carelessly becomes 0,
        // and a zero price silently wipes the holding's value —
        // indistinguishable from a real total loss.
        let err = parse_quote_json(NOT_FOUND, today()).unwrap_err();
        assert!(err.contains("delisted"), "unhelpful: {err}");
    }

    #[test]
    fn a_price_in_another_currency_is_refused_not_converted() {
        // The app stores one currency in one i64. A GBP price written into the
        // same field is not a small error, it is a silently wrong portfolio.
        let err = parse_quote_json(&ok_json("GBP", "327.44"), today()).unwrap_err();
        assert!(err.contains("GBP") && err.contains("convert"), "{err}");
    }

    #[test]
    fn a_reply_with_no_currency_is_refused() {
        let body = r#"{"chart":{"result":[{"meta":{"regularMarketPrice":10}}],"error":null}}"#;
        assert!(parse_quote_json(body, today()).is_err());
    }

    #[test]
    fn a_zero_or_negative_price_is_refused() {
        for bad in ["0", "0.00", "-12.5"] {
            assert!(
                parse_quote_json(&ok_json("USD", bad), today()).is_err(),
                "{bad} was accepted as a price"
            );
        }
    }

    #[test]
    fn junk_replies_are_errors_rather_than_panics() {
        // Captive portals, anti-bot interstitials and error pages are what
        // actually comes back when a network is "connected" but not really —
        // Stooq's replacement for its CSV endpoint was exactly an HTML
        // <noscript> challenge that returned HTTP 200.
        for junk in [
            "",
            "\n",
            "<html>error</html>",
            "<!DOCTYPE html><body><noscript>Enable JS</noscript></body>",
            "{}",
            r#"{"chart":{}}"#,
            r#"{"chart":{"result":[]}}"#,
        ] {
            assert!(parse_quote_json(junk, today()).is_err(), "{junk:?} parsed as a price");
        }
    }

    #[test]
    fn a_price_becomes_whole_cents() {
        assert_eq!(price_to_cents(Decimal::from_str("327.44").unwrap()).unwrap(), 32_744);
        // Half AWAY FROM ZERO, the same rule `parse_amount_cents` applies to
        // every imported amount. This assertion caught the code using
        // Decimal::round(), which is banker's rounding: 1.005 became 1.00 here
        // and 1.01 on the import path.
        assert_eq!(price_to_cents(Decimal::from_str("1.005").unwrap()).unwrap(), 101);
        assert_eq!(price_to_cents(Decimal::from_str("1.004").unwrap()).unwrap(), 100);
    }

    #[test]
    fn value_rounding_matches_the_import_path() {
        // The same midpoint, reached through quantity x price. If these two
        // ever disagree, the same holding is worth a different number of cents
        // depending on which code path last wrote it.
        let p = Decimal::from_str("0.005").unwrap();
        assert_eq!(holding_value_cents("1", p).unwrap(), 1);
        assert_eq!(
            holding_value_cents("1", p).unwrap(),
            crate::import::parse_amount_cents("0.005").unwrap()
        );
    }

    #[test]
    fn a_holding_is_worth_quantity_times_price() {
        let p = Decimal::from_str("327.44").unwrap();
        assert_eq!(holding_value_cents("25", p).unwrap(), 818_600);
    }

    #[test]
    fn fractional_shares_are_exact() {
        // 42.318 x 183.44, the real VTSAX quote — the reason quantity is a
        // decimal string and not an f64.
        let p = Decimal::from_str("183.44").unwrap();
        assert_eq!(holding_value_cents("42.318", p).unwrap(), 776_281);
    }

    #[test]
    fn a_missing_or_unreadable_quantity_is_an_error() {
        let p = Decimal::from_str("10").unwrap();
        assert!(holding_value_cents("", p).is_err());
        assert!(holding_value_cents("  ", p).is_err());
        assert!(holding_value_cents("twelve", p).is_err());
        assert!(holding_value_cents("-5", p).is_err());
    }

    #[test]
    fn a_zero_quantity_is_worth_nothing_but_is_not_an_error() {
        // A sold-out position is legitimate; it is worth 0, not broken.
        let p = Decimal::from_str("327.44").unwrap();
        assert_eq!(holding_value_cents("0", p).unwrap(), 0);
    }

    #[test]
    fn a_symbol_cannot_rewrite_the_request_url() {
        assert_eq!(quote_symbol_encoded("brk/b"), "BRK%2FB");
        assert_eq!(quote_symbol_encoded("^GSPC"), "^GSPC");
        assert_eq!(quote_symbol_encoded(" vtsax "), "VTSAX");
        assert!(quote_url("AAPL?x=1").contains("chart/AAPL%3FX%3D1?range=1d"), "{}", quote_url("AAPL?x=1"));
    }
}
