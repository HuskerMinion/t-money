// RegisterGrid — the one grid that backs the account register, the reconcile
// clearing view and, later, the split dialog. Presentational
// only: it takes rows and renders Money's column model. No store, no IPC.
//
// Column model, measured from reference/ms-money-02-account-register.png:
//
//   [flag] [!] │ Num │ Date │ Payee │ C │ Payment │ Deposit │ Balance
//
// Note what is NOT here: there is no Category column. In Money, category lives
// in the transaction form (the "Show transaction forms" toggle), not in
// the grid.
//
// Investment accounts use Money's other column model:
//
//   [flag] [!] │ Date │ Activity │ Investment │ C │ Quantity │ Price │ Total │ Cash Bal.
//
// Same grid, same reconcile and context-menu behavior; only the cells
// differ. A cash row in an investment account (a contribution, a transfer)
// prints its payee in the Investment column and its amount as the Total.
import { Fragment } from "react";
import { formatAccountingBare, formatAmountBare, formatDateUS, today } from "../lib/format";
import { activityLabel, formatPrice, formatShares } from "../lib/shares";
import { sortAscending, sortColumn } from "../lib/registerView";
import type { RegisterSort, SortColumn } from "../lib/registerView";
import type { RegisterRow } from "../lib/types";

/** A titled block of rows. `label: null` renders the rows ungrouped. */
export interface RegisterGroup {
  label: string | null;
  /** Shown inside the group's own header when it has no rows, Money-style:
   *  "Checks (No transactions this period)". */
  emptyNote?: string;
  rows: RegisterRow[];
}

