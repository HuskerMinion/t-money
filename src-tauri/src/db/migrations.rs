//! Schema migrations for the encrypted T-Money database.
//!
//! Migrations are applied in order and tracked in `schema_migrations`.
//! Each migration is an idempotent SQL batch.

use rusqlite::Connection;

/// Ordered list of migrations. Each entry is `(version, name, sql)`.
pub const MIGRATIONS: &[(&str, &str, &str)] = &[
    (
        "0001",
        "create_accounts",
        r#"
        CREATE TABLE IF NOT EXISTS accounts (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            type          TEXT NOT NULL CHECK (type IN ('checking','savings','credit','cash')),
            balance_cents INTEGER NOT NULL DEFAULT 0,
            is_favorite   INTEGER NOT NULL DEFAULT 0,
            updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_accounts_favorite ON accounts(is_favorite);
        "#,
    ),
    (
        "0002",
        "create_categories",
        r#"
        CREATE TABLE IF NOT EXISTS categories (
            id   TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE
        );
        "#,
    ),
    (
        "0003",
        "create_transactions",
        r#"
        CREATE TABLE IF NOT EXISTS transactions (
            id            TEXT PRIMARY KEY,
            account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            date          TEXT NOT NULL,
            payee         TEXT NOT NULL DEFAULT '',
            category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
            amount_cents  INTEGER NOT NULL,
            is_reconciled INTEGER NOT NULL DEFAULT 0,
            notes         TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
        CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
        CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);
        "#,
    ),
    (
        "0004",
        "create_budgets",
        r#"
        CREATE TABLE IF NOT EXISTS budgets (
            id            TEXT PRIMARY KEY,
            category_name TEXT NOT NULL,
            target_cents  INTEGER NOT NULL DEFAULT 0,
            month_year    TEXT NOT NULL,
            UNIQUE (category_name, month_year)
        );
        CREATE INDEX IF NOT EXISTS idx_budgets_month ON budgets(month_year);
        "#,
    ),
    (
        "0005",
        "create_goals_payments_investments",
        r#"
        CREATE TABLE IF NOT EXISTS goals (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            target_cents  INTEGER NOT NULL DEFAULT 0,
            saved_cents   INTEGER NOT NULL DEFAULT 0,
            deadline      TEXT,
            notes         TEXT,
            updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS payments (
            id            TEXT PRIMARY KEY,
            payee         TEXT NOT NULL,
            amount_cents  INTEGER NOT NULL DEFAULT 0,
            due_date      TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid','skipped')),
            notes         TEXT,
            updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_payments_due ON payments(due_date);
        CREATE TABLE IF NOT EXISTS investments (
            id                  TEXT PRIMARY KEY,
            name                TEXT NOT NULL,
            symbol              TEXT NOT NULL DEFAULT '',
            quantity            TEXT NOT NULL DEFAULT '0',
            avg_cost_cents      INTEGER NOT NULL DEFAULT 0,
            current_value_cents INTEGER NOT NULL DEFAULT 0,
            notes               TEXT,
            updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );
        "#,
    ),
    (
        "0007",
        "create_splits",
        r#"
        -- A transaction split across several categories (§6.1e).
        -- `description` is PER LINE and is distinct from transactions.notes
        -- (Money's Memo). `sort_order` preserves the grid's row order, which
        -- matters because rows are individually deletable.
        CREATE TABLE IF NOT EXISTS splits (
            id             TEXT PRIMARY KEY,
            transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            category_id    TEXT REFERENCES categories(id) ON DELETE SET NULL,
            description    TEXT,
            amount_cents   INTEGER NOT NULL,
            sort_order     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_splits_transaction ON splits(transaction_id);
        "#,
    ),
    (
        "0008",
        "add_transfer_id",
        r#"
        -- A transfer is TWO linked transactions, one per account, pointing at
        -- each other. In Money you enter one by choosing the category
        -- "Transfer : <Account>"; the paired row is created for you, and
        -- deleting either deletes both. See §10.2 item 5.
        ALTER TABLE transactions ADD COLUMN transfer_id TEXT REFERENCES transactions(id);
        CREATE INDEX IF NOT EXISTS idx_transactions_transfer ON transactions(transfer_id);
        "#,
    ),
    (
        "0009",
        "widen_account_types",
        r#"
        -- Money's account taxonomy is far larger than the original four values
        -- (checking|savings|credit|cash) — see §6.1g. SQLite
        -- cannot alter a CHECK constraint in place, so this is the standard
        -- table-rebuild: create, copy, drop, rename.
        --
        -- `bill_payment` is deliberately ABSENT: the user excluded Money's
        -- "Bill payment service provider" from scope.
        --
        -- Foreign keys are disabled for the swap so transactions.account_id
        -- survives the drop/rename and re-binds to the new table.
        PRAGMA foreign_keys = OFF;

        CREATE TABLE accounts_new (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            type          TEXT NOT NULL CHECK (type IN (
                              'bank','checking','savings',
                              'credit','line_of_credit',
                              'employee_stock_option','investment','retirement','watch',
                              'asset','vehicle','cash','home','home_equity_line_of_credit',
                              'liability','loan','mortgage','other'
                          )),
            balance_cents INTEGER NOT NULL DEFAULT 0,
            is_favorite   INTEGER NOT NULL DEFAULT 0,
            is_closed     INTEGER NOT NULL DEFAULT 0,
            updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO accounts_new (id, name, type, balance_cents, is_favorite, updated_at)
            SELECT id, name, type, balance_cents, is_favorite, updated_at FROM accounts;

        DROP TABLE accounts;
        ALTER TABLE accounts_new RENAME TO accounts;
        CREATE INDEX IF NOT EXISTS idx_accounts_favorite ON accounts(is_favorite);
        CREATE INDEX IF NOT EXISTS idx_accounts_closed ON accounts(is_closed);

        PRAGMA foreign_keys = ON;
        "#,
    ),
    (
        "0010",
        "account_details",
        r#"
        -- Institution and contact details for an account — Money's "Change
        -- account details". Plain ADD COLUMNs, so no table rebuild.
        --
        -- account_number and routing_number are sensitive. They are safe at
        -- rest (the whole file is SQLCipher-encrypted with the user's key), but
        -- the UI should mask them by default and any export/report must not
        -- print them in full.
        ALTER TABLE accounts ADD COLUMN institution       TEXT;
        ALTER TABLE accounts ADD COLUMN account_number    TEXT;
        ALTER TABLE accounts ADD COLUMN routing_number    TEXT;
        ALTER TABLE accounts ADD COLUMN opened_on         TEXT;
        ALTER TABLE accounts ADD COLUMN credit_limit_cents INTEGER;
        ALTER TABLE accounts ADD COLUMN contact_phone     TEXT;
        ALTER TABLE accounts ADD COLUMN contact_email     TEXT;
        ALTER TABLE accounts ADD COLUMN website           TEXT;
        ALTER TABLE accounts ADD COLUMN address           TEXT;
        ALTER TABLE accounts ADD COLUMN account_notes     TEXT;
        "#,
    ),
    (
        "0011",
        "payees_and_cleared_state",
        r#"
        -- Payees as first-class rows (§10.3 item 8), plus the register columns
        -- Money shows that the app could not: the check Number and the
        -- three-state cleared flag (§6.1a).
        --
        -- NOTE ON MEMO: the plan called for a `memo` column separate from
        -- `notes`. The sampled transaction form (§6.1b) shows only ONE such
        -- field, "Memo:", so `transactions.notes` IS the memo. No second column.
        CREATE TABLE IF NOT EXISTS payees (
            id               TEXT PRIMARY KEY,
            name             TEXT NOT NULL UNIQUE,
            -- Money offers the payee's last category when you re-enter it.
            last_category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
            updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );

        ALTER TABLE transactions ADD COLUMN check_number TEXT;
        ALTER TABLE transactions ADD COLUMN payee_id     TEXT REFERENCES payees(id);
        -- '' = uncleared, 'C' = cleared, 'R' = reconciled.
        ALTER TABLE transactions ADD COLUMN cleared_state TEXT NOT NULL DEFAULT '';

        -- Backfill payees from the free-text payee strings already in use.
        INSERT OR IGNORE INTO payees (id, name)
            SELECT lower(hex(randomblob(16))), payee
            FROM transactions
            WHERE payee IS NOT NULL AND trim(payee) <> ''
            GROUP BY payee;

        UPDATE transactions
           SET payee_id = (SELECT p.id FROM payees p WHERE p.name = transactions.payee)
         WHERE payee_id IS NULL;

        -- Carry the old boolean across. is_reconciled stays in the table but is
        -- now VESTIGIAL: every read derives is_reconciled from cleared_state.
        UPDATE transactions SET cleared_state = 'R' WHERE is_reconciled = 1;

        CREATE INDEX IF NOT EXISTS idx_transactions_payee ON transactions(payee_id);
        CREATE INDEX IF NOT EXISTS idx_transactions_cleared ON transactions(cleared_state);
        "#,
    ),
    (
        "0012",
        "statements",
        r#"
        -- Reconcile ("Balance this account", §6.1c / §6.1f). One row per
        -- statement. `status` is what makes Postpone and the resume dialog
        -- work: an 'in_progress' row is picked up next time.
        CREATE TABLE IF NOT EXISTS statements (
            id                          TEXT PRIMARY KEY,
            account_id                  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            statement_date              TEXT NOT NULL,
            starting_balance_cents      INTEGER NOT NULL DEFAULT 0,
            ending_balance_cents        INTEGER NOT NULL DEFAULT 0,
            status                      TEXT NOT NULL DEFAULT 'in_progress'
                                            CHECK (status IN ('in_progress','completed')),
            reconciled_on               TEXT,
            service_charge_cents        INTEGER,
            service_charge_category_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
            interest_cents              INTEGER,
            interest_category_id        TEXT REFERENCES categories(id) ON DELETE SET NULL,
            adjustment_cents            INTEGER,
            adjustment_category_id      TEXT REFERENCES categories(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_statements_account ON statements(account_id, status);
        "#,
    ),
    (
        "0013",
        "void_transactions",
        r#"
        -- A voided transaction stays in the register with its date, payee and
        -- original amount intact, but contributes NOTHING to any balance,
        -- budget or report. This is the fraud case: a reversed charge did not
        -- happen, but you still want the evidence that it was there.
        --
        -- amount_cents is deliberately NOT zeroed — the record of what the
        -- charge was is the whole point. Every read excludes is_void = 1
        -- instead.
        ALTER TABLE transactions ADD COLUMN is_void INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS idx_transactions_void ON transactions(is_void);
        "#,
    ),
    (
        "0014",
        "category_tree_and_budget_rekey",
        r#"
        -- Money's categories are a two-level tree (category / subcategory),
        -- each one either INCOME or EXPENSE, and each optionally mapped to a
        -- tax line. `kind` is load-bearing: every category picker filters on
        -- it (§6.1e), and Taxes (§10.4 item 16) is built on
        -- `tax_line`.
        ALTER TABLE categories ADD COLUMN parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL;
        ALTER TABLE categories ADD COLUMN kind TEXT NOT NULL DEFAULT 'expense'
                                              CHECK (kind IN ('income','expense'));
        ALTER TABLE categories ADD COLUMN tax_line TEXT;
        CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

        -- Backfill `kind` from the data rather than guessing by name: a
        -- category whose non-void lines net POSITIVE is income. Split lines
        -- count under their own category, same rule as CATEGORY_LINES.
        -- This is a heuristic on existing data; the Categories manager lets
        -- the user flip any category that was guessed wrong.
        UPDATE categories SET kind = 'income'
         WHERE id IN (
           SELECT category_id FROM (
             SELECT COALESCE(s.category_id, t.category_id)   AS category_id,
                    SUM(COALESCE(s.amount_cents, t.amount_cents)) AS net
               FROM transactions t
               LEFT JOIN splits s ON s.transaction_id = t.id
              WHERE t.is_void = 0
                AND COALESCE(s.category_id, t.category_id) IS NOT NULL
              GROUP BY 1
           ) WHERE net > 0
         );

        -- budgets was keyed by `category_name` TEXT, so renaming a category
        -- silently orphaned its budget (§10.1). Re-key to category_id.
        -- Any budget naming a category that no longer exists gets that
        -- category created first, so NO budget row is dropped by the rebuild.
        INSERT INTO categories (id, name)
            SELECT lower(hex(randomblob(16))), d.category_name
              FROM (SELECT DISTINCT category_name FROM budgets) d
             WHERE trim(d.category_name) <> ''
               AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.name = d.category_name);

        PRAGMA foreign_keys = OFF;

        CREATE TABLE budgets_new (
            id           TEXT PRIMARY KEY,
            category_id  TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
            target_cents INTEGER NOT NULL DEFAULT 0,
            month_year   TEXT NOT NULL,
            UNIQUE (category_id, month_year)
        );

        INSERT INTO budgets_new (id, category_id, target_cents, month_year)
            SELECT b.id, c.id, b.target_cents, b.month_year
              FROM budgets b
              JOIN categories c ON c.name = b.category_name;

        DROP TABLE budgets;
        ALTER TABLE budgets_new RENAME TO budgets;
        CREATE INDEX IF NOT EXISTS idx_budgets_month ON budgets(month_year);
        CREATE INDEX IF NOT EXISTS idx_budgets_category ON budgets(category_id);

        PRAGMA foreign_keys = ON;
        "#,
    ),
    (
        "0015",
        "category_name_unique_per_parent",
        r#"
        -- `categories.name` was declared globally UNIQUE back in 0001, when
        -- categories were a flat list. With the tree from 0014 that constraint
        -- is wrong: Money happily has `Automobile : Insurance` alongside a
        -- top-level `Insurance`, and `Home : Repairs` alongside
        -- `Automobile : Repairs & Maintenance`. The global UNIQUE rejects the
        -- first of those, which blocks any realistic standard category list.
        --
        -- SQLite cannot drop an inline UNIQUE, so this is a table rebuild.
        -- The self-referencing FK is written against `categories_new` on
        -- purpose: ALTER TABLE ... RENAME rewrites references to the renamed
        -- table, including a table's reference to itself, so it lands as
        -- `REFERENCES categories(id)`.
        PRAGMA foreign_keys = OFF;

        CREATE TABLE categories_new (
            id        TEXT PRIMARY KEY,
            name      TEXT NOT NULL,
            parent_id TEXT REFERENCES categories_new(id) ON DELETE SET NULL,
            kind      TEXT NOT NULL DEFAULT 'expense'
                          CHECK (kind IN ('income','expense')),
            tax_line  TEXT
        );

        INSERT INTO categories_new (id, name, parent_id, kind, tax_line)
            SELECT id, name, parent_id, kind, tax_line FROM categories;

        DROP TABLE categories;
        ALTER TABLE categories_new RENAME TO categories;

        -- Uniqueness, now scoped the way Money means it. Two partial indexes
        -- rather than one UNIQUE(parent_id, name), because SQLite treats NULLs
        -- as distinct in a UNIQUE index — without the second index, two
        -- top-level categories could share a name.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_unique_child
            ON categories(parent_id, name) WHERE parent_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_unique_root
            ON categories(name) WHERE parent_id IS NULL;
        CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

        PRAGMA foreign_keys = ON;
        "#,
    ),
    (
        "0016",
        "repair_orphaned_payee_ids",
        r#"
        -- Migration 0011 created `payees` and backfilled it from the free-text
        -- payee strings that existed AT THAT MOMENT — and nothing kept it
        -- current afterwards. `upsert_payee` was written but never called, so
        -- every transaction entered, edited, transferred, reconciled or
        -- imported since 0011 has `payee_id = NULL` and its payee is absent
        -- from the table. See §13.
        --
        -- The write paths are fixed as of this migration. This repairs the
        -- rows they left behind. It is 0011's backfill run again, unchanged
        -- and idempotent: `INSERT OR IGNORE` adds only genuinely new names,
        -- and the UPDATE touches only rows still unlinked.
        INSERT OR IGNORE INTO payees (id, name)
            SELECT lower(hex(randomblob(16))), payee
              FROM transactions
             WHERE payee IS NOT NULL AND trim(payee) <> ''
             GROUP BY payee;

        UPDATE transactions
           SET payee_id = (SELECT p.id FROM payees p WHERE p.name = transactions.payee)
         WHERE payee_id IS NULL
           AND payee IS NOT NULL
           AND trim(payee) <> '';
        "#,
    ),
    (
        "0017",
        "investment_prices",
        r#"
        -- A fetched share price, and when it was fetched.
        --
        -- `current_value_cents` was a number the user typed and then had to
        -- keep typing. These two columns let it be DERIVED —
        -- quantity x last_price — while staying honest about where the number
        -- came from and how old it is. Both NULL means "never fetched", which
        -- is the correct state for a holding with no symbol, a symbol the
        -- price source does not carry, or a file whose owner has never asked
        -- for a refresh.
        --
        -- Nothing fetches automatically. See `prices.rs` and §27:
        -- this is the only feature in the app that talks to the outside world,
        -- and it does so only when the user presses the button.
        ALTER TABLE investments ADD COLUMN last_price_cents INTEGER;
        ALTER TABLE investments ADD COLUMN price_updated_at TEXT;
        "#,
    ),
    (
        "0018",
        "common_transactions",
        r#"
        -- Money's "Common Transactions": a named template you fill the entry
        -- form from, so the transactions you enter every month cost one pick
        -- instead of five fields.
        --
        -- A template is deliberately NOT a transaction. It has no account, no
        -- date and no cleared state — those belong to the moment you enter it,
        -- not to the pattern. Everything else the form owns is here, including
        -- split lines, because the motivating example (§10.1) is a Walmart
        -- trip split across groceries, household and pharmacy: a template that
        -- could not carry splits would miss the case that made splits matter.
        --
        -- `amount_cents` is nullable: "Kroger, Groceries, whatever it came to
        -- this week" is a real template, and forcing a number on it would make
        -- the user delete one every time.
        CREATE TABLE IF NOT EXISTS common_transactions (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL UNIQUE,
            payee         TEXT NOT NULL DEFAULT '',
            category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
            amount_cents  INTEGER,
            check_number  TEXT,
            notes         TEXT,
            usage_count   INTEGER NOT NULL DEFAULT 0,
            updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Mirrors `splits`, minus the parent transaction. ON DELETE CASCADE so
        -- deleting a template cannot leave orphan lines behind.
        CREATE TABLE IF NOT EXISTS common_transaction_splits (
            id                    TEXT PRIMARY KEY,
            common_transaction_id TEXT NOT NULL
                                  REFERENCES common_transactions(id) ON DELETE CASCADE,
            category_id           TEXT REFERENCES categories(id) ON DELETE SET NULL,
            description           TEXT,
            amount_cents          INTEGER NOT NULL,
            sort_order            INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_common_splits_parent
            ON common_transaction_splits(common_transaction_id);
        "#,
    ),
    (
        "0019",
        "recurrences",
        r#"
        -- Scheduled bills and income, as RULES rather than rows.
        --
        -- The tempting design is to generate the next N payment rows and store
        -- them. That drifts: duplicates when the generator runs twice, orphans
        -- when a rule changes, and a "regenerate" job somebody has to remember.
        -- So a recurrence stores the rule, occurrences are computed on demand
        -- (`schedule.rs`), and only EXCEPTIONS are stored — this one was
        -- skipped, this one was paid and became transaction X. The forecast
        -- horizon is then just a query parameter and nothing can go stale.
        CREATE TABLE IF NOT EXISTS recurrences (
            id            TEXT PRIMARY KEY,
            payee         TEXT NOT NULL,
            -- Negative for a bill, positive for income. One sign convention,
            -- the same as transactions.
            amount_cents  INTEGER NOT NULL,
            account_id    TEXT REFERENCES accounts(id) ON DELETE CASCADE,
            category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
            freq          TEXT NOT NULL CHECK (freq IN
                              ('once','weekly','semi_monthly','monthly','yearly')),
            -- Every N weeks / months / years. 2 with 'weekly' is fortnightly,
            -- 3 with 'monthly' is quarterly.
            interval_n    INTEGER NOT NULL DEFAULT 1 CHECK (interval_n >= 1),
            -- The first occurrence. Its day-of-month (or weekday, for weekly)
            -- is what later occurrences follow.
            start_date    TEXT NOT NULL,
            -- Inclusive. NULL = runs forever.
            end_date      TEXT,
            -- 'semi_monthly' only: the second day of the month. The first
            -- comes from start_date.
            second_day    INTEGER CHECK (second_day BETWEEN 1 AND 31),
            -- What to do when an occurrence lands on a Saturday or Sunday.
            -- No holiday calendar: those are jurisdiction-specific and would
            -- need maintaining forever.
            weekend_rule  TEXT NOT NULL DEFAULT 'none'
                              CHECK (weekend_rule IN ('none','before','after')),
            notes         TEXT,
            is_active     INTEGER NOT NULL DEFAULT 1,
            updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_recurrences_active ON recurrences(is_active);

        -- One row only when something happened to a specific occurrence.
        -- `due_date` is the date the RULE generated, not the date it was paid,
        -- so an exception stays attached to its occurrence.
        CREATE TABLE IF NOT EXISTS recurrence_exceptions (
            id             TEXT PRIMARY KEY,
            recurrence_id  TEXT NOT NULL REFERENCES recurrences(id) ON DELETE CASCADE,
            due_date       TEXT NOT NULL,
            status         TEXT NOT NULL CHECK (status IN ('paid','skipped')),
            -- The transaction a paid occurrence became, so the forecast counts
            -- it once: as a real register row, never also as a projection.
            transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
            created_at     TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE (recurrence_id, due_date)
        );

        -- Existing one-off bills become 'once' rules, so there is ONE list of
        -- upcoming money rather than two concepts that both mean "a bill".
        -- Amounts flip sign: `payments.amount_cents` was stored positive and
        -- meant "money going out"; a recurrence uses the transaction
        -- convention, where out is negative.
        INSERT INTO recurrences (id, payee, amount_cents, freq, start_date, notes, is_active)
            SELECT id, payee, -abs(amount_cents), 'once', due_date, notes,
                   CASE WHEN status = 'due' THEN 1 ELSE 0 END
              FROM payments;

        -- ...and a payment already marked paid or skipped keeps that fact.
        INSERT INTO recurrence_exceptions (id, recurrence_id, due_date, status)
            SELECT lower(hex(randomblob(16))), id, due_date, status
              FROM payments WHERE status IN ('paid','skipped');
        "#,
    ),
    (
        "0020",
        "app_settings",
        r#"
        -- Small key/value store for app preferences (§34).
        --
        -- Inside the encrypted database rather than a plaintext config file
        -- beside it: the app's whole premise is that one file holds everything
        -- and nothing readable sits next to it. The one cost is that the
        -- backup folder cannot be read when the database will not open — which
        -- is acceptable, because at that point the user needs their key, not
        -- their preferences.
        CREATE TABLE IF NOT EXISTS app_settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        "#,
    ),
    (
        "0021",
        "opening_balance_rows_and_fitid",
        r#"
        -- Two repairs (§38).
        --
        -- 1. OFX carries a bank-assigned unique id per transaction (FITID).
        --    It is the honest duplicate key for re-imports — two $4.50 coffees
        --    at the same shop on the same day are two transactions, and the
        --    date+amount+payee key used to drop the second one.
        ALTER TABLE transactions ADD COLUMN fitid TEXT;
        CREATE INDEX IF NOT EXISTS idx_transactions_fitid ON transactions(account_id, fitid);

        -- 2. `create_account` used to write the opening balance straight into
        --    `accounts.balance_cents` with no row behind it, so the register's
        --    running balance (a sum over rows) started from zero while every
        --    other screen started from the opening amount. `create_account`
        --    now writes an "Opening Balance" row; this writes the same row for
        --    every account that already has the gap, for exactly the gap.
        --
        --    The row is dated at the account's opened_on when that is on or
        --    before its first transaction, else at the first transaction, else
        --    today — and it takes a rowid BELOW every existing row so that it
        --    sorts first on its date (the register orders by date, rowid).
        --    Reconciled, because an opening balance is not something to tick
        --    off against a statement. Accounts whose balance already equals
        --    the sum of their rows (demo data, empty accounts) get nothing.
        INSERT INTO transactions
            (rowid, id, account_id, date, payee, amount_cents, is_reconciled, cleared_state)
        WITH gaps AS (
            SELECT a.id AS account_id,
                   a.opened_on AS opened_on,
                   (SELECT MIN(t.date) FROM transactions t WHERE t.account_id = a.id) AS first_date,
                   a.balance_cents
                     - COALESCE((SELECT SUM(t.amount_cents) FROM transactions t
                                  WHERE t.account_id = a.id AND t.is_void = 0), 0) AS gap
              FROM accounts a
        ),
        floor_rowid AS (
            SELECT COALESCE(MIN(rowid), 1) AS r FROM transactions
        )
        SELECT (SELECT r FROM floor_rowid) - ROW_NUMBER() OVER (ORDER BY g.account_id),
               lower(hex(randomblob(16))),
               g.account_id,
               CASE
                 WHEN g.opened_on IS NOT NULL
                  AND (g.first_date IS NULL OR g.opened_on <= g.first_date) THEN g.opened_on
                 WHEN g.first_date IS NOT NULL THEN g.first_date
                 ELSE date('now', 'localtime')
               END,
               'Opening Balance',
               g.gap,
               1,
               'R'
          FROM gaps g
         WHERE g.gap <> 0;
        "#,
    ),
    (
        "0022",
        "investment_lots",
        r#"
        -- Investments become a portfolio (§41).
        --
        -- Before this, `investments` was a flat list of holdings with a typed
        -- quantity, a typed cost and a typed value, belonging to no account.
        -- Now:
        --
        --   * `securities` is WHAT you can hold (a fund, a stock, a bond).
        --   * A holding is DERIVED from investment transactions in an account —
        --     rows in `transactions` that carry `activity` and `security_id`.
        --     Buys, reinvestments and Add Shares open LOTS; sells and Remove
        --     Shares close them, oldest first (FIFO) unless `lot_allocations`
        --     says which lots a sale took. Cost basis and capital gains are
        --     computed from the lots (`db/lots.rs`), never typed.
        --   * `security_prices` is the price history, one row per security per
        --     day, whether fetched, typed, or implied by a buy/sell.
        --
        -- Units. Money is i64 cents everywhere in this file; share counts and
        -- prices need more than two decimals (a 401(k) buys 12.3456 shares of a
        -- fund at 34.5678), so both are i64 MILLIONTHS: `shares_micro` is
        -- shares x 1,000,000 and `price_micro` is dollars x 1,000,000. Never
        -- f64. `gross_cents` is the value of the shares that moved (what you
        -- paid or received before commission) and is STORED, because the user
        -- enters quantity and total and the price is the derived one; deriving
        -- the total from the price would round.
        --
        -- `amount_cents` keeps its one meaning — the effect on the account's
        -- CASH — so balances, transfers, reconcile and every existing report
        -- are untouched: a buy is -(gross + commission), a sell is
        -- gross - commission, a dividend paid to cash is +gross, and a
        -- reinvested dividend is 0 (the income is `gross_cents`; the lot's
        -- cost is gross + commission). A stock split stores the new-per-old
        -- ratio in `shares_micro` (2-for-1 = 2000000) and nothing else.
        CREATE TABLE IF NOT EXISTS securities (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            symbol     TEXT NOT NULL DEFAULT '',
            kind       TEXT NOT NULL DEFAULT 'stock'
                       CHECK (kind IN ('stock','mutual_fund','etf','bond','cd','money_market','other')),
            notes      TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_securities_name ON securities(name COLLATE NOCASE);

        CREATE TABLE IF NOT EXISTS security_prices (
            security_id TEXT NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
            date        TEXT NOT NULL,
            price_micro INTEGER NOT NULL,
            source      TEXT NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('manual','fetched','transaction')),
            PRIMARY KEY (security_id, date)
        );

        ALTER TABLE transactions ADD COLUMN security_id TEXT REFERENCES securities(id);
        ALTER TABLE transactions ADD COLUMN activity TEXT
            CHECK (activity IS NULL OR activity IN (
                'buy','sell','dividend','interest','ltcg_dist','stcg_dist',
                'reinvest_dividend','reinvest_interest','reinvest_ltcg','reinvest_stcg',
                'add_shares','remove_shares','return_of_capital','split'));
        ALTER TABLE transactions ADD COLUMN shares_micro INTEGER;
        ALTER TABLE transactions ADD COLUMN price_micro INTEGER;
        ALTER TABLE transactions ADD COLUMN gross_cents INTEGER;
        ALTER TABLE transactions ADD COLUMN commission_cents INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS idx_transactions_security ON transactions(security_id, date);

        -- Which lots a sale took, when the user said. Absent = FIFO. `lot_id`
        -- is the id of the transaction that opened the lot.
        CREATE TABLE IF NOT EXISTS lot_allocations (
            sell_id      TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            lot_id       TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            shares_micro INTEGER NOT NULL CHECK (shares_micro > 0),
            PRIMARY KEY (sell_id, lot_id)
        );

        -- Carry the old flat list across. Every old holding becomes a security;
        -- its last fetched price becomes the first price-history row; and a
        -- holding with shares becomes one "Add Shares" row, with the typed
        -- cost as its basis, in an account created for the purpose — because
        -- the old list belonged to no account and inventing one is the only
        -- way to keep the shares. The account is created ONLY when something
        -- needs it.
        INSERT INTO securities (id, name, symbol, kind, notes, updated_at)
        SELECT id, name, symbol, 'stock', notes, updated_at FROM investments;

        INSERT OR IGNORE INTO security_prices (security_id, date, price_micro, source)
        SELECT id, substr(price_updated_at, 1, 10), last_price_cents * 10000, 'fetched'
          FROM investments
         WHERE last_price_cents IS NOT NULL AND price_updated_at IS NOT NULL;

        INSERT INTO accounts (id, name, type, balance_cents, is_favorite, opened_on)
        SELECT 'imported-holdings', 'Imported holdings', 'investment', 0, 0, date('now', 'localtime')
         WHERE EXISTS (SELECT 1 FROM investments WHERE CAST(quantity AS REAL) > 0)
           AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = 'imported-holdings');

        INSERT INTO transactions
            (id, account_id, date, payee, amount_cents, is_reconciled, cleared_state,
             security_id, activity, shares_micro, price_micro, gross_cents, commission_cents, notes)
        SELECT lower(hex(randomblob(16))),
               'imported-holdings',
               substr(updated_at, 1, 10),
               name,
               0, 0, '',
               id,
               'add_shares',
               CAST(ROUND(CAST(quantity AS REAL) * 1000000) AS INTEGER),
               CASE WHEN CAST(quantity AS REAL) > 0
                    THEN CAST(ROUND(avg_cost_cents * 10000.0 / CAST(quantity AS REAL)) AS INTEGER)
                    ELSE NULL END,
               avg_cost_cents,
               0,
               'Carried over from the pre-0022 holdings list; the cost is the one that was typed there.'
          FROM investments
         WHERE CAST(quantity AS REAL) > 0;

        DROP TABLE investments;
        "#,
    ),
    (
        "0023",
        "goal_linkage",
        r#"
        -- Savings goals that watch an account (§46).
        --
        -- `saved_cents` was a number the user typed and then had to keep
        -- typing. A goal may now be linked to an account, and transactions
        -- in that account may be tagged with the goal; the goal's progress is
        -- then `saved_cents` (kept, now meaning "the starting amount") plus
        -- the tagged rows. Nothing is stored twice: the sum is computed on
        -- read. An unlinked goal behaves exactly as before.
        ALTER TABLE goals ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;
        ALTER TABLE transactions ADD COLUMN goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_transactions_goal ON transactions(goal_id);
        "#,
    ),
    (
        "0024",
        "accounts_tax_included",
        r#"
        -- Money's "Choose accounts to include in tax return information"
        -- (§48). Income, dividends and gains inside a tax-deferred
        -- account are not taxable events, so Money leaves retirement
        -- accounts out of its tax reports; the tax reports here did not,
        -- which overstated Schedule B and D for anyone with a 401(k).
        -- Retirement accounts start excluded; everything else included; the
        -- user can flip either on the Taxes tab.
        ALTER TABLE accounts ADD COLUMN tax_included INTEGER NOT NULL DEFAULT 1;
        UPDATE accounts SET tax_included = 0 WHERE type = 'retirement';
        "#,
    ),
    (
        "0025",
        "transaction_tax_line",
        r#"
        -- Money's "add a single transaction to a tax line / remove a single
        -- transaction from a tax line" (§53). Tax lines belong to
        -- categories; this is the per-transaction exception. NULL = follow
        -- the category (every existing row); '' = this one is NOT
        -- tax-related whatever its category says; a line name = this one
        -- goes on that line. A split transaction's override covers all its
        -- lines.
        ALTER TABLE transactions ADD COLUMN tax_line TEXT;
        "#,
    ),
    (
        "0026",
        "recurring_transfers",
        r#"
        -- Recurring transfers and scheduled goal contributions
        -- (§57). A rule with a transfer_account_id is Money's scheduled
        -- transfer: `amount_cents` (negative) leaves account_id and the
        -- same amount lands in transfer_account_id, entered as one linked
        -- pair. goal_id tags the receiving half for a savings goal (§46).
        ALTER TABLE recurrences ADD COLUMN transfer_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;
        ALTER TABLE recurrences ADD COLUMN goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL;
        "#,
    ),
    (
        "0027",
        "funding_transfer_link",
        r#"
        -- A buy paid from, or a sell deposited to, another account writes a
        -- linked cash pair (§41). Until now the buy row did not
        -- know which pair was its own, so "Pay from" could not be changed
        -- after entry (§71). funding_txn_id is the id of the pair's row in
        -- the investment account; its transfer_id leads to the other side.
        ALTER TABLE transactions ADD COLUMN funding_txn_id TEXT REFERENCES transactions(id) ON DELETE SET NULL;
        "#,
    ),
    (
        "0028",
        "funding_link_backfill",
        r#"
        -- Buys and sells written before 0027 have their funding pair but no
        -- link to it. The pair's row in the investment account is the cash
        -- row on the same date for the opposite amount whose note is
        -- "Buy <security>" / "Sell <security>" (what insert_transfer_pair
        -- wrote). Linked only when the match is unambiguous — exactly one
        -- such cash row for exactly one such buy — so nothing is guessed.
        UPDATE transactions
           SET funding_txn_id = (
               SELECT f.id FROM transactions f
                WHERE f.account_id = transactions.account_id
                  AND f.activity IS NULL AND f.transfer_id IS NOT NULL
                  AND f.date = transactions.date
                  AND f.amount_cents = -transactions.amount_cents
                  AND f.notes = (CASE transactions.activity WHEN 'buy' THEN 'Buy ' ELSE 'Sell ' END) || transactions.payee
                  AND (SELECT COUNT(*) FROM transactions f2
                        WHERE f2.account_id = f.account_id AND f2.activity IS NULL AND f2.transfer_id IS NOT NULL
                          AND f2.date = f.date AND f2.amount_cents = f.amount_cents AND f2.notes = f.notes) = 1
                  AND (SELECT COUNT(*) FROM transactions b2
                        WHERE b2.account_id = transactions.account_id AND b2.activity = transactions.activity
                          AND b2.date = transactions.date AND b2.amount_cents = transactions.amount_cents
                          AND b2.payee = transactions.payee) = 1
           )
         WHERE activity IN ('buy', 'sell') AND funding_txn_id IS NULL;
        "#,
    ),
    (
        "0029",
        "register_index",
        r#"
        -- §80: the register reads one account in (date, rowid) order and the
        -- running balance is a window over that order. With only the
        -- account index SQLite sorted every load; this index hands the rows
        -- over already ordered. lot_allocations(sell_id) is the PK's prefix
        -- already; nothing needed there.
        CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, date);
        "#,
    ),
    (
        "0030",
        "account_value_rounding",
        r#"
        -- §81: how THIS account's holdings are rounded to the cent —
        -- 'nearest' | 'down' — or NULL to follow the file's setting
        -- (app_settings 'ui.holding_rounding', §79). Brokers differ, and a
        -- file can hold more than one broker.
        ALTER TABLE accounts ADD COLUMN value_rounding TEXT
            CHECK (value_rounding IS NULL OR value_rounding IN ('nearest', 'down'));
        "#,
    ),
    (
        "0031",
        "payee_rules",
        r#"
        -- §84: Money's payee rename rules. A downloaded row whose payee
        -- CONTAINS match_text (case-insensitive) is filed under payee_name,
        -- and under category_id when the file gave it none. Applied at import
        -- and, on request, to what is already in the file. Longest match
        -- wins when several apply.
        CREATE TABLE IF NOT EXISTS payee_rules (
            id          TEXT PRIMARY KEY,
            match_text  TEXT NOT NULL,
            payee_name  TEXT NOT NULL,
            category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_payee_rules_match ON payee_rules(lower(match_text));
        "#,
    ),
    (
        "0032",
        "asset_revaluations_and_security",
        r#"
        -- §93: what a house or a car is worth changes without anyone spending
        -- anything. A revaluation row moves the account's balance and shows in
        -- net worth, but is NOT income and NOT spending: booking a $20,000
        -- rise on a house as income would swamp every category report with
        -- money that cannot be spent. The `lines` CTE every category, payee
        -- and tax report is built on excludes these rows; the balance and net
        -- worth queries do not.
        ALTER TABLE transactions ADD COLUMN is_revaluation INTEGER NOT NULL DEFAULT 0;

        -- §93: the debt an asset carries. On the LIABILITY, pointing at the
        -- asset, so a house can have both a mortgage and a HELOC against it
        -- while each debt is secured on exactly one thing.
        ALTER TABLE accounts ADD COLUMN secured_by_account_id TEXT
            REFERENCES accounts(id) ON DELETE SET NULL;

        CREATE INDEX IF NOT EXISTS idx_accounts_secured_by ON accounts(secured_by_account_id);
        "#,
    ),
    (
        "0033",
        "split_transfers_and_loan_terms",
        r#"
        -- §94: a split line that moves money to another account, not to a
        -- category. Without this a mortgage payment cannot be one
        -- transaction: interest is a category, escrow and principal are other
        -- accounts, and a split could only ever hold categories. This is also
        -- what QIF's bracketed account inside a split line has always meant
        -- (§65 noted it was dropped).
        ALTER TABLE splits ADD COLUMN transfer_account_id TEXT
            REFERENCES accounts(id) ON DELETE SET NULL;
        -- The row this line wrote in that account. SET NULL rather than
        -- CASCADE: deleting the far row by hand must not silently delete the
        -- split line that explains it.
        ALTER TABLE splits ADD COLUMN transfer_txn_id TEXT
            REFERENCES transactions(id) ON DELETE SET NULL;

        CREATE INDEX IF NOT EXISTS idx_splits_transfer ON splits(transfer_account_id);

        -- §94: what a loan costs and how a payment divides.
        --
        -- `apr_micro` is the annual rate in millionths (5.875% = 5_875_000),
        -- so a rate is exact rather than a float. Interest for a period is
        -- balance x apr / 12, rounded to the cent the same way every other
        -- number in this file is.
        --
        -- Everything here is a STARTING POINT, not the truth: the bank's
        -- arithmetic wins, and every part of a payment can be typed over when
        -- it is recorded. A schedule that disagrees with the statement is a
        -- schedule to correct, not a balance to fight.
        CREATE TABLE IF NOT EXISTS loan_terms (
            account_id           TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
            apr_micro            INTEGER NOT NULL DEFAULT 0,
            -- The regular payment, principal and interest only.
            payment_cents        INTEGER NOT NULL DEFAULT 0,
            -- Added on top each month, and sent where escrow_account_id or
            -- escrow_category_id says.
            escrow_cents         INTEGER NOT NULL DEFAULT 0,
            escrow_account_id    TEXT REFERENCES accounts(id) ON DELETE SET NULL,
            escrow_category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
            interest_category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
            -- Which account the payment usually comes out of.
            from_account_id      TEXT REFERENCES accounts(id) ON DELETE SET NULL,
            payment_day          INTEGER,
            first_payment_date   TEXT,
            term_months          INTEGER,
            notes                TEXT,
            updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
        );
        "#,
    ),
    (
        "0034",
        "mark_split_transfer_rows",
        r#"
        -- §94: the row a transfer split line writes in the OTHER account.
        --
        -- It is one half of a transfer, so no category, payee or tax report
        -- may count it — the same reason `transfer_id IS NULL` excludes an
        -- ordinary transfer's pair. It needs its own column because
        -- `transfer_id` names one row and a split has many far rows: a
        -- mortgage payment writes one into the loan and one into escrow.
        -- Without this the principal and escrow halves both landed in
        -- Uncategorized spending while the payment itself was already
        -- categorized — the same money counted twice.
        ALTER TABLE transactions ADD COLUMN is_split_transfer INTEGER NOT NULL DEFAULT 0;
        "#,
    ),
    (
        "0035",
        "classifications",
        r#"
        -- §112: Money's classifications — a second (and third, and Nth)
        -- tagging axis, orthogonal to the category tree. A category says what
        -- KIND of spending a line is; a classification says what it was FOR.
        -- "Repairs" is the category; "Lake house" is the classification
        -- value. Without this, "what did the lake house cost me last year"
        -- forces the cross product into the category tree
        -- (Repairs:Lake, Utilities:Lake, Insurance:Lake, ...).
        --
        -- Money allowed exactly two and never let one be deleted once used.
        -- Neither limit is repeated: an axis is a row in `classifications`,
        -- and deleting one drops its links, after the UI has said how many.
        CREATE TABLE IF NOT EXISTS classifications (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL UNIQUE,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        -- The values of one axis, one level of sub-values deep, as Money's
        -- were ("Lake house" under "Property"; "Roof 2026" under it).
        CREATE TABLE IF NOT EXISTS classification_values (
            id                TEXT PRIMARY KEY,
            classification_id TEXT NOT NULL REFERENCES classifications(id) ON DELETE CASCADE,
            parent_id         TEXT REFERENCES classification_values(id) ON DELETE CASCADE,
            name              TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_class_values_axis ON classification_values(classification_id);
        CREATE INDEX IF NOT EXISTS idx_class_values_parent ON classification_values(parent_id);

        -- The link. One row per (transaction or split line) per axis, so a
        -- transaction can carry a value from EACH classification at once —
        -- a column on `transactions` could only ever have held one. A split
        -- line's own row (split_id set) overrides the transaction's (split_id
        -- NULL) for that axis; a line without one inherits the transaction's.
        -- The split dialog is not optional: the axis leaks the moment anyone
        -- splits a property expense across two categories.
        --
        -- CASCADE from both parents, so a deleted row or a rewritten split set
        -- takes its links with it, and §101's undo — which photographs this
        -- table beside `transactions` and `splits` — puts them back.
        CREATE TABLE IF NOT EXISTS transaction_classes (
            transaction_id    TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            split_id          TEXT REFERENCES splits(id) ON DELETE CASCADE,
            classification_id TEXT NOT NULL REFERENCES classifications(id) ON DELETE CASCADE,
            value_id          TEXT NOT NULL REFERENCES classification_values(id) ON DELETE CASCADE
        );
        -- One value per axis per line. NULLs are distinct in a UNIQUE
        -- constraint, so the transaction-level row is keyed on '' instead.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_classes_line
            ON transaction_classes(transaction_id, COALESCE(split_id, ''), classification_id);
        CREATE INDEX IF NOT EXISTS idx_txn_classes_value ON transaction_classes(value_id);
        CREATE INDEX IF NOT EXISTS idx_txn_classes_split ON transaction_classes(split_id);
        "#,
    ),
    (
        "0036",
        "loan_extra_principal",
        r#"
        -- §121: the part of a mortgage payment that is not on the schedule.
        --
        -- A payment larger than the scheduled P&I plus escrow is not a bank
        -- rounding difference: the remainder is principal paid ahead,
        -- deliberately, every month. Before this it had nowhere to go -- the
        -- payment split three ways and nothing else -- so recording it meant a
        -- SECOND payment, and then the checking register showed two rows where
        -- the bank shows one. A register that cannot be reconciled against the
        -- statement is the one thing this application must never produce.
        --
        -- It lives in the terms, beside `escrow_cents`, because it is a
        -- standing decision rather than a one-off: it is proposed on every
        -- payment, and the schedule applies it, so the payoff date is the one
        -- the borrower is actually driving toward and not the lender's
        -- original 360.
        -- Zero for a loan paid to the schedule, which is every existing row.
        ALTER TABLE loan_terms ADD COLUMN extra_principal_cents INTEGER NOT NULL DEFAULT 0;
        "#,
    ),
    (
        "0037",
        "budget_period",
        r#"
        -- §131: is this budget a monthly figure or a yearly one?
        --
        -- Some costs are only ever known annually. Vehicle registration is
        -- "about $100 a year"; typed into a monthly budget it claims $100
        -- every month and the category reads as wildly over-funded, or the
        -- real figure gets left out of the budget altogether because there is
        -- nowhere honest to put it.
        --
        -- The AMOUNT stays as it was typed and this says how to read it, so a
        -- yearly line still shows $100 next year rather than $8.33 that
        -- nobody recognizes. Everything that has to compare against a month
        -- divides by twelve; the line itself is measured against the YEAR,
        -- because a yearly budget spent in one month is not overspending.
        --
        -- 'monthly' for every row that already exists: that is what they were.
        ALTER TABLE budgets ADD COLUMN period TEXT NOT NULL DEFAULT 'monthly'
            CHECK (period IN ('monthly','yearly'));
        "#,
    ),
    (
        "0038",
        "create_budget_plans",
        r#"
        -- §138: the YEAR plan.
        --
        -- > "I'm seeing that I have to budget every single month. Not put a
        -- >  budget in and see how it holds up for every month of the year."
        --
        -- `budgets` is keyed on (category, month), which is why the Budget tab
        -- asked for a decision twelve times a year. That is not how the user works:
        -- the user takes a year of a category's spending, divides by twelve, nudges
        -- it up, and then watches twelve columns of actuals against that ONE
        -- figure.
        --
        -- So the authored budget moves here: one row per category per YEAR.
        -- `budgets` does not go away and is not deprecated — it becomes the
        -- MATERIALIZED form. Saving a plan rewrites the twelve monthly rows
        -- from it, which is what keeps the spending tracker, the reports, the
        -- envelope rule and everything else that already reads `budgets`
        -- working without knowing this table exists.
        --
        -- `months` is a twelve-character mask, January first, '1' where the
        -- line applies. Every month for most things; Nov-Mar for heating oil; the
        -- four months an insurance premium is billed. The monthly figure is
        -- the annual divided by how many months are set, NOT by twelve — a
        -- line that only runs five months of the year is not a twelfth of
        -- anything, and dividing by twelve is what made the old screen lie
        -- about seasonal costs.
        --
        -- Income lives here too, on exactly the same terms. `budgets` has
        -- only ever held expense categories; the year plan carries both, so
        -- the screen can show income, expenses and a net line the way a
        -- spreadsheet does.
        CREATE TABLE IF NOT EXISTS budget_plans (
            id           TEXT PRIMARY KEY,
            category_id  TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
            year         INTEGER NOT NULL,
            annual_cents INTEGER NOT NULL DEFAULT 0,
            months       TEXT NOT NULL DEFAULT '111111111111'
                         CHECK (length(months) = 12),
            updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE (category_id, year)
        );
        CREATE INDEX IF NOT EXISTS idx_budget_plans_year ON budget_plans(year);
        "#,
    ),
    (
        "0039",
        "budget_plans_spread_mode",
        r#"
        -- §143: what the months mask MEANS.
        --
        -- > "if I designate say Jan and Jul as the months a certain bill gets
        -- >  paid I still want that bill's monthly amount in all the other
        -- >  months because those are the months where that smaller monthly
        -- >  amount is put into a savings account"
        --
        -- 0038's mask answers one question: WHEN IS THIS SPENT. Heating oil over
        -- Nov-Mar is $180 in each of five months, and the other seven expect
        -- nothing. That is right for heating oil, where the money genuinely leaves
        -- in those months.
        --
        -- It is wrong for home insurance. That money leaves ONCE, in January,
        -- but it is set aside every month all year. Asked to describe it, the
        -- 0038 model can say "spent in January" -- and then reports $1,200 owed
        -- that month and nothing to save in the other eleven -- or "every
        -- month", and then cannot say when the bill lands. One mask was being
        -- asked to carry two different meanings.
        --
        -- So the mask keeps its shape and gains a reading:
        --
        --   'spent' -- the months it is SPENT IN. Divide by those. This is
        --              0038, and it stays the default, so every existing row
        --              means exactly what it meant before this ran.
        --   'aside' -- the months it is DUE. Divide by TWELVE, because the
        --              monthly figure is what you set aside, and the mask
        --              marks where the bill lands.
        --
        -- In 'aside' the mask stops being arithmetic and becomes an
        -- annotation: the twelve materialized rows are a flat twelfth, exactly
        -- as 'every month' would be, so nothing downstream needs to learn this
        -- column exists either. What the mask buys is that the SCREEN can say
        -- "100 a month, 600 due Jan and Jul" rather than having to pick one.
        ALTER TABLE budget_plans ADD COLUMN spread TEXT NOT NULL DEFAULT 'spent'
            CHECK (spread IN ('spent','aside'));
        "#,
    ),
    (
        "0040",
        "envelope_provenance",
        r#"
        -- §147: who put that figure there.
        --
        -- A child set back to 0 (it could not be deleted) left its parent at
        -- the figure the child had raised it to: once a mistake was made, the
        -- parent never corrected.
        --
        -- §130/§131/§137's envelope rule only ever RAISES a parent. Nothing
        -- has ever lowered one, so a parent raised by a figure later reduced
        -- or mistyped keeps the high-water mark for ever. One user found an
        -- Automobile envelope of $300 sitting over children that were all
        -- blank.
        --
        -- The fix cannot be "parent always equals its children": §130's whole
        -- point is HEADROOM, and a deliberately roomy parent -- $900 over
        -- $500 of children -- has to survive its children changing. So the
        -- rule needs to know which figures are ITS and which are the user's.
        --
        --   auto_envelope = 1  the rule wrote this. It follows the children,
        --                      down as well as up, and disappears when they
        --                      stop claiming anything.
        --   auto_envelope = 0  a person typed it. Raised when the children
        --                      outgrow it, never lowered.
        --
        -- A raise that OVERRIDES a typed figure makes the row the rule's:
        -- once a typed $600 has been pushed to $810 the $600 is gone, and there
        -- is nothing to lower it back toward later.
        --
        -- DEFAULT 0 -- every row that already exists is treated as typed.
        -- That is the conservative reading and it means nothing in an existing file
        -- changes under the user on upgrade; the parents already carrying a stale
        -- high-water mark need one Clear each, which is noted in the
        -- walkthrough.
        ALTER TABLE budgets ADD COLUMN auto_envelope INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE budget_plans ADD COLUMN auto_envelope INTEGER NOT NULL DEFAULT 0;
        "#,
    ),
    (
        "0041",
        "envelope_asked_for",
        r#"
        -- §150: the figure the user asked for, kept.
        --
        -- 0040 asked "whose figure is this", which fixed the stuck envelope
        -- but threw away a real decision on the way. Typing 600 into Bills
        -- and then budgeting 800 of children lost the 600 for ever: the rule
        -- took ownership, and when the children shrank back there was nothing
        -- to return to, so the envelope vanished instead of going back to 600.
        --
        -- Shown the two designs, the user picked the other one:
        --
        -- > "I like your last example where the original amount comes back,
        -- >  do that"
        --
        -- So remember the figure a person TYPED, and show whichever is
        -- larger:
        --
        --     shown = max(asked_for, what the children need)
        --
        -- Typing 600 keeps 600. Children claiming 800 shows 810. Children
        -- back to nothing shows 600 again -- the user's figure, returned, because it
        -- was never overwritten, only outgrown.
        --
        -- This REPLACES `auto_envelope` rather than joining it: "who owns
        -- this" stops being a question. A parent nobody ever typed has no
        -- asked_for, so when its children stop claiming there is nothing to
        -- fall back to and the envelope goes -- which is §137's rule falling
        -- out of the arithmetic instead of being a special case.
        --
        -- NULL, not 0: "never typed one" and "typed zero" are different
        -- answers, and §138 has already established that a plan of zero is a
        -- real decision that gets measured against.
        ALTER TABLE budgets ADD COLUMN asked_for_cents INTEGER;
        ALTER TABLE budget_plans ADD COLUMN asked_for_cents INTEGER;

        -- Every figure already in the file was typed by the user -- that is what
        -- 0040's DEFAULT 0 asserted -- so seed it as asked for. Any parent
        -- carrying a stale high-water mark now has that mark as its floor,
        -- which is the conservative reading: it can still be typed down, and
        -- from then on it behaves.
        UPDATE budgets SET asked_for_cents = target_cents WHERE auto_envelope = 0;
        UPDATE budget_plans SET asked_for_cents = annual_cents WHERE auto_envelope = 0;
        "#,
    ),
    (
        "0042",
        "tsp_reallocations_are_exchanges",
        r#"
        -- §167: a TSP reallocation was written as a Sell of one fund and a
        -- Buy of another at that day's price. That booked a realized gain
        -- inside a tax-deferred plan and replaced the contributions' cost
        -- basis and dates with the day's market value -- so the plan's cost
        -- basis stopped being what was paid in.
        --
        -- It is an EXCHANGE: shares out, shares in, basis carried. The rows
        -- the TSP importer wrote are known by their memos. Each becomes the
        -- Remove Shares / Add Shares it always was, moving no cash (a
        -- reallocation day's sells and buys netted to zero, so the account's
        -- cash is unchanged and is recomputed below to be sure), and the day's
        -- rows are linked to each other -- every Add Shares to the day's
        -- first Remove Shares, every Remove Shares to the day's first Add
        -- Shares -- which is how the lot engine knows to pool them.
        UPDATE transactions SET activity = 'remove_shares', amount_cents = 0
         WHERE activity = 'sell' AND notes = 'TSP reallocation out of fund';
        UPDATE transactions SET activity = 'add_shares', amount_cents = 0
         WHERE activity = 'buy' AND notes = 'TSP reallocation into fund';

        UPDATE transactions SET transfer_id = (
            SELECT o.id FROM transactions o
             WHERE o.account_id = transactions.account_id AND o.date = transactions.date
               AND o.activity = 'remove_shares' AND o.notes = 'TSP reallocation out of fund' AND o.is_void = 0
             ORDER BY o.rowid LIMIT 1)
         WHERE activity = 'add_shares' AND notes = 'TSP reallocation into fund'
           AND transfer_id IS NULL AND is_void = 0
           AND EXISTS (SELECT 1 FROM transactions o
                        WHERE o.account_id = transactions.account_id AND o.date = transactions.date
                          AND o.activity = 'remove_shares' AND o.notes = 'TSP reallocation out of fund' AND o.is_void = 0);
        UPDATE transactions SET transfer_id = (
            SELECT i.id FROM transactions i
             WHERE i.account_id = transactions.account_id AND i.date = transactions.date
               AND i.activity = 'add_shares' AND i.notes = 'TSP reallocation into fund' AND i.is_void = 0
             ORDER BY i.rowid LIMIT 1)
         WHERE activity = 'remove_shares' AND notes = 'TSP reallocation out of fund'
           AND transfer_id IS NULL AND is_void = 0
           AND EXISTS (SELECT 1 FROM transactions i
                        WHERE i.account_id = transactions.account_id AND i.date = transactions.date
                          AND i.activity = 'add_shares' AND i.notes = 'TSP reallocation into fund' AND i.is_void = 0);

        -- The cash balance is the sum of the rows; say so again for any
        -- account the rewrite touched.
        UPDATE accounts SET balance_cents = (
            SELECT COALESCE(SUM(t.amount_cents), 0) FROM transactions t
             WHERE t.account_id = accounts.id AND t.is_void = 0)
         WHERE id IN (SELECT DISTINCT account_id FROM transactions
                       WHERE notes IN ('TSP reallocation out of fund', 'TSP reallocation into fund'));
        "#,
    ),
    (
        "0043",
        "account_sort_order",
        r#"
        -- §169: where an account sits in every list of accounts -- the
        -- account bar, the Home page's favorites, the Favorites menu, the
        -- Account List. NULL means never placed: those sort after the placed
        -- ones, by name, so a file that has never arranged anything reads
        -- exactly as it did.
        ALTER TABLE accounts ADD COLUMN sort_order INTEGER;
        "#,
    ),
    (
        "0044",
        "tsp_contributions_have_a_cash_side",
        r#"
        -- §172: a TSP contribution -- payroll deferral, agency match, the
        -- automatic 1%, a loan repayment withheld from pay -- is a Buy paid
        -- with money that never touched a bank account, and §90 gives such a
        -- buy a deposit for the same amount on the same day. Which buys HAVE
        -- that deposit depends on the road they came in by: the Import QIF
        -- dialog proposes the Contribution treatment from the memo wording
        -- and writes the deposit; the TSP importer (§103) ran the QIF path
        -- with no memo rules, so its buys are bare and the plan's cash
        -- drifts negative by every dollar paid in. §172 made the importer
        -- supply the rules; this writes the cash side for the bare buys
        -- already in the file -- and ONLY the bare ones. §172.1: contributions
        -- that came in through the dialog already have their deposits, under
        -- the file's own categories; the first draft of this wrote
        -- a second one beside each, which would have pushed the plan's cash
        -- positive by the lifetime contributions. A deposit is "already
        -- there" when the same account has, on the same day, a cash row for
        -- the same amount whose payee is the memo or whose note is §90's
        -- "Contribution — <fund>"; buys are counted against such rows in
        -- groups, so two equal contributions on one day with one deposit
        -- between them get exactly one more.
        DROP TABLE IF EXISTS ctb_todo;
        CREATE TEMP TABLE ctb_todo AS
        SELECT t.id AS buy_id, t.account_id, t.date, t.notes AS memo, s.name AS security_name,
               t.gross_cents + t.commission_cents AS cents, t.is_reconciled, t.cleared_state
          FROM (SELECT b.*, ROW_NUMBER() OVER (PARTITION BY b.account_id, b.date, b.notes, b.gross_cents + b.commission_cents ORDER BY b.rowid) AS nth
                  FROM transactions b
                 WHERE b.activity = 'buy' AND b.is_void = 0 AND b.funding_txn_id IS NULL
                   AND b.notes IN ('TSP Traditional payroll deferral',
                                   'TSP Agency Match employer contribution',
                                   'TSP Agency Automatic 1% employer contribution',
                                   'TSP loan repayment withheld from payroll')) t
          JOIN securities s ON s.id = t.security_id
         WHERE NOT EXISTS (SELECT 1 FROM transactions c WHERE c.id = 'ctb-' || t.id)
           AND t.nth > (SELECT COUNT(*) FROM transactions c
                         WHERE c.account_id = t.account_id AND c.date = t.date
                           AND c.activity IS NULL AND c.is_void = 0
                           AND c.amount_cents = t.gross_cents + t.commission_cents
                           AND (c.payee = t.notes OR c.notes = 'Contribution — ' || s.name));

        -- The category only when there is something to file under it: a
        -- fresh file must stay EMPTY here, or the standard chart is never
        -- seeded into it (the seed runs only into an empty categories table).
        INSERT INTO categories (id, name, kind)
        SELECT lower(hex(randomblob(16))), 'Retirement Contributions', 'income'
         WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name = 'Retirement Contributions' COLLATE NOCASE AND parent_id IS NULL)
           AND EXISTS (SELECT 1 FROM ctb_todo);

        -- The cash row's id is the buy's id with a prefix, so running this
        -- again writes nothing, and the buy points at it as its funding row
        -- (§71), so deleting the buy takes the deposit with it.
        INSERT INTO transactions (id, account_id, date, payee, category_id, amount_cents, is_reconciled, notes, cleared_state)
        SELECT 'ctb-' || buy_id, account_id, date, memo,
               (SELECT c.id FROM categories c WHERE c.name = 'Retirement Contributions' COLLATE NOCASE AND c.parent_id IS NULL LIMIT 1),
               cents, is_reconciled, 'Contribution — ' || security_name, cleared_state
          FROM ctb_todo;

        UPDATE transactions SET funding_txn_id = 'ctb-' || id
         WHERE id IN (SELECT buy_id FROM ctb_todo);

        UPDATE accounts SET balance_cents = (
            SELECT COALESCE(SUM(t.amount_cents), 0) FROM transactions t
             WHERE t.account_id = accounts.id AND t.is_void = 0)
         WHERE id IN (SELECT DISTINCT account_id FROM ctb_todo);

        DROP TABLE ctb_todo;
        "#,
    ),
    (
        "0045",
        "attachments",
        r#"
        -- §170: a receipt, a statement, a photo, attached to a transaction or
        -- to an account. The bytes live IN the file, so they are encrypted
        -- at rest and carried by every backup (VACUUM INTO copies them) with
        -- no new machinery; the price is that a backup grows with them.
        --
        -- Two tables, not one: the bytes in their own table with no foreign
        -- key, the link -- what it is attached to, its name and type -- in a
        -- small row that cascades with its transaction or account and that
        -- undo photographs. Undo never photographs the bytes: a row that
        -- was cascaded away by a delete comes back pointing at bytes that
        -- are still there, and bytes nothing points at are swept when the
        -- file is next opened, once the undo history has been let go.
        CREATE TABLE IF NOT EXISTS attachment_blobs (
            id   TEXT PRIMARY KEY,
            data BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS attachments (
            id             TEXT PRIMARY KEY,
            blob_id        TEXT NOT NULL REFERENCES attachment_blobs(id),
            transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
            account_id     TEXT REFERENCES accounts(id) ON DELETE CASCADE,
            name           TEXT NOT NULL,
            mime           TEXT NOT NULL,
            size_bytes     INTEGER NOT NULL,
            added_at       TEXT NOT NULL DEFAULT (datetime('now')),
            CHECK ((transaction_id IS NULL) <> (account_id IS NULL))
        );
        CREATE INDEX IF NOT EXISTS idx_attachments_transaction ON attachments(transaction_id);
        CREATE INDEX IF NOT EXISTS idx_attachments_account ON attachments(account_id);
        "#,
    ),
    (
        "0046",
        "payee_rule_conditions",
        r#"
        -- §171: a rule can look at more than the payee text. Amazon under
        -- $20 is Books and over it is Household; "TRANSFER" in checking is
        -- one thing and in the card account another; a memo can say what a
        -- payee does not. Every condition is optional; NULL means "any", so
        -- every rule already in the file means exactly what it meant.
        --
        -- The unique index on the match text goes with it: two rules on the
        -- same text that differ in their conditions are the point. Exact
        -- duplicates are refused in code instead.
        ALTER TABLE payee_rules ADD COLUMN min_cents INTEGER;
        ALTER TABLE payee_rules ADD COLUMN max_cents INTEGER;
        ALTER TABLE payee_rules ADD COLUMN memo_contains TEXT;
        ALTER TABLE payee_rules ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;
        DROP INDEX IF EXISTS idx_payee_rules_match;
        CREATE INDEX IF NOT EXISTS idx_payee_rules_match ON payee_rules(lower(match_text));
        "#,
    ),
];

/// Apply all pending migrations to `conn`. Returns the number applied.
pub fn migrate(conn: &mut Connection) -> Result<usize, rusqlite::Error> {
    migrate_with(conn, MIGRATIONS)
}

/// `migrate`, over an explicit list — so a test can hand it a migration that
/// fails halfway and prove the file is not wedged afterwards.
pub fn migrate_with(
    conn: &mut Connection,
    migrations: &[(&str, &str, &str)],
) -> Result<usize, rusqlite::Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version    TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )?;

    let mut applied = 0usize;
    for (version, name, sql) in migrations {
        let done: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?1)",
            rusqlite::params![version],
            |row| row.get(0),
        )?;
        if done {
            continue;
        }
        // Each migration and its ledger row commit together, or not at all.
        //
        // They used to be two separate autocommit statements. A migration
        // that failed halfway (0014 is eleven statements; 0019 creates two
        // tables and copies rows) left the schema partly changed with no
        // ledger row, so the next open ran the same SQL again from the top
        // and died on "duplicate column" — every time, forever. A wedged
        // file, from one interrupted write.
        //
        // Foreign keys are switched off OUTSIDE the transaction, because
        // `PRAGMA foreign_keys` is a no-op inside one — which is why the
        // `PRAGMA foreign_keys = OFF` lines written into 0009, 0014 and 0015
        // would now do nothing on their own. The table rebuilds they guard
        // (DROP TABLE accounts with FKs on would cascade-delete every
        // transaction) are protected here instead, and `foreign_key_check`
        // before the commit proves nothing dangling was left behind.
        conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
        let result = (|| -> Result<(), rusqlite::Error> {
            let tx = conn.unchecked_transaction()?;
            // Only violations the migration CREATED count. A file that already
            // carries a stray reference from years ago must still migrate —
            // refusing it here would refuse to open the user's database.
            let before = fk_violations(&tx)?;
            tx.execute_batch(sql)?;
            let after = fk_violations(&tx)?;
            // Compared as counts per (table → parent), not per row: a table
            // rebuild (0009, 0015) renumbers rowids, and an old stray row
            // must not look new just because it moved.
            if let Some((v, _)) = after
                .iter()
                .find(|(k, n)| before.get(*k).copied().unwrap_or(0) < **n)
            {
                return Err(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY),
                    Some(format!(
                        "migration {version} ({name}) left a dangling foreign key: {v}"
                    )),
                ));
            }
            tx.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (?1, ?2)",
                rusqlite::params![version, name],
            )?;
            tx.commit()
        })();
        let restore = conn.execute_batch("PRAGMA foreign_keys = ON;");
        result?;
        restore?;
        applied += 1;
    }
    Ok(applied)
}

/// What `PRAGMA foreign_key_check` reports, counted per `table->parent`.
fn fk_violations(
    conn: &Connection,
) -> Result<std::collections::BTreeMap<String, usize>, rusqlite::Error> {
    let mut st = conn.prepare("PRAGMA foreign_key_check")?;
    let rows = st.query_map([], |r| {
        Ok(format!("{}->{}", r.get::<_, String>(0)?, r.get::<_, String>(2)?))
    })?;
    let mut out = std::collections::BTreeMap::new();
    for key in rows {
        *out.entry(key?).or_insert(0) += 1;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn versions(conn: &Connection) -> Vec<String> {
        let mut st = conn
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .unwrap();
        st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    fn has_table(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [name],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
            > 0
    }

    #[test]
    fn a_migration_that_fails_halfway_leaves_nothing_behind() {
        // The failure mode this guards against: half a migration applied, no
        // ledger row, and every later open re-running the same SQL into
        // "duplicate column" / "table already exists" — forever.
        let mut conn = Connection::open_in_memory().unwrap();
        let good = ("0001", "good", "CREATE TABLE t1 (x INTEGER);");
        let bad = ("0002", "bad", "CREATE TABLE t2 (x INTEGER); INSERT INTO t2 VALUES (1); INSERT INTO nope VALUES (1);");
        let err = migrate_with(&mut conn, &[good, bad]).expect_err("0002 must fail");
        assert!(err.to_string().contains("nope"), "{err}");
        assert!(has_table(&conn, "t1"));
        assert!(!has_table(&conn, "t2"), "the failed migration's table survived");
        assert_eq!(versions(&conn), ["0001"]);

        // Fix the migration; the next open applies it cleanly.
        let fixed = ("0002", "fixed", "CREATE TABLE t2 (x INTEGER); INSERT INTO t2 VALUES (1);");
        let n = migrate_with(&mut conn, &[good, fixed]).expect("second run");
        assert_eq!(n, 1);
        assert!(has_table(&conn, "t2"));
        assert_eq!(versions(&conn), ["0001", "0002"]);
    }

    #[test]
    fn a_migration_that_leaves_a_dangling_foreign_key_is_refused() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        let bad = (
            "0001",
            "dangling",
            "CREATE TABLE parent (id INTEGER PRIMARY KEY);
             CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
             INSERT INTO child VALUES (1, 99);",
        );
        let err = migrate_with(&mut conn, &[bad]).expect_err("must be refused");
        assert!(err.to_string().contains("dangling"), "{err}");
        assert!(!has_table(&conn, "child"));
        // And foreign keys are back on for whoever uses the connection next.
        // (A violation that was ALREADY in the file, by contrast, must not
        // block later migrations — see the next test.)
        let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(fk, 1);
    }

    #[test]
    fn migration_versions_are_unique_and_ordered() {
        let mut seen = std::collections::BTreeSet::new();
        let mut last = String::new();
        for (v, _, _) in MIGRATIONS {
            assert!(seen.insert(*v), "duplicate migration version {v}");
            assert!(*v > last.as_str(), "migration {v} is out of order");
            last = v.to_string();
        }
    }

    #[test]
    fn a_pre_existing_violation_does_not_block_later_migrations() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;
             CREATE TABLE parent (id INTEGER PRIMARY KEY);
             CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
             INSERT INTO child VALUES (1, 99);",
        )
        .unwrap();
        let harmless = ("0001", "harmless", "CREATE TABLE t1 (x INTEGER);");
        migrate_with(&mut conn, &[harmless]).expect("an old stray reference is not this migration's fault");
        assert!(has_table(&conn, "t1"));
    }
}
