// Thin, typed wrappers around Tauri's invoke() for every backend command.
// This is the single place the frontend talks to Rust — no fetch(), no Next.js
// API routes.
//
// ARG NAMES: every Rust command is declared with
// `#[tauri::command(rename_all = "camelCase")]`, so the JS invoke keys below
// use camelCase and Tauri maps them to the snake_case Rust params. (The
// serialized *model fields* are snake_case and pass through verbatim — see
// types.ts.)

import { invoke } from "@tauri-apps/api/core";
import type { Region } from "./region";
import type {
  Account,
  Attachment,
  AssetDebts,
  LoanPeriod,
  LoanTerms,
  BackupConfig,
  CsvMapping,
  CsvPreview,
  ImportMatchPreview,
  MemoRule,
  RowDecision,
  DuplicateGroup,
  FileCheck,
  PayeeRule,
  HoldingRounding,
  AccountDetails,
  AccountType,
  Budget,
  Category,
  CategoryBudget,
  CashForecast,
  CommonTransaction,
  CategoryKind,
  DbInfo,
  Goal,
  AutobudgetLine,
  BudgetGrid,
  BudgetWrite,
  YearPlan,
  PlanSpread,
  PlanWrite,
  PlanProposal,
  PlanPick,
  HoldingChange,
  ImportSummary,
  MergePreview,
  MergeSummary,
  Performance,
  RuleConditions,
  RoiPeriod,
  StatementHolding,
  ClearedState,
  Disposal,
  Lot,
  LotAllocation,
  NewInvestmentTransaction,
  Portfolio,
  Security,
  SecurityKind,
  SecurityPrice,
  KeyStatus,
  NewCommonTransaction,
  NewRecurrence,
  NewSplit,
  NewTransaction,
  RegisterRow,
  Payee,
  UsedText,
  PriceRefreshSummary,
  PriceStatus,
  Currency,
  ExchangeRate,
  FileFormat,
  ClassPick,
  Classification,
  ClassificationValue,
  Occurrence,
  Recurrence,
  SeedSummary,
  Split,
  Statement,
  Transaction,
  UpdateTransaction,
  SearchHit,
  Report,
  ReportGalleryEntry,
  ReportRequest,
  SavedReport,
  OpenFile,
  RecentFile,
  UndoStatus,
  TspPlan,
  PayeeRuleChange,
  TspPaymentSplit,
} from "./types";