interface RegisterGridProps {
  groups: RegisterGroup[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Reconcile mode: the C column becomes a clickable checkmark. */
  clearable?: boolean;
  clearedIds?: ReadonlySet<string>;
  onToggleCleared?: (id: string) => void;
  /** Money draws empty rows down to the bottom of the viewport. */
  minRows?: number;
  /** Row id currently being edited in place. */
  editingId?: string | null;
  /** Renders the in-place form in that row's stead. */
  renderEdit?: (row: RegisterRow) => React.ReactNode;
  /** Renders a blank entry form appended after the last row (the New button). */
  renderNewRow?: () => React.ReactNode;
  /** Double-click (or single click on an already-selected row) opens editing. */
  onActivate?: (id: string) => void;
  /** Right-click a row — Money offers Delete from the context menu. */
  onRowContextMenu?: (id: string, x: number, y: number) => void;
  /** Clicking an empty filler row starts a new transaction, as Money does. */
  onEmptyRowClick?: () => void;
  /** The sort in force, so its column can carry the marker. Omitted in
   *  the reconcile and split uses, where the headers are not clickable. */
  sort?: RegisterSort;
  /** A sortable header was clicked. */
  onSortColumn?: (column: SortColumn) => void;
  /** The always-open entry line under the last transaction — today's
   *  date and "Click here to enter a transaction"; clicking it is the same
   *  as New. Drawn when no new-row form is open. */
  entryRow?: boolean;
  /** Text the entry line shows in the Num column (the next check number). */
  entryNum?: string | null;
  /** The date the entry line shows (the last one entered), else today. */
  entryDate?: string | null;
  columnLabels?: { payment: string; deposit: string };
  /** The running balance only reads in date order; any other sort blanks
   *  the column rather than print a number that is a lie. */
  hideBalance?: boolean;
  /** Money's investment register columns. */
  investment?: boolean;
}

const COLUMNS = 9;
const INV_COLUMNS = 10;

export default function RegisterGrid({
  groups,
  selectedId = null,
  onSelect,
  clearable = false,
  clearedIds,
  onToggleCleared,
  minRows = 0,
  editingId = null,
  renderEdit,
  renderNewRow,
  onActivate,
  onRowContextMenu,
  onEmptyRowClick,
  entryRow = false,
  entryNum = null,
  entryDate = null,
  columnLabels = { payment: "Payment", deposit: "Deposit" },
  hideBalance = false,
  investment = false,
  sort,
  onSortColumn,
}: RegisterGridProps) {
  const dataRowCount = groups.reduce((n, g) => n + g.rows.length, 0);
  const headerRowCount = groups.filter((g) => g.label !== null).length;
  const fillerCount = Math.max(0, minRows - dataRowCount - headerRowCount);
  const columns = investment ? INV_COLUMNS : COLUMNS;

  return (
    <table className="register-table">
      {investment ? (
        <colgroup>
          <col style={{ width: 18 }} />
          <col style={{ width: 18 }} />
          <col style={{ width: 90 }} />
          <col style={{ width: 150 }} />
          <col />
          <col style={{ width: 28 }} />
          <col style={{ width: 90 }} />
          <col style={{ width: 90 }} />
          <col style={{ width: 110 }} />
          <col style={{ width: 120 }} />
        </colgroup>
      ) : (
      <colgroup>
        <col style={{ width: 18 }} />
        <col style={{ width: 18 }} />
        <col style={{ width: 90 }} />
        <col style={{ width: 90 }} />
        <col />
        <col style={{ width: 28 }} />
        <col style={{ width: 110 }} />
        <col style={{ width: 110 }} />
        <col style={{ width: 120 }} />
      </colgroup>
      )}
      <thead>
        {investment ? (
          <tr>
            <th aria-label="Flag" />
            <th aria-label="Attention" />
            <SortableTh label="Date" column="date" sort={sort} onSortColumn={onSortColumn} />
            <th>Activity</th>
            <SortableTh label="Investment" column="payee" sort={sort} onSortColumn={onSortColumn} />
            <th className="mid">C</th>
            <th className="num">Quantity</th>
            <th className="num">Price</th>
            <SortableTh label="Total" column="amount" sort={sort} onSortColumn={onSortColumn} className="num" />
            <th className="num">Cash Bal.</th>
          </tr>
        ) : (
        <tr>
          <th aria-label="Flag" />
          <th aria-label="Attention" />
          <SortableTh label="Num" column="num" sort={sort} onSortColumn={onSortColumn} />
          <SortableTh label="Date" column="date" sort={sort} onSortColumn={onSortColumn} />
          <SortableTh label="Payee" column="payee" sort={sort} onSortColumn={onSortColumn} />
          <th className="mid">C</th>
          <SortableTh label={columnLabels.payment} column="amount" sort={sort} onSortColumn={onSortColumn} className="num" />
          <SortableTh label={columnLabels.deposit} column="amount" sort={sort} onSortColumn={onSortColumn} className="num" />
          <th className="num">Balance</th>
        </tr>
        )}
      </thead>
      <tbody>
        {groups.map((group, gi) => (
          <GroupBlock
            key={group.label ?? `g${gi}`}
            group={group}
            selectedId={selectedId}
            onSelect={onSelect}
            clearable={clearable}
            clearedIds={clearedIds}
            onToggleCleared={onToggleCleared}
            editingId={editingId}
            renderEdit={renderEdit}
            onActivate={onActivate}
            onRowContextMenu={onRowContextMenu}
            hideBalance={hideBalance}
            investment={investment}
          />
        ))}
        {renderNewRow?.()}
        {entryRow && !renderNewRow && (
          <tr
            className="tm-entry-row"
            aria-label="New transaction"
            role="button"
            tabIndex={0}
            onClick={onEmptyRowClick}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onEmptyRowClick?.();
              }
            }}
            title="Click to enter a transaction here"
          >
            <td />
            <td />
            {investment ? (
              <>
                <td>{formatDateUS(entryDate ?? today())}</td>
                <td colSpan={columns - 3} className="tm-entry-hint">
                  Click here to enter a transaction
                </td>
              </>
            ) : (
              <>
                <td className="tm-entry-hint">{entryNum ?? ""}</td>
                <td>{formatDateUS(entryDate ?? today())}</td>
                <td colSpan={columns - 4} className="tm-entry-hint">
                  Click here to enter a transaction
                </td>
              </>
            )}
          </tr>
        )}
        {Array.from({ length: fillerCount }, (_, i) => (
          <tr
            key={`filler-${i}`}
            className="filler"
            // Money starts a new transaction when you click an empty row.
            onClick={onEmptyRowClick}
            style={onEmptyRowClick ? { cursor: "text" } : undefined}
          >
            {Array.from({ length: columns }, (_, c) => (
              <td key={c} />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GroupBlock({
  group,
  selectedId,
  onSelect,
  clearable,
  clearedIds,
  onToggleCleared,
  editingId,
  renderEdit,
  onActivate,
  onRowContextMenu,
  hideBalance,
  investment = false,
}: {
  group: RegisterGroup;
  selectedId: string | null;
  onSelect?: (id: string) => void;
  clearable: boolean;
  clearedIds?: ReadonlySet<string>;
  onToggleCleared?: (id: string) => void;
  editingId?: string | null;
  renderEdit?: (row: RegisterRow) => React.ReactNode;
  onActivate?: (id: string) => void;
  onRowContextMenu?: (id: string, x: number, y: number) => void;
  hideBalance?: boolean;
  investment?: boolean;
}) {
  const empty = group.rows.length === 0;
  return (
    <>
      {group.label !== null && (
        <tr className="group">
          <td colSpan={investment ? INV_COLUMNS : COLUMNS}>
            {group.label}
            {empty && group.emptyNote ? ` (${group.emptyNote})` : ""}
          </td>
        </tr>
      )}
      {group.rows.map((r) =>
        r.id === editingId && renderEdit ? (
          <Fragment key={r.id}>{renderEdit(r)}</Fragment>
        ) : (
        <Row
          key={r.id}
          row={r}
          selected={r.id === selectedId}
          onSelect={onSelect}
          clearable={clearable}
          cleared={clearedIds?.has(r.id) ?? r.cleared_state !== ""}
          onToggleCleared={onToggleCleared}
          onActivate={onActivate}
          onRowContextMenu={onRowContextMenu}
          hideBalance={hideBalance}
          investment={investment}
        />
        )
      )}
    </>
  );
}

function Row({
  row,
  selected,
  onSelect,
  clearable,
  cleared,
  onToggleCleared,
  onActivate,
  onRowContextMenu,
  hideBalance = false,
  investment = false,
}: {
  row: RegisterRow;
  selected: boolean;
  onSelect?: (id: string) => void;
  clearable: boolean;
  cleared: boolean;
  onToggleCleared?: (id: string) => void;
  onActivate?: (id: string) => void;
  onRowContextMenu?: (id: string, x: number, y: number) => void;
  hideBalance?: boolean;
  investment?: boolean;
}) {
  // Money splits one signed amount across two columns. The backend keeps the
  // sign (amount_cents); the split is purely presentational.
  const isPayment = row.amount_cents < 0;
  const isDeposit = row.amount_cents > 0;

  const cCell = (
    <td className="mid">
      {clearable && row.cleared_state !== "R" ? (
        // In reconcile mode a cleared row renders as a CHECKMARK. It is the
        // same stored "C" — the tick is a view, not a third state — so
        // leaving reconcile shows it as "C" again.
        <button
          type="button"
          aria-label={`${cleared ? "Unclear" : "Clear"} ${row.payee}`}
          aria-pressed={cleared}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCleared?.(row.id);
          }}
          style={{ border: "none", background: "none", cursor: "pointer", padding: 0 }}
        >
          {cleared ? "✓" : ""}
        </button>
      ) : (
        // Normal register: blank / C (cleared) / R (reconciled).
        <span>{row.cleared_state}</span>
      )}
    </td>
  );

  return (
    <tr
      data-row-id={row.id}
      className={[selected ? "active" : "", row.is_void ? "voided" : ""]
        .filter(Boolean)
        .join(" ") || undefined}
      aria-selected={selected}
      onClick={() => {
        // Clicking a row that is already selected opens it, so a second click
        // edits without needing the toolbar — Money behaves this way too.
        if (selected) onActivate?.(row.id);
        else onSelect?.(row.id);
      }}
      onDoubleClick={() => onActivate?.(row.id)}
      onContextMenu={(e) => {
        if (!onRowContextMenu) return;
        e.preventDefault();
        onSelect?.(row.id);
        onRowContextMenu(row.id, e.clientX, e.clientY);
      }}
      title={row.notes ?? undefined}
    >
      {investment ? (
        <InvestmentCells row={row} hideBalance={hideBalance} cCell={cCell} />
      ) : (
        <>
          <td />
          <td />
          <td>{row.check_number ?? ""}</td>
          <td>{formatDateUS(row.date)}</td>
          <td>
            {row.payee}
            {row.is_void && <span className="void-tag"> VOID</span>}
            {/* A receipt or a statement is attached — open the row to see it. */}
            {(row.attachment_count ?? 0) > 0 && (
              <span className="tm-goal-tag" title={`${row.attachment_count} attached file${row.attachment_count === 1 ? "" : "s"} — open the transaction and click Attachments`}>
                {" "}📎 {row.attachment_count}
              </span>
            )}
            {/* The category (or the transfer's other account) and the
                memo ride along in the Payee cell, muted, so what a row was
                for is readable without opening it — Money's two-line view,
                on one line. */}
            {(() => {
              const where = row.transfer_account_name ? `Transfer : ${row.transfer_account_name}` : row.category_name;
              const bits = [where, row.notes].filter((x): x is string => !!x && x.trim() !== "");
              return bits.length > 0 ? <span className="tm-row-sub"> — {bits.join(" · ")}</span> : null;
            })()}
            {/* What the row was FOR. A file with no classifications
                never shows this, and a row with none shows nothing. */}
            {(row.classes ?? []).filter((c) => c.label).map((c) => (
              <span key={c.classification_id} className="tm-goal-tag" title={`Classified as "${c.label}"`}>
                {" "}◆ {c.label}
              </span>
            ))}
            {/* And what its SPLIT LINES say, when the transaction
                itself says nothing. A mortgage split into principal, interest
                and escrow with every line tagged to a house used to show
                nothing here at all, which reads as tagging that did not
                stick. Marked ◇ rather than ◆: it is the lines' answer, not
                the transaction's. */}
            {(row.line_classes ?? []).filter((c) => c.label).map((c) => (
              <span
                key={`line-${c.classification_id}`}
                className="tm-goal-tag"
                title={
                  c.value_id
                    ? `Every split line is classified as "${c.label}" — open Split to change it`
                    : `The split lines carry ${c.label} — open Split to see them`
                }
              >
                {" "}◇ {c.label}
              </span>
            ))}
            {row.goal_name && (
              <span className="tm-goal-tag" title={`Counts toward the goal "${row.goal_name}"`}>
                {" "}⚑ {row.goal_name}
              </span>
            )}
            {row.tax_line != null && (
              <span className="tm-goal-tag" title={row.tax_line === "" ? "Left out of the tax reports" : `On the tax line "${row.tax_line}" instead of its category's`}>
                {" "}{row.tax_line === "" ? "§ not tax-related" : `§ ${row.tax_line}`}
              </span>
            )}
          </td>
          {cCell}
          <td className="num">{isPayment ? formatAmountBare(row.amount_cents) : ""}</td>
          <td className="num">{isDeposit ? formatAmountBare(row.amount_cents) : ""}</td>
          <td className={`balance${!hideBalance && row.running_balance_cents < 0 ? " money-neg" : ""}`}>
            {hideBalance ? "" : formatAccountingBare(row.running_balance_cents)}
          </td>
        </>
      )}
    </tr>
  );
}

/** The investment register's cells. Reinvested income shows the amount
 *  reinvested as the Total, since its cash effect is zero by design. */
function InvestmentCells({ row, hideBalance, cCell }: { row: RegisterRow; hideBalance: boolean; cCell: React.ReactNode }) {
  const isCash = row.activity === null;
  // A share transfer is a Remove/Add Shares pair linked like a money
  // transfer; the register says where the shares went, as Money does.
  // An exchange WITHIN the account (a TSP reallocation) is linked the
  // same way but to a row in this account; it reads as an exchange of one
  // fund for another, not as shares leaving for somewhere else.
  const exchange = !isCash && row.is_exchange === true;
  const shareTransfer = !isCash && !exchange && row.transfer_account_name !== null;
  const activity = isCash
    ? row.transfer_account_name
      ? "Transfer"
      : row.amount_cents >= 0
        ? "Deposit"
        : "Withdrawal"
    : exchange
      ? row.activity === "add_shares"
        ? "Exchange (in)"
        : "Exchange (out)"
      : shareTransfer
        ? row.activity === "add_shares"
          ? "Transfer Shares (in)"
          : "Transfer Shares (out)"
        : activityLabel(row.activity);
  const investment = isCash
    ? row.transfer_account_name
      ? `${row.payee} : ${row.transfer_account_name}`
      : row.payee
    : shareTransfer
      ? `${row.security_name ?? row.payee} : ${row.transfer_account_name}`
      : row.security_name ?? row.payee;
  const quantity =
    row.activity === "split"
      ? `${formatShares(row.shares_micro ?? 0)} for 1`
      : row.shares_micro !== null && row.shares_micro !== 0
        ? formatShares(row.shares_micro)
        : "";
  const reinvested = (row.activity ?? "").startsWith("reinvest_");
  const total = reinvested ? (row.gross_cents ?? 0) : row.amount_cents;
  return (
    <>
      <td />
      <td />
      <td>{formatDateUS(row.date)}</td>
      <td>{activity}</td>
      <td>
        {investment}
        {row.is_void && <span className="void-tag"> VOID</span>}
        {(row.attachment_count ?? 0) > 0 && (
          <span className="tm-goal-tag" title={`${row.attachment_count} attached file${row.attachment_count === 1 ? "" : "s"}`}>
            {" "}📎 {row.attachment_count}
          </span>
        )}
      </td>
      {cCell}
      <td className="num">{quantity}</td>
      <td className="num">{row.activity === "split" ? "" : formatPrice(row.price_micro)}</td>
      <td className="num" title={reinvested ? "Reinvested — no cash moved" : row.commission_cents ? `Includes ${formatAmountBare(row.commission_cents)} commission` : undefined}>
        {total === 0 && !reinvested ? "" : formatAccountingBare(total)}
      </td>
      <td className={`balance${!hideBalance && row.running_balance_cents < 0 ? " money-neg" : ""}`}>
        {hideBalance ? "" : formatAccountingBare(row.running_balance_cents)}
      </td>
    </>
  );
}

/**
 * A column header that sorts when clicked.
 *
 * Without `onSortColumn` — the reconcile and split uses of this grid — it is
 * a plain `<th>`, because sorting a clearing list would be meaningless and a
 * header that looks clickable and is not is worse than a plain one.
 */
function SortableTh({
  label,
  column,
  sort,
  onSortColumn,
  className,
}: {
  label: string;
  column: SortColumn;
  sort?: RegisterSort;
  onSortColumn?: (column: SortColumn) => void;
  className?: string;
}) {
  if (!onSortColumn) return <th className={className}>{label}</th>;
  const active = sort !== undefined && sortColumn(sort) === column;
  const asc = sort !== undefined && sortAscending(sort);
  return (
    <th className={className} aria-sort={active ? (asc ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className="tm-sort-th"
        onClick={() => onSortColumn(column)}
        title={active ? `Sorted by ${label} — click to reverse` : `Sort by ${label}`}
      >
        <span>{label}</span>
        <span className="tm-sort-mark" aria-hidden="true">
          {active ? (asc ? "\u25B2" : "\u25BC") : ""}
        </span>
      </button>
    </th>
  );
}
