// "Change account details" — the institution and contact record for one
// account (migration 0010).
//
// Balance is deliberately absent: it is derived from transactions, and letting
// it be typed here would silently desync the register.
//
// account_number and routing_number are masked by default. The file is
// SQLCipher-encrypted so they are safe at rest, but they should not sit on
// screen in full while somebody is sharing a window.
import { useEffect, useState } from "react";
import { labelFor, ACCOUNT_TYPES } from "../lib/accountTypes";
import { formatAmountBare, formatDate, formatMoney, parseMoneyToCents } from "../lib/format";
import { api } from "../lib/ipc";
import { CURRENCY_SYMBOLS, currencyOf, homeCurrency, homeName } from "../lib/currency";
import Notice from "./Notice";
import DateField from "./DateField";
import type { Account, AccountDetails, AccountType, Currency, HoldingRounding } from "../lib/types";
import { isDebt, isValuedAsset } from "../lib/accountTypes";
import AttachmentsPanel from "./AttachmentsPanel";

interface Props {
  /** The assets a debt can be secured on. Omit to hide the field. */
  assets?: readonly Account[];
  account: Account;
  /** Writes the details. It must NOT close the dialog: the rounding
   *  and "Secured by" writes come after it (the second depends on the type it
   *  just saved), and a refusal from either has to land on an open dialog. */
  onSave: (details: AccountDetails) => Promise<void>;
  /** Every write went through — reload and close. */
  onSaved?: () => void | Promise<void>;
  onCancel: () => void;
}

/** Show the last four digits only: 1234567890 -> ••••••7890 */
export function maskNumber(value: string): string {
  if (value.length <= 4) return value;
  return "•".repeat(value.length - 4) + value.slice(-4);
}

const CREDIT_TYPES: AccountType[] = ["credit", "line_of_credit", "home_equity_line_of_credit"];
const HOLDING_TYPES: AccountType[] = ["investment", "retirement"];
/** Kept in the home currency by the backend: share prices are in it. */
const HOME_ONLY: AccountType[] = ["investment", "retirement", "employee_stock_option", "watch"];