export const api = {
  // Accounts
  getFavoriteAccounts: () => invoke<Account[]>("get_favorite_accounts"),
  getAllAccounts: () => invoke<Account[]>("get_all_accounts"),
  /** `openedOn` (YYYY-MM-DD) dates the Opening Balance row; omitted = today. */
  /** `currency` (ISO code) is the one the account is kept in; omitted = dollars. */
  createAccount: (
    name: string,
    type: AccountType,
    openingBalanceCents: number,
    openedOn?: string,
    currency?: string
  ) =>
    invoke<Account>("create_account", {
      name,
      accountType: type,
      openingBalanceCents,
      openedOn: openedOn ?? null,
      currency: currency ?? null,
    }),
  /** Relabel the currency an account is kept in; amounts are not converted. */
  setAccountCurrency: (id: string, currency: string) =>
    invoke<Account>("set_account_currency", { id, currency }),

  // Currencies and exchange rates. A rate is home-currency units per unit.
  listCurrencies: () => invoke<Currency[]>("list_currencies"),
  /** The regions a file can write its numbers and dates for. */
  listRegions: () => invoke<Region[]>("list_regions"),
  /** The open file's home currency and region. */
  getFileFormat: () => invoke<FileFormat>("get_file_format"),
  setRegion: (region: string) => invoke<FileFormat>("set_region", { region }),
  /** `relabel`: the accounts in the old home currency were really in the new
   *  one, so they are relabeled, amounts untouched. */
  setHomeCurrency: (currency: string, relabel: boolean) =>
    invoke<FileFormat>("set_home_currency", { currency, relabel }),
  listExchangeRates: () => invoke<ExchangeRate[]>("list_exchange_rates"),
  /** `rate` is typed text ("1.0875"), read as a decimal by the backend. */
  setExchangeRate: (currency: string, date: string, rate: string) =>
    invoke<void>("set_exchange_rate", { currency, date, rate }),
  deleteExchangeRate: (currency: string, date: string) =>
    invoke<void>("delete_exchange_rate", { currency, date }),
  /** Fetch today's rates over the network — only when the user asks. No
   *  currencies named = every currency an account is kept in. */
  fetchExchangeRates: (currencies: string[] | null = null) =>
    invoke<PriceRefreshSummary>("fetch_exchange_rates", { currencies }),
  deleteAccount: (id: string) => invoke<void>("delete_account", { id }),
  /** Merge `fromId` into `intoId`. `dryRun` reports without changing. */
  mergeAccounts: (intoId: string, fromId: string, afterLast: boolean, dryRun: boolean) =>
    invoke<MergeSummary>("merge_accounts", { intoId, fromId, afterLast, dryRun }),
  getAccount: (id: string) => invoke<Account>("get_account", { id }),
  /** Money's "Change account details". Balance is never edited here. */
  updateAccount: (details: AccountDetails) =>
    invoke<Account>("update_account", {
      id: details.id,
      name: details.name,
      accountType: details.account_type,
      isClosed: details.is_closed,
      institution: details.institution,
      accountNumber: details.account_number,
      routingNumber: details.routing_number,
      openedOn: details.opened_on,
      creditLimitCents: details.credit_limit_cents,
      contactPhone: details.contact_phone,
      contactEmail: details.contact_email,
      website: details.website,
      address: details.address,
      accountNotes: details.account_notes,
    }),
  setFavorite: (accountId: string, isFavorite: boolean) =>
    invoke<void>("set_favorite", { accountId, isFavorite }),

  // Transactions
  getTransactions: (accountId: string, limit?: number) =>
    invoke<Transaction[]>("get_transactions", { accountId, limit }),
  createTransaction: (payload: NewTransaction) =>
    invoke<Transaction>("create_transaction", { payload }),
  updateTransaction: (payload: UpdateTransaction) =>
    invoke<Transaction>("update_transaction", { payload }),
  deleteTransaction: (id: string) => invoke<void>("delete_transaction", { id }),
  /** Development only. A release build refuses this — the seeding code is
   *  not compiled into it. See `db::demo`. */
  seedDemoData: () => invoke<SeedSummary>("seed_demo_data", {}),
  /** The only call in the app that reaches the internet, and only when the
   *  user asks. Sends ticker symbols and nothing else. */
  refreshInvestmentPrices: (auto = false) =>
    invoke<PriceRefreshSummary>("refresh_investment_prices", { auto }),
  /** How old the prices are, and what the timer is set to. */
  priceStatus: () => invoke<PriceStatus>("price_status"),

  // Scheduled bills and income. These replaced the payment wrappers:
  // migration 0019 folded one-off payments into rules.
  listRecurrences: () => invoke<Recurrence[]>("list_recurrences", {}),
  createRecurrence: (payload: NewRecurrence) =>
    invoke<Recurrence>("create_recurrence", { payload }),
  updateRecurrence: (id: string, payload: NewRecurrence) =>
    invoke<Recurrence>("update_recurrence", { id, payload }),
  deleteRecurrence: (id: string) => invoke<void>("delete_recurrence", { id }),
  setRecurrenceActive: (id: string, active: boolean) =>
    invoke<void>("set_recurrence_active", { id, active }),
  getUpcoming: (days: number) => invoke<Occurrence[]>("get_upcoming", { days }),
  /** Occurrences between two ISO dates, for the bill calendar. */
  getOccurrences: (from: string, to: string) => invoke<Occurrence[]>("get_occurrences", { from, to }),
  enterOccurrence: (
    recurrenceId: string,
    dueDate: string,
    date: string,
    amountCents: number | null,
    accountId: string | null
  ) =>
    invoke<Transaction>("enter_occurrence", {
      recurrenceId,
      dueDate,
      date,
      amountCents,
      accountId,
    }),
  skipOccurrence: (recurrenceId: string, dueDate: string) =>
    invoke<void>("skip_occurrence", { recurrenceId, dueDate }),
  clearOccurrence: (recurrenceId: string, dueDate: string) =>
    invoke<void>("clear_occurrence", { recurrenceId, dueDate }),
  /** `includeDetected` also projects the recurring charges the
   *  detector has noticed in the account; the Bills tab has the switch. */
  getCashForecast: (accountId: string, days: number, includeDetected = true) =>
    invoke<CashForecast>("get_cash_forecast", { accountId, days, includeDetected }),

  // Common Transactions — saved entry-form templates.
  listCommonTransactions: () =>
    invoke<CommonTransaction[]>("list_common_transactions", {}),
  createCommonTransaction: (payload: NewCommonTransaction) =>
    invoke<CommonTransaction>("create_common_transaction", { payload }),
  touchCommonTransaction: (id: string) =>
    invoke<void>("touch_common_transaction", { id }),
  deleteCommonTransaction: (id: string) =>
    invoke<void>("delete_common_transaction", { id }),
  /** Void keeps the row and removes the money — the fraud-reversal case. */
  setVoid: (id: string, isVoid: boolean) => invoke<void>("set_void", { id, isVoid }),

  // Register (MS Money-style, with running balance)
  getRegister: (accountId: string) =>
    invoke<RegisterRow[]>("get_register", { accountId }),

  // Payees
  listPayees: () => invoke<Payee[]>("list_payees"),
  /** Descriptions split lines have carried, most-used first. */
  listSplitDescriptions: () => invoke<UsedText[]>("list_split_descriptions"),

  // Search
  searchTransactions: (query: string, accountId: string | null = null, limit = 200) =>
    invoke<SearchHit[]>("search_transactions", { query, accountId, limit }),
  /** Add a payee by hand. Refuses a name that already exists. */
  createPayee: (name: string, lastCategoryId: string | null) =>
    invoke<Payee>("create_payee", { name, lastCategoryId }),
  /** Rename a payee and/or set the category it defaults to. The rename also
   *  rewrites the denormalized `transactions.payee` the register displays. */
  updatePayee: (id: string, name: string, lastCategoryId: string | null) =>
    invoke<Payee>("update_payee", { id, name, lastCategoryId }),
  mergePayees: (fromId: string, intoId: string) =>
    invoke<Payee>("merge_payees", { fromId, intoId }),
  deletePayee: (id: string) => invoke<void>("delete_payee", { id }),

  // Reconcile
  getOpenStatement: (accountId: string) =>
    invoke<Statement | null>("get_open_statement", { accountId }),
  getLastStatement: (accountId: string) =>
    invoke<Statement | null>("get_last_statement", { accountId }),
  startStatement: (args: {
    accountId: string;
    statementDate: string;
    startingBalanceCents: number;
    endingBalanceCents: number;
    serviceChargeCents: number | null;
    serviceChargeCategoryId: string | null;
    interestCents: number | null;
    interestCategoryId: string | null;
  }) => invoke<Statement>("start_statement", { ...args }),
  /** Mark every row on or before a date reconciled; dry run counts. */
  reconcileThrough: (accountId: string, through: string, dryRun: boolean) =>
    invoke<number>("reconcile_through", { accountId, through, dryRun }),
  setCleared: (transactionId: string, clearedState: ClearedState) =>
    invoke<void>("set_cleared", { transactionId, clearedState }),
  /** Postpone == cancel: drops the statement header, keeps the cleared marks. */
  discardStatement: (statementId: string) =>
    invoke<void>("discard_statement", { statementId }),
  finishStatement: (
    statementId: string,
    adjustmentCents: number | null,
    adjustmentCategoryId: string | null
  ) =>
    invoke<Statement>("finish_statement", {
      statementId,
      adjustmentCents,
      adjustmentCategoryId,
    }),

  // Categories (tree — migration 0014)
  listCategories: () => invoke<Category[]>("list_categories"),
  createCategory: (
    name: string,
    kind: CategoryKind,
    parentId: string | null = null,
    taxLine: string | null = null
  ) => invoke<Category>("create_category", { name, kind, parentId, taxLine }),
  updateCategory: (
    id: string,
    name: string,
    kind: CategoryKind,
    parentId: string | null = null,
    taxLine: string | null = null
  ) => invoke<Category>("update_category", { id, name, kind, parentId, taxLine }),
  /** `reassignTo` refiles everything that used the category; null orphans it. */
  deleteCategory: (id: string, reassignTo: string | null = null) =>
    invoke<void>("delete_category", { id, reassignTo }),
  mergeCategories: (fromId: string, intoId: string) =>
    invoke<void>("merge_categories", { fromId, intoId }),
  /** What a merge would do, asked before it is done. */
  previewCategoryMerge: (fromId: string, intoId: string) =>
    invoke<MergePreview>("preview_category_merge", { fromId, intoId }),
  /** Add Money's standard chart, skipping anything already present.
   *  Resolves to the number created — 0 means nothing was missing. */
  seedStandardCategories: () => invoke<number>("seed_standard_categories"),

  // Budgets & spending
  getSpendingSummary: (month: string) =>
    invoke<CategoryBudget[]>("get_spending_summary", { month }),
  /** Keyed by category id since 0014 — the old name-keyed call happily
   *  created a junk category out of whatever was typed. */
  setBudget: (categoryId: string, targetCents: number, monthYear: string) =>
    invoke<Budget>("set_budget", {
      categoryId,
      targetCents,
      monthYear,
    }),
  listBudgets: (monthYear: string) =>
    invoke<Budget[]>("list_budgets", { monthYear }),
  deleteBudget: (id: string) => invoke<void>("delete_budget", { id }),
  /** Autobudget: proposals from `lookback` months of history and the
   *  scheduled bills; `applyAutobudget` writes the accepted lines for
   *  `months` months starting at `month`. */
  autobudget: (month: string, lookback: number) => invoke<AutobudgetLine[]>("autobudget", { month, lookback }),
  applyAutobudget: (month: string, months: number, lines: [string, number][]) =>
    invoke<number>("apply_autobudget", { month, months, lines }),

  // Goals
  listGoals: () => invoke<Goal[]>("list_goals"),
  createGoal: (
    name: string,
    targetCents: number,
    savedCents: number,
    deadline: string | null,
    notes: string | null,
    accountId: string | null = null
  ) =>
    invoke<Goal>("create_goal", {
      name,
      targetCents,
      savedCents,
      deadline,
      notes,
      accountId,
    }),
  updateGoal: (
    id: string,
    name: string,
    targetCents: number,
    savedCents: number,
    deadline: string | null,
    notes: string | null,
    accountId: string | null = null
  ) =>
    invoke<Goal>("update_goal", {
      id,
      name,
      targetCents,
      savedCents,
      deadline,
      notes,
      accountId,
    }),
  deleteGoal: (id: string) => invoke<void>("delete_goal", { id }),
  /** Tag a row for a goal (null untags). A transfer's other half is followed
   *  into the goal's account. */
  setTransactionGoal: (transactionId: string, goalId: string | null) =>
    invoke<void>("set_transaction_goal", { transactionId, goalId }),
  contributeToGoal: (goalId: string, fromAccountId: string, date: string, amountCents: number, notes: string | null) =>
    invoke<Goal>("contribute_to_goal", { goalId, fromAccountId, date, amountCents, notes }),

  // Classifications: the axis that says what money was FOR.
  listClassifications: () => invoke<Classification[]>("list_classifications"),
  createClassification: (name: string) => invoke<Classification>("create_classification", { name }),
  renameClassification: (id: string, name: string) =>
    invoke<Classification>("rename_classification", { id, name }),
  /** Resolves to how many transaction / split links went with it. */
  deleteClassification: (id: string) => invoke<number>("delete_classification", { id }),
  createClassificationValue: (classificationId: string, name: string, parentId: string | null = null) =>
    invoke<ClassificationValue>("create_classification_value", { classificationId, name, parentId }),
  renameClassificationValue: (id: string, name: string) =>
    invoke<ClassificationValue>("rename_classification_value", { id, name }),
  deleteClassificationValue: (id: string) => invoke<number>("delete_classification_value", { id }),
  /** A transaction's values, one per axis; an empty `value_id` clears one.
   *  Both halves of a transfer are written. */
  setTransactionClasses: (transactionId: string, picks: ClassPick[]) =>
    invoke<ClassPick[]>("set_transaction_classes", { transactionId, picks }),

  // Investments: securities, prices, lots
  listSecurities: () => invoke<Security[]>("list_securities"),
  createSecurity: (name: string, symbol: string, kind: SecurityKind, notes: string | null) =>
    invoke<Security>("create_security", { name, symbol, kind, notes }),
  updateSecurity: (id: string, name: string, symbol: string, kind: SecurityKind, notes: string | null) =>
    invoke<Security>("update_security", { id, name, symbol, kind, notes }),
  deleteSecurity: (id: string) => invoke<void>("delete_security", { id }),
  /** Securities with no symbol whose name reads as a ticker get it as the symbol. Returns how many. */
  fillSymbolsFromNames: () => invoke<number>("fill_symbols_from_names"),
  listSecurityPrices: (securityId: string) =>
    invoke<SecurityPrice[]>("list_security_prices", { securityId }),
  setSecurityPrice: (securityId: string, date: string, priceMicro: number) =>
    invoke<void>("set_security_price", { securityId, date, priceMicro }),
  deleteSecurityPrice: (securityId: string, date: string) =>
    invoke<void>("delete_security_price", { securityId, date }),
  createInvestmentTransaction: (transaction: NewInvestmentTransaction) =>
    invoke<string>("create_investment_transaction", { transaction }),
  updateInvestmentTransaction: (id: string, transaction: NewInvestmentTransaction) =>
    invoke<void>("update_investment_transaction", { id, transaction }),
  createShareTransfer: (
    fromAccountId: string,
    toAccountId: string,
    date: string,
    securityId: string,
    sharesMicro: number,
    notes: string | null,
    lotAllocations: LotAllocation[]
  ) =>
    invoke<string[]>("create_share_transfer", { fromAccountId, toAccountId, date, securityId, sharesMicro, notes, lotAllocations }),
  listLots: (accountId: string, securityId: string, asOf: string) =>
    invoke<Lot[]>("list_lots", { accountId, securityId, asOf }),
  getDisposals: (sellId: string) => invoke<Disposal[]>("get_disposals", { sellId }),
  /** Per-transaction tax line: null follows the category, "" takes
   *  the row out of the tax reports, a line puts it on that line. */
  setTransactionTaxLine: (transactionId: string, taxLine: string | null) =>
    invoke<void>("set_transaction_tax_line", { transactionId, taxLine }),
  /** Money's 401(k) Manager: Add/Remove Shares rows for the
   *  difference between the statement and the register. */
  updateHoldings: (accountId: string, date: string, lines: StatementHolding[], dryRun: boolean) =>
    invoke<HoldingChange[]>("update_holdings", { accountId, date, lines, dryRun }),
  /** Past month / YTD / 12 months / all time returns. */
  getRoi: (accountId: string | null = null, asOf: string | null = null) => invoke<RoiPeriod[]>("get_roi", { accountId, asOf }),
  /** Time-weighted and money-weighted returns by period. */
  getPerformance: (accountId: string | null = null, asOf: string | null = null, securityId: string | null = null) =>
    invoke<Performance[]>("get_performance", { accountId, securityId, asOf }),
  getPortfolio: (accountId: string | null = null, asOf: string | null = null) =>
    invoke<Portfolio>("get_portfolio", { accountId, asOf }),

  // Transfers — one action, two linked rows. amountCents is a magnitude;
  // direction comes from the two account ids.
  // `receivedCents` is what arrives in the other account, in ITS currency,
  // when the two are kept in different currencies; null otherwise.
  createTransfer: (
    fromAccountId: string,
    toAccountId: string,
    date: string,
    amountCents: number,
    notes: string | null,
    receivedCents: number | null = null
  ) =>
    invoke<Transaction>("create_transfer", {
      fromAccountId,
      toAccountId,
      date,
      amountCents,
      receivedCents,
      notes,
    }),

  /** The order the accounts are listed in, everywhere; the whole arrangement. */
  setAccountOrder: (ids: string[]) => invoke<number>("set_account_order", { ids }),
  // Attachments. The bytes never pass through here: add reads a
  // path in Rust, open hands a temp copy to the OS, save writes where asked.
  listAttachments: (transactionId: string | null, accountId: string | null = null) =>
    invoke<Attachment[]>("list_attachments", { transactionId, accountId }),
  addAttachment: (transactionId: string | null, accountId: string | null, path: string) =>
    invoke<Attachment>("add_attachment", { transactionId, accountId, path }),
  removeAttachment: (id: string) => invoke<void>("remove_attachment", { id }),
  openAttachment: (id: string) => invoke<string>("open_attachment", { id }),
  saveAttachment: (id: string, path: string) => invoke<void>("save_attachment", { id, path }),
  /** An ordinary transaction becomes a transfer to another account;
   *  the partner row is written for it. */
  convertToTransfer: (id: string, otherAccountId: string) =>
    invoke<Transaction>("convert_to_transfer", { id, otherAccountId }),
  /** The reverse: the partner goes, this row is filed under a category. */
  convertFromTransfer: (id: string, categoryId: string | null) =>
    invoke<Transaction>("convert_from_transfer", { id, categoryId }),
  /** Edit a transfer in place, including moving the other half to a
   *  different account. `amountCents` is signed from the edited side. */
  updateTransfer: (
    id: string,
    date: string,
    otherAccountId: string,
    amountCents: number,
    notes: string | null,
    /** The other side's amount (a magnitude, in its currency) when the two
     *  accounts are kept in different currencies; null otherwise. */
    otherAmountCents: number | null = null
  ) =>
    invoke<Transaction>("update_transfer", {
      id,
      date,
      otherAccountId,
      amountCents,
      otherAmountCents,
      notes,
    }),

  // Splits — an empty array clears the transaction's splits. The line amounts
  // must sum to the parent transaction's amount; the backend enforces it.
  listSplits: (transactionId: string) =>
    invoke<Split[]>("list_splits", { transactionId }),

  // Reports
  // The report gallery and engine
  listReports: () => invoke<ReportGalleryEntry[]>("list_reports"),
  runReport: (request: ReportRequest) => invoke<Report>("run_report", { request }),
  getTransactionAccount: (id: string) => invoke<string>("get_transaction_account", { id }),
  listSavedReports: () => invoke<SavedReport[]>("list_saved_reports"),
  saveReport: (report: SavedReport) => invoke<SavedReport>("save_report", { report }),
  deleteSavedReport: (id: string) => invoke<void>("delete_saved_report", { id }),

  // Import
  importQifOfx: (filePath: string, accountId: string) =>
    invoke<ImportSummary>("import_qif_ofx", { filePath, accountId }),
  /** Small per-file settings the frontend owns. */
  getUiSetting: (key: string) => invoke<string | null>("get_ui_setting", { key }),
  setUiSetting: (key: string, value: string) => invoke<void>("set_ui_setting", { key, value }),
  /** Money's "Export an account as QIF": [records written, void rows left out]. */
  exportQif: (accountId: string, path: string) => invoke<[number, number]>("export_qif", { accountId, path }),

  // Keyring
  getKeyStatus: () => invoke<KeyStatus>("get_key_status"),
  /** Re-encrypts the FILE and then records the new key. Before a fix this only
   *  changed the keyring, leaving a database only the old — and never
   *  displayed — key could open. */
  changeMasterKey: (newKey: string) => invoke<void>("change_master_key", { newKey }),
  /** The key itself, so it can be written down. Not a leak: without it, the
   *  database and every backup of it are unreadable forever. */
  setAccountTaxIncluded: (accountId: string, included: boolean) =>
    invoke<void>("set_account_tax_included", { accountId, included }),
  /** CSV import — preview (writes nothing), then import with the confirmed mapping. */
  previewCsv: (path: string, hasHeader: boolean | null, mapping: CsvMapping | null) =>
    invoke<CsvPreview>("preview_csv", { path, hasHeader, mapping }),
  importCsv: (path: string, accountId: string, mapping: CsvMapping) =>
    invoke<ImportSummary>("import_csv", { path, accountId, mapping }),
  /** Which rows of a statement look like transactions already in the
   *  register. Writes nothing; `mapping` is set for a CSV only. */
  previewImport: (path: string, accountId: string, mapping: CsvMapping | null, windowDays: number) =>
    invoke<ImportMatchPreview>("preview_import", { path, accountId, mapping, windowDays }),
  /** Import with the answers from the review dialogs. */
  importWithDecisions: (
    path: string,
    accountId: string,
    mapping: CsvMapping | null,
    decisions: RowDecision[],
    memoRules: MemoRule[] = []
  ) => invoke<ImportSummary>("import_with_decisions", { path, accountId, mapping, decisions, memoRules }),
  /** Write a CSV the frontend built to a path from the save dialog. */
  writeTextFile: (path: string, text: string) => invoke<void>("write_text_file", { path, text }),
  /** Payee rename rules and the duplicate finder. */
  listPayeeRules: () => invoke<PayeeRule[]>("list_payee_rules", {}),
  /** `when` adds conditions: an amount range (absolute cents), memo
   *  text, an account. Sent only when given, so an older caller is unchanged. */
  // The four conditions are always sent (null is "any"); no comment
  // inside the literal, the contract test reads its keys.
  createPayeeRule: (matchText: string, payeeName: string, categoryId: string | null, when?: RuleConditions) =>
    invoke<PayeeRule>("create_payee_rule", {
      matchText,
      payeeName,
      categoryId,
      minCents: when?.min_cents ?? null,
      maxCents: when?.max_cents ?? null,
      memoContains: when?.memo_contains ?? null,
      accountId: when?.account_id ?? null,
    }),
  deletePayeeRule: (id: string) => invoke<void>("delete_payee_rule", { id }),
  /** What applying the rules would change, changing nothing. */
  previewPayeeRules: () => invoke<PayeeRuleChange[]>("preview_payee_rules"),
  /** `transactionIds` are the rows left ticked in the preview; omit for all
   *  of them, which is what the card's button has always done. One undo
   *  step either way. */
  applyPayeeRules: (transactionIds: string[] | null = null) =>
    invoke<number>("apply_payee_rules", { transactionIds }),
  findDuplicates: (accountId: string, windowDays: number) =>
    invoke<DuplicateGroup[]>("find_duplicates", { accountId, windowDays }),
  /** What an asset is worth now — a dated revaluation, invisible to
   *  income and spending reports. Returns null when the value is unchanged. */
  setAccountValue: (accountId: string, date: string, valueCents: number, notes: string | null) =>
    invoke<Transaction | null>("set_account_value", { accountId, date, valueCents, notes }),
  /** The asset a debt is borrowed against; null unlinks. */
  setAccountSecurity: (accountId: string, assetId: string | null) =>
    invoke<void>("set_account_security", { accountId, assetId }),
  /** Asset id -> what is owed against it, positive. */
  debtsByAsset: () => invoke<AssetDebts>("debts_by_asset", {}),
  /** This loan's terms, or null if they have never been set. */
  getLoanTerms: (accountId: string) => invoke<LoanTerms | null>("get_loan_terms", { accountId }),
  /** Save this loan's terms, overwriting whatever was there. */
  setLoanTerms: (terms: LoanTerms) => invoke<void>("set_loan_terms", { terms }),
  /** Forget the terms; the account and its history stay. */
  clearLoanTerms: (accountId: string) => invoke<void>("clear_loan_terms", { accountId }),
  /** The next `count` payments from what is owed today. Nothing is written. */
  loanSchedule: (accountId: string, from: string | null, count: number, terms?: LoanTerms | null) =>
    invoke<LoanPeriod[]>("loan_schedule", { accountId, from, count, terms: terms ?? null }),
  /** How the next payment divides at today's balance. */
  nextLoanPayment: (accountId: string, date: string | null) =>
    invoke<LoanPeriod>("next_loan_payment", { accountId, date }),
  /** One transaction split into interest, principal and escrow. The
   *  amounts passed are the ones recorded — the schedule only proposed them.
   *  Returns the new transaction's id. */
  recordLoanPayment: (p: {
    accountId: string;
    fromAccountId: string;
    date: string;
    interestCents: number;
    principalCents: number;
    escrowCents: number;
    /** Paid ahead, its own split line inside the same one transaction. */
    extraPrincipalCents: number;
    payee: string | null;
    checkNumber: string | null;
    notes: string | null;
  }) => invoke<string>("record_loan_payment", p),
  /** Verify this file; repair = recompute drifted balances, unlink half transfers. */
  verifyFile: (repair: boolean) => invoke<FileCheck>("verify_file", { repair }),
  /** "nearest" | "down" | null (follow the file). */
  setAccountValueRounding: (accountId: string, rounding: HoldingRounding | null) =>
    invoke<void>("set_account_value_rounding", { id: accountId, rounding }),
  exportMasterKey: () => invoke<string>("export_master_key", {}),
  saveMasterKey: (path: string) => invoke<void>("save_master_key", { path }),

  // Automatic backup.
  getBackupConfig: () => invoke<BackupConfig>("get_backup_config", {}),
  setBackupConfig: (
    enabled: boolean,
    /** Also on app exit and File → Close. */
    onExit: boolean,
    folder: string | null,
    keep: number
  ) => invoke<BackupConfig>("set_backup_config", { enabled, onExit, folder, keep }),
  backupNow: () => invoke<string>("backup_now", {}),

  // Backup / restore
  /** T-Money files. The database is a document now: it has a name, it
   *  lives where the user put it, and the app remembers the last few. */
  currentFile: () => invoke<OpenFile>("current_file"),
  /** Back to T-Money's own database. */
  closeFile: () => invoke<OpenFile>("close_file"),
  /** Why the app is not on the file you left it on, once. */
  startupNote: () => invoke<string | null>("startup_note"),

  // The TSP importer. Preview reads and works out; import writes.
  /** With an account, the preview says what of the opening position
   *  that account already holds; without one, nothing can be said yet. */
  previewTsp: (path: string, accountId: string | null = null) =>
    invoke<TspPlan>("preview_tsp", { path, accountId }),
  /** `cashAccountId` is null when the file paid nothing out; there is
   *  then no bank account to name. Rust refuses a file WITH payments and no
   *  account rather than writing half of it. */
  importTsp: (path: string, accountId: string, cashAccountId: string | null, splits: TspPaymentSplit[]) =>
    invoke<ImportSummary>("import_tsp", { path, accountId, cashAccountId, splits }),

  listRecentFiles: () => invoke<RecentFile[]>("list_recent_files"),
  forgetFile: (path: string) => invoke<void>("forget_file", { path }),
  /** `create` distinguishes New from Open: without it a path that is not
   *  there is an error, never a silently created empty file. */
  openFile: (path: string, create: boolean, key: string | null) =>
    invoke<OpenFile>("open_file", { path, create, key }),
  /** Make a NEW file full of demo data and open it. Refuses a path
   *  that already exists, which is what makes it safe in a release build. */
  createSampleFile: (path: string) => invoke<SeedSummary>("create_sample_file", { path }),
  /** The Budget screen: every expense category, with the parent/child
   *  rollup applied and the totals computed in Rust. */
  getBudgetGrid: (month: string) => invoke<BudgetGrid>("get_budget_grid", { month }),
  /** Set one budget and keep its parent above its children. Returns
   *  the parent it raised, if any. */
  /** The whole year in one answer: income, expenses, the net line,
   *  and twelve months of actuals read out of the register. */
  getYearPlan: (year: number) => invoke<YearPlan>("get_year_plan", { year }),
  /** Set one line's plan: an annual figure and the twelve-character
   *  month mask it is spread over. Returns the line and any parent it raised. */
  setBudgetPlan: (
    categoryId: string,
    year: number,
    annualCents: number,
    months: string,
    /** How to read `months`; omitted means "spent", as it first was. */
    spread: PlanSpread = "spent"
  ) => invoke<PlanWrite>("set_budget_plan", { categoryId, year, annualCents, months, spread }),
  /** Read one year and propose the next. Writes nothing; the rows
   *  that come back ticked go to `applyYearPlan`. */
  planFromHistory: (fromYear: number, toYear: number) =>
    invoke<PlanProposal[]>("plan_from_history", { fromYear, toYear }),
  /** Write the accepted proposals in one pass. */
  applyYearPlan: (year: number, lines: PlanPick[]) =>
    invoke<number>("apply_year_plan", { year, lines }),
  /** Remove a line's plan and the monthly rows it wrote. Not the same
   *  as a plan of zero, which is a real budget of nothing. */
  clearBudgetPlan: (categoryId: string, year: number) =>
    invoke<void>("clear_budget_plan", { categoryId, year }),
  /** A budget to start from, proposed from what this file actually
   *  spends. Apply with `applyAutobudget`. */
  getBudgetStarter: (month: string, lookback?: number, limit?: number) =>
    invoke<AutobudgetLine[]>("get_budget_starter", { month, lookback, limit }),
  getDbInfo: () => invoke<DbInfo>("get_db_info"),
  backupDatabase: (path: string) => invoke<number>("backup_database", { path }),
  /** `key` is the passphrase the backup was encrypted with, when it is not
   *  the one this machine holds — the recovery path for a backup carried from
   *  another machine. */
  restoreDatabase: (path: string, key: string | null = null) =>
    invoke<void>("restore_database", { path, key }),

  // Undo. The status is what the Edit menu reads: it decides both
  // whether the item is enabled and what it says.
  undoStatus: () => invoke<UndoStatus>("undo_status"),
  undoLast: () => invoke<UndoStatus>("undo_last"),
  redoLast: () => invoke<UndoStatus>("redo_last"),
};
