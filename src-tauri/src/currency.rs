//! The currencies an account can be kept in, and the file's home currency.
//!
//! Every file has a home currency — US dollars unless the user chose another
//! — and every report, budget and total is in it. An account kept in another
//! currency is converted at the exchange rate in force on the day
//! (`db::queries::fx`). Amounts are stored as integer minor units ("cents")
//! of the ACCOUNT's own currency.
//!
//! Every currency here has two decimal places, which is what lets the rest of
//! the app keep treating an amount as hundredths. `decimals` is recorded so
//! that a currency without them (the yen) can be added later on purpose,
//! rather than slipping in and being read as hundredths.

use serde::Serialize;

/// The home currency of a file that has never chosen one.
pub const DEFAULT_HOME: &str = "USD";

/// The app setting that holds the file's home currency.
pub const HOME_KEY: &str = "file.home_currency";

/// The file's home currency as an SQL expression. Uncorrelated, so SQLite
/// works it out once per statement however many rows use it. A macro, not a
/// const, so it can be spliced into `concat!`. A stored value that is not on
/// the list reads as dollars, as `home_currency` reads it in Rust — the two
/// must never disagree. Keep the list in step with `CURRENCIES` (a test
/// checks).
#[macro_export]
macro_rules! home_sql {
    () => {
        "(SELECT COALESCE((SELECT value FROM app_settings WHERE key = 'file.home_currency' AND value IN ('USD', 'CAD', 'EUR', 'GBP', 'MXN', 'AUD')), 'USD'))"
    };
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct Currency {
    /// ISO 4217 code.
    pub code: &'static str,
    pub name: &'static str,
    /// The symbol that cannot be mistaken for another currency's: "CA$",
    /// "US$". Used wherever the currency is not the region's own.
    pub symbol: &'static str,
    /// The symbol people use at home: "$" for the Canadian dollar in Canada.
    /// Used only where the region's own currency is this one.
    pub local_symbol: &'static str,
    pub decimals: u32,
}

pub const CURRENCIES: &[Currency] = &[
    Currency { code: "USD", name: "US dollar", symbol: "US$", local_symbol: "$", decimals: 2 },
    Currency { code: "CAD", name: "Canadian dollar", symbol: "CA$", local_symbol: "$", decimals: 2 },
    Currency { code: "EUR", name: "Euro", symbol: "€", local_symbol: "€", decimals: 2 },
    Currency { code: "GBP", name: "British pound", symbol: "£", local_symbol: "£", decimals: 2 },
    Currency { code: "MXN", name: "Mexican peso", symbol: "MX$", local_symbol: "$", decimals: 2 },
    Currency { code: "AUD", name: "Australian dollar", symbol: "A$", local_symbol: "$", decimals: 2 },
];

pub fn find(code: &str) -> Option<&'static Currency> {
    CURRENCIES.iter().find(|c| c.code == code)
}

/// The code, checked against the list. Anything stored in `accounts.currency`,
/// `exchange_rates` or the home-currency setting has been through this, which
/// is also what makes the code safe to compare against in SQL.
pub fn validate(code: &str) -> Result<&'static str, String> {
    let code = code.trim().to_ascii_uppercase();
    find(&code)
        .map(|c| c.code)
        .ok_or_else(|| format!("{code} is not a currency this app supports"))
}

/// Account types that may be kept in a currency other than the home one.
/// Investment accounts stay in the home currency: share prices are fetched
/// and stored in it, and a holding valued in one currency inside an account
/// kept in another would be silently wrong.
pub fn type_allows_foreign(account_type: &str) -> bool {
    !matches!(account_type, "investment" | "retirement" | "employee_stock_option" | "watch")
}

/// The quote-source symbol for "`home` per one unit of `code`".
pub fn rate_symbol(code: &str, home: &str) -> String {
    format!("{code}{home}=X")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_is_all_two_decimal_and_starts_with_the_default_home() {
        assert_eq!(CURRENCIES[0].code, DEFAULT_HOME);
        assert!(CURRENCIES.iter().all(|c| c.decimals == 2));
        let mut codes: Vec<_> = CURRENCIES.iter().map(|c| c.code).collect();
        codes.sort();
        codes.dedup();
        assert_eq!(codes.len(), CURRENCIES.len(), "no code twice");
        // The unambiguous symbols are all different.
        let mut syms: Vec<_> = CURRENCIES.iter().map(|c| c.symbol).collect();
        syms.sort();
        syms.dedup();
        assert_eq!(syms.len(), CURRENCIES.len());
    }

    #[test]
    fn validate_accepts_known_codes_in_any_case_and_refuses_the_rest() {
        assert_eq!(validate("eur").unwrap(), "EUR");
        assert_eq!(validate(" CAD ").unwrap(), "CAD");
        assert!(validate("JPY").is_err());
        assert!(validate("").is_err());
        assert!(validate("USD'; DROP TABLE accounts; --").is_err());
    }

    #[test]
    fn investment_accounts_stay_in_the_home_currency() {
        for t in ["investment", "retirement", "employee_stock_option", "watch"] {
            assert!(!type_allows_foreign(t), "{t}");
        }
        for t in ["checking", "savings", "credit", "cash", "loan", "mortgage", "home", "asset"] {
            assert!(type_allows_foreign(t), "{t}");
        }
    }

    #[test]
    fn the_sql_list_of_home_currencies_is_the_list() {
        let sql = crate::home_sql!();
        for c in CURRENCIES {
            assert!(sql.contains(&format!("'{}'", c.code)), "{} missing from home_sql!", c.code);
        }
        assert_eq!(sql.matches("', '").count() + 1, CURRENCIES.len(), "home_sql! names a code the list does not");
    }

    #[test]
    fn rate_symbols_are_quoted_in_the_home_currency() {
        assert_eq!(rate_symbol("EUR", "USD"), "EURUSD=X");
        assert_eq!(rate_symbol("GBP", "EUR"), "GBPEUR=X");
    }
}