export default function AccountDetailsDialog({ account, assets = [], onSave, onSaved, onCancel }: Props) {
  const [name, setName] = useState(account.name);
  const [type, setType] = useState<AccountType>(account.type);
  const [isClosed, setIsClosed] = useState(account.is_closed);
  const [institution, setInstitution] = useState(account.institution ?? "");
  const [accountNumber, setAccountNumber] = useState(account.account_number ?? "");
  const [routingNumber, setRoutingNumber] = useState(account.routing_number ?? "");
  const [openedOn, setOpenedOn] = useState(account.opened_on ?? "");
  // Opened-on may be blank, so "" cannot tell a cleared date from one
  // DateField could not read; it reports the second.
  const [openedOnBad, setOpenedOnBad] = useState(false);
  const [creditLimit, setCreditLimit] = useState(
    account.credit_limit_cents === null
      ? ""
      : formatMoney(account.credit_limit_cents, { parens: false, currency: currencyOf(account) })
  );
  // The currency the account is kept in. Changing it relabels; nothing is
  // converted.
  const [currency, setCurrency] = useState(currencyOf(account));
  const home = homeCurrency();
  // Names for the select. Without the list the codes alone still work.
  const [currencies, setCurrencies] = useState<Pick<Currency, "code" | "name">[]>(() =>
    Object.keys(CURRENCY_SYMBOLS).map((code) => ({ code, name: "" }))
  );
  useEffect(() => {
    api.listCurrencies().then(
      (list) => {
        if (list.length) setCurrencies(list);
      },
      () => {}
    );
  }, []);
  const [phone, setPhone] = useState(account.contact_phone ?? "");
  const [email, setEmail] = useState(account.contact_email ?? "");
  const [website, setWebsite] = useState(account.website ?? "");
  const [address, setAddress] = useState(account.address ?? "");
  const [accountNotes, setAccountNotes] = useState(account.account_notes ?? "");
  // How this account's holdings round to the cent; "" follows the file.
  const [rounding, setRounding] = useState<"" | HoldingRounding>(account.value_rounding ?? "");
  // The asset this debt is borrowed against.
  const [securedBy, setSecuredBy] = useState(account.secured_by_account_id ?? "");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blank = (v: string) => (v.trim() === "" ? null : v.trim());

  async function save() {
    if (!name.trim()) {
      setError("Enter a name for the account.");
      return;
    }
    // A typo in the credit limit used to parse to null and silently CLEAR
    // the stored limit.
    const limit = creditLimit.trim() === "" ? null : parseMoneyToCents(creditLimit);
    if (creditLimit.trim() !== "" && limit === null) {
      setError(`"${creditLimit}" is not an amount.`);
      return;
    }
    if (openedOnBad) {
      setError(`Type an opened-on date the form can read, such as ${formatDate("2026-08-03")}, or leave it blank.`);
      return;
    }
    // The backend refuses this pair either way round; say so before writing
    // anything.
    if (HOME_ONLY.includes(type) && currency !== home) {
      setError(`${labelFor(type)} accounts are kept in ${homeName()}. Set the currency to ${home}.`);
      return;
    }
    const currencyChanged = currencyOf(account) !== currency;
    setBusy(true);
    setError(null);
    try {
      // Back to the home currency goes first: the details save refuses an
      // investment type while the stored currency is still foreign.
      if (currencyChanged && currency === home) {
        await api.setAccountCurrency(account.id, currency);
      }
      await onSave({
        id: account.id,
        name: name.trim(),
        account_type: type,
        is_closed: isClosed,
        institution: blank(institution),
        account_number: blank(accountNumber),
        routing_number: blank(routingNumber),
        opened_on: blank(openedOn),
        credit_limit_cents: limit,
        contact_phone: blank(phone),
        contact_email: blank(email),
        website: blank(website),
        address: blank(address),
        account_notes: blank(accountNotes),
      });
      if ((account.value_rounding ?? "") !== rounding) {
        await api.setAccountValueRounding(account.id, rounding === "" ? null : rounding);
      }
      if ((account.secured_by_account_id ?? "") !== securedBy) {
        await api.setAccountSecurity(account.id, securedBy === "" ? null : securedBy);
      }
      // Any other change after the details: the type it checks against is the
      // one just saved. A refusal (transfers to an account in another
      // currency, no rate yet) lands here, on the open dialog.
      if (currencyChanged && currency !== home) {
        await api.setAccountCurrency(account.id, currency);
      }
      // Only now. The shell used to reload and close inside `onSave`,
      // so these two writes ran against a dialog that was already gone, and
      // a refused "Secured by" was an error nobody would ever see.
      await onSaved?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const row = (label: string, node: React.ReactNode) => (
    <label className="flex items-start gap-2 py-0.5">
      <span className="text-right shrink-0" style={{ width: 130 }}>
        {label}
      </span>
      {node}
    </label>
  );

  return (
    <div className="tm-dialog" role="dialog" aria-label="Change account details">
      <div className="tm-dialog-title">Change account details — {account.name}</div>
      <div className="tm-dialog-body" style={{ maxHeight: "70vh", overflowY: "auto" }}>
        <div className="font-bold pb-1" style={{ color: "var(--tm-ms-text-cardhdr)" }}>
          Account
        </div>
        {row(
          "Name:",
          <input className="aero-field flex-1" value={name} onChange={(e) => setName(e.target.value)} />
        )}
        {row(
          "Type:",
          <select
            className="aero-field flex-1"
            value={type}
            onChange={(e) => {
              const t = e.target.value as AccountType;
              setType(t);
              // Investment types are kept in the home currency.
              if (HOME_ONLY.includes(t)) setCurrency(home);
            }}
          >
            {ACCOUNT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        )}
        {row(
          "Currency:",
          <select
            className="aero-field flex-1"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            disabled={HOME_ONLY.includes(type) && currency === home}
            title={HOME_ONLY.includes(type) ? `Investment accounts are kept in ${homeName()}.` : undefined}
          >
            {currencies.some((c) => c.code === currency) ? null : <option value={currency}>{currency}</option>}
            {currencies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name ? `${c.code} — ${c.name}` : c.code}
              </option>
            ))}
          </select>
        )}
        {currency !== currencyOf(account) && (
          <div className="pl-[138px] pb-1" style={{ color: "var(--tm-ms-text-muted)" }}>
            Amounts are not converted: {formatMoney(account.balance_cents, { currency: currencyOf(account) })} becomes{" "}
            {formatMoney(account.balance_cents, { currency })}. Use this to fix an account set up in the wrong
            currency.
          </div>
        )}
        {HOLDING_TYPES.includes(type) &&
          row(
            "Holding values:",
            <select
              className="aero-field flex-1"
              aria-label="Holding value rounding"
              value={rounding}
              onChange={(e) => setRounding(e.target.value as "" | HoldingRounding)}
              title="How shares × price is rounded to the cent for this account. Brokers differ: some round down."
            >
              <option value="">As set for the file (Settings → Holding values)</option>
              <option value="nearest">Round to the nearest cent</option>
              <option value="down">Round down (truncate)</option>
            </select>
          )}
        {isDebt(type) &&
          assets.some((a) => isValuedAsset(a.type)) &&
          row(
            "Secured by:",
            <select
              className="aero-field flex-1"
              aria-label="Secured by"
              value={securedBy}
              onChange={(e) => setSecuredBy(e.target.value)}
              title="The asset this debt is borrowed against. The account list then shows that asset's equity."
            >
              <option value="">Nothing — an unsecured debt</option>
              {assets
                .filter((a) => isValuedAsset(a.type) && a.id !== account.id)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          )}
        {row(
          "Opened on:",
          <DateField label="Opened on" value={openedOn} onChange={setOpenedOn} onInvalid={setOpenedOnBad} optional width={130} />
        )}
        {CREDIT_TYPES.includes(type) &&
          row(
            "Credit limit:",
            <input
              className="aero-field"
              value={creditLimit}
              onChange={(e) => setCreditLimit(e.target.value)}
              placeholder={formatAmountBare(0)}
            />
          )}
        {row(
          "Status:",
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label="Account is closed"
              checked={isClosed}
              onChange={(e) => setIsClosed(e.target.checked)}
            />
            Account is closed
          </span>
        )}
        <div className="pl-[138px] pb-2" style={{ color: "var(--tm-ms-text-muted)" }}>
          Balance is {formatMoney(account.balance_cents, { currency: currencyOf(account) })} — derived from the register, not edited here.
        </div>

        <div className="font-bold pb-1 pt-1" style={{ color: "var(--tm-ms-text-cardhdr)" }}>
          Institution
        </div>
        {row(
          "Institution:",
          <input
            className="aero-field flex-1"
            value={institution}
            onChange={(e) => setInstitution(e.target.value)}
            placeholder="e.g. First National"
          />
        )}
        {row(
          "Account number:",
          <span className="flex-1 flex items-center gap-2">
            <input
              className="aero-field flex-1"
              type={reveal ? "text" : "password"}
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
            />
            <button
              type="button"
              className="aero-btn"
              onClick={() => setReveal((r) => !r)}
              aria-pressed={reveal}
            >
              {reveal ? "Hide" : "Show"}
            </button>
          </span>
        )}
        {row(
          "Routing number:",
          <input
            className="aero-field flex-1"
            type={reveal ? "text" : "password"}
            value={routingNumber}
            onChange={(e) => setRoutingNumber(e.target.value)}
          />
        )}

        <div className="font-bold pb-1 pt-1" style={{ color: "var(--tm-ms-text-cardhdr)" }}>
          Contact
        </div>
        {row(
          "Phone:",
          <input className="aero-field flex-1" value={phone} onChange={(e) => setPhone(e.target.value)} />
        )}
        {row(
          "E-mail:",
          <input
            className="aero-field flex-1"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
        {row(
          "Website:",
          <input
            className="aero-field flex-1"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://"
          />
        )}
        {row(
          "Address:",
          <textarea
            className="aero-field flex-1"
            rows={2}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        )}
        {row(
          "Notes:",
          <textarea
            className="aero-field flex-1"
            rows={2}
            value={accountNotes}
            onChange={(e) => setAccountNotes(e.target.value)}
          />
        )}

        {/* Statements and the like, on the account itself. Written
            as it happens, not on OK: attaching a file is not a field. */}
        <div className="font-bold pb-1 pt-3" style={{ color: "var(--tm-ms-text-cardhdr)" }}>
          Attachments
        </div>
        <AttachmentsPanel accountId={account.id} />

        {/* The shared refusal box, as every other refusal on the Account List. */}
        {error && (
          <Notice tone="error" boxed>
            {error}
          </Notice>
        )}

        <div className="flex justify-end gap-2 pt-3">
          <button className="aero-btn default" type="button" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "OK"}
          </button>
          <button className="aero-btn" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Convenience for read-only displays elsewhere. */
export function accountSubtitle(a: Account): string {
  const bits: string[] = [labelFor(a.type)];
  if (a.institution) bits.push(a.institution);
  if (a.account_number) bits.push(maskNumber(a.account_number));
  return bits.join(" · ");
}
