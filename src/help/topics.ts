// The Help tab's content (§62). Plain text in a small markdown subset,
// rendered by HelpView: `# ` heading, `## ` sub-heading, `- ` bullet,
// `> ` tip, **bold**, `code`, and [[topic-id|Link text]] to another topic.
// Every topic is searchable by title and body. Keep what is written here
// true to what the app does — a help page that describes a feature the
// app lacks is worse than none.

export interface HelpTopic {
  id: string;
  group: string;
  title: string;
  /** Short line under the title in the topic list. */
  blurb: string;
  body: string;
}

export const HELP_GROUPS = ["Getting started", "Banking", "Bills and budget", "Investing", "Reports and taxes", "Planning", "Tools and settings"] as const;

export const HELP_TOPICS: HelpTopic[] = [
  // ------------------------------------------------------------ Getting started
  {
    id: "welcome",
    group: "Getting started",
    title: "Welcome to T-Money",
    blurb: "What the program is, how it is laid out, and where your data lives.",
    body: `
T-Money is a personal-finance program in the shape of Microsoft Money Plus: accounts with registers, categories, scheduled bills, budgets, investments with lots, reports, tax lines, savings goals and a debt planner — all in one encrypted file on this computer. Nothing is sent anywhere.

# The window

- **Tabs across the top** — Home, Banking, Bills, Reports, Budget, Investing, Planning, Taxes, and this Help. The gear opens [[settings|Settings]]; the box at the right is [[search|Search]].
- **The left rail** lists your accounts and the common pages under each tab. Drag its edge to make it wider or narrower.
- **Home** shows your favorite accounts, the month's spending against budget, and your subscriptions. See [[home|The Home tab]].

# Your data

Everything is in one SQLite file protected with SQLCipher. The key is kept in the Windows credential store, so the file opens without a password on this machine; Settings shows where the file is, its size, and lets you back it up and reveal the key for use on another machine. See [[settings|Settings, backup and the master key]].

# Where to begin

- Coming from Microsoft Money: [[import-export|Import and export]] explains getting your accounts out of Money as QIF and in here.
- Starting fresh: Banking → **Add a new account**, then enter transactions in its [[register|register]].
- Money is entered in cents and stored as whole cents; there is no rounding drift anywhere.
`,
  },
  {
    id: "home",
    group: "Getting started",
    title: "The Home tab",
    blurb: "Favorite accounts, the Spending Tracker and the Subscriptions card.",
    body: `
# Favorite Accounts

Accounts you have starred (the ☆ beside an account in Banking) are pinned here with their balances. Click one to open its register. To put them in the order you want, use **Favorites → Organize favorites…** and the ▲ ▼ beside each account: that order is the order everywhere — here, in the account bar on the left, in the Favorites menu, and in the Account List. An account you have never moved sorts after the ones you have.

# Spending Tracker

Each budgeted category for the month with a bar showing how much of the budget has been spent — red once it is over. Use **◀ ▶** in the card's title to look at other months and **Today** to come back. Click a line to open the **Transactions by Category** report for that category and month, so you can see exactly what was spent. Budgets are set on the [[budget|Budget tab]].

# Subscriptions

Charges that come back on a schedule at a steady amount — streaming services, memberships, insurance, utilities — with what they cost per year, when the next one is expected, and a fold-out list of ones that seem to have stopped. Details, and how to choose which accounts it watches, are in [[subscriptions|Subscriptions and recurring charges]].

A charge you already know about — the mortgage, the car payment — is not a reminder: the small **×** at the end of its line puts it on the card's ignore list, and it drops out of the card and the per-month total. It stays in the full report, and the cash forecast on the Bills tab still projects it — the money still leaves. **N ignored** at the foot of the card lists them, each with **watch again**. The list is kept in the data file.
`,
  },
  {
    id: "files",
    group: "Getting started",
    title: "T-Money files",
    blurb: "Your money lives in a file you chose, named what you called it. Opening, creating and closing one.",
    body: `
The **File** menu treats your money as a document, because that is what it is.

# Where it lives

Out of the box, in T-Money's own folder under AppData\\Roaming. That is a perfectly good place for it — but it is not the only one, and File → **New T-Money file…** lets you put a file anywhere and call it anything: Household.tmny, Rentals.tmny, Rental property.tmny. Each file has its **own master key** in the Windows credential store, so one file's key never opens another.

**Open a T-Money file…** (Ctrl+O) switches to another one, and **Recent files** lists the last eight. A file that has gone missing is shown marked rather than quietly dropped — a database that has vanished is the most useful thing that list can tell you. "Remove the missing ones from this list" clears them once you have looked.

**Close file** closes it. No file is then open: the window shows a start screen offering the file you just closed, **Open a file…**, **New file…** and your recent ones, and the title bar says "no file open". Nothing has been changed or lost — the file is on disk exactly as you left it, and closing it also releases the lock on it, which is what lets you move, copy or back up the file while T-Money is still running.

Everything that needs a file is unavailable until one is open, which is most of the program. That is the point: with no file open there is exactly one thing to do, and the screen says what it is.

The name of the file you are in is in the **window title**, which is what the taskbar and Alt-Tab read from — and the moment you need it is when two are open.

# Opening one from Explorer

A .tmny file belongs to T-Money once you have installed it, so double-clicking one opens it. If T-Money is already running it does not start a second copy: the running one switches to that file. Two copies writing one file is how a database gets corrupted, and the program will not do it.

# When a file will not open

A **banner across the top** names the file and the reason, and T-Money opens its own file instead. The usual reasons are that the file has moved, or that it was made on another computer and its master key is not in this one's credential store. Nothing is lost — put the file back, or bring its key across (Settings → Security → Master key), and open it again.

A file you opened once can never stop the program starting. That is deliberate: it tries, and a failure is a message rather than a dead window.
`,
  },
  {
    id: "search",
    group: "Getting started",
    title: "Search",
    blurb: "Find a transaction by payee, memo, amount or number from any tab.",
    body: `
Type in the box at the top right and press Enter. Search looks through every account's transactions for the words you typed in the payee, memo, category, check number and amount, and lists the hits with their account and date. Click a hit to open that account's register with the row selected and scrolled into view.

> Searching for an amount works with or without the dollar sign: \`45.33\` finds a $45.33 payment or deposit.
`,
  },
  {
    id: "shortcuts",
    group: "Getting started",
    title: "Keyboard shortcuts",
    blurb: "Keys that work in the register and its forms.",
    body: `
# In a transaction form

- **Tab** moves through the fields in Money's order: Num, Date, Payee, Payment, Deposit, Category, Memo.
- **Enter** saves the transaction. Inside the Category field, Enter picks the highlighted category first; press it again to save.
- **Esc** closes the form without saving.
- **+** in the Num field fills in the next check number. See [[register|The account register]].
- In the **Date** field, **+** and **−** step a day and **T** is today.
- **↓ ↑** in the Category field move through the matches; Tab takes the highlighted one and moves on.
- The **Payee** field completes from the payees you have used: type a few letters, the best match is highlighted, and **Tab** or **Enter** takes it. A new name is typed straight through — the list is an offer, not a rule.

# In the register

- **Click** a row to select it; **click it again** or **double-click** to edit it. **Right-click** for the row's menu (void, cleared, tax line, delete).
- **↓ ↑** move the selection up and down the register, in the order the rows are on screen. They stop at the ends rather than wrapping. While a transaction form is open — or the caret is in any field — the arrows belong to whatever you are typing in, not to the list.
- **Ctrl+M** marks the selected row cleared, or uncleared.
- **Enter** or **Space** on the entry line at the bottom starts a new transaction.

# Anywhere

Every one of these is printed beside its own menu item, which is where they
are bound — the menu bar is the list, and this page repeats it.

- **Ctrl+N** starts a new transaction. (File → New)
- **Ctrl+O** opens a T-Money file. (File)
- **Ctrl+P** prints what is on screen. (File)
- **Ctrl+Z** undoes the last transaction you added, edited, deleted, voided or split; **Ctrl+Y** does it again. The Edit menu names what it will undo. (Edit)
- **Ctrl+X**, **Ctrl+C**, **Ctrl+V** cut, copy and paste. (Edit)
- **Ctrl+F** jumps to the search box — except with an account register open, where it opens **Find** over that register (any field, or one you choose; a click selects the row behind the window and closing it leaves that row selected), and on the Budget tab, where it goes to *Find a category on this page* and finds a budget line rather than a transaction; **Ctrl+H** is find and replace. (Edit)
- **Del** deletes the selected transaction. (Edit)
- **Ctrl+M** marks the selected row cleared, or uncleared. (Edit → Mark as cleared)
- **Ctrl+K** opens the calculator. (Tools)
- **F1** opens Help for the tab you are on.
- **Alt+F4** closes T-Money.
- **Alt** and a menu's underlined letter opens that menu; **Esc** closes it.
`,
  },

  // ------------------------------------------------------------ Banking
  {
    id: "accounts",
    group: "Banking",
    title: "Accounts",
    blurb: "Adding, editing, favoriting, closing and merging accounts.",
    body: `
Banking → **Account List** shows every account with its balance, grouped by kind: bank and cash, credit cards, investments and retirement, loans and mortgages, property. Closed accounts are hidden until you check **Show closed accounts**; each opens to its register with its transactions and transfers as they were.

# Adding an account

Click **Add a new account**. Give it a name, choose its type (checking, savings, cash, credit card, investment, retirement, loan, mortgage, home/asset) and an opening balance dated when your records start. Investment and retirement accounts get an investment register (see [[investing|Investment accounts]]); everything else gets the bank register.

# Account details

Use **Details** beside an account in the Account List to record the institution, account number, routing number, opening date, credit limit, contact details, website and notes. A **closed** account keeps its history but drops out of the pickers and the rail.

# Favorites

The ☆ beside an account pins it to the Home tab's Favorite Accounts card.

# Merging duplicate accounts

If the same account was created twice (a common result of importing), **Merge** folds one into the other: every transaction moves across, transfers between the two collapse, statements, scheduled bills and goals are re-pointed, and rows that already exist on the survivor with the same date, amount and payee are skipped rather than doubled. The dialog shows exactly what will move before you confirm. There is no undo other than a backup, so read the summary.

# Tax information

Whether an account's activity feeds the tax reports is set on the [[taxes|Taxes tab]] ("Accounts included in tax information").
`,
  },
  {
    id: "register",
    group: "Banking",
    title: "The account register",
    blurb: "Entering, editing, voiding and clearing transactions; the entry line; check numbers.",
    body: `
Open an account from the rail or the Account List. The register lists transactions oldest first with a running balance, and opens scrolled to the bottom where the newest ones are.

# Entering a transaction

> **Trying the app out?** **File → New → Sample file with demo data…** makes a brand-new file with three years of invented accounts, transactions, bills, budgets and investments in it — twelve accounts including a line of credit paid as a split, a closed account, a 401(k) with employer matches and a rebalance, rename rules, attachments, a few raw bank-text rows to file, and charges for the forecast to notice — enough for every screen and every report to have something to show. It can only ever create a new file; nothing you already have is touched, and none of the data in it belongs to anybody.

Click the **entry line** at the bottom (today's date, "Click here to enter a transaction"), click **New**, or click any empty row. The form opens in place:

- **Num** — a check number, or a marker like ATM or EFT. Free text. Type **+** to fill in the next check number (one past the highest in this account). After you enter a check, the next new transaction offers the following number automatically; delete it if the next one is a card swipe, and the offer stops until you write another check.
- **Date** — where the caret starts on a new transaction, because it is the one field that arrives as a guess. Type it: \`8/3\`, \`8/3/26\` or \`8/3/2026\` all work; **+** and **−** step a day, **T** is today, and the small ▾ opens a calendar. A new transaction starts on the date of the last one you entered, so a stack of receipts goes in without retyping the date — Tab straight past it when it is already right. Opening a transaction that already exists starts in the Payee instead.
- **Payee** — offers the payees you have used before. A new name is added to the payee list when you save.
- **Payment / Deposit** — dollars and cents in one or the other.
- **Category** — type any part of a name to filter: \`fuel\` finds "Automobile : Fuel". Type **Parent : Child** to reach a subcategory directly; the spaces around the colon and the capitals do not matter, so \`loan:heloc\` finds "Loan : HELOC" and Tab takes it rather than offering to add a second one. If what you typed does not exist, choose **+ Add …** and the new category is created without leaving the transaction; typing an existing parent and a new child ("Other Income : Garage Sale") adds the subcategory straight under that parent. To move money to another account choose **Transfer : (account)** in the same list — see [[splits-transfers|Splits, transfers and goals]].
- **Memo** — notes; shown as the row's tooltip.
- **Split** — divide the amount across several categories. See [[splits-transfers|Splits, transfers and goals]].
- **Common transactions** — save the filled-in form as a named template (rent, the grocery run) and reuse it from the same menu.

Press **Enter** to save, **Esc** to cancel — or just click another row: a changed form is saved on the way out, and one that cannot be saved stays open and says why. Check **Show transaction forms** to have the form open whenever a row is selected. Each row shows its category (or the transfer's other account) and memo in gray after the payee.

# Editing, voiding, deleting

**Enter** on a new transaction saves it and opens the next one with the caret in the Date — today, or the last date you entered — so **Tab** goes straight on to the Payee when the date is already right; **Esc** closes an entry you do not want. Enter on an existing row just saves it.

Click a selected row again (or double-click, or **Edit**) to change it. Give a category to a row that had none and the register offers to file that payee the same way from now on — **Remember** makes a rename rule (see Payees).

**Attachments.** Open a transaction and click **Attachments** to keep a receipt, a photo of the check, or any file with it; a row that has one shows 📎 in the register. **Attach a file…** opens the file picker (several at once is fine); click a name, or **Open**, to open it with whatever your computer uses for that kind of file; **Save as…** writes a copy where you choose; **Remove** takes it off (Ctrl+Z puts it back). A statement belongs on the account: Banking → Accounts → **Change details** has the same panel. The bytes are kept inside your T-Money file — encrypted with everything else, and carried by every backup, so a backup grows with them. Files up to 25 MB. Right-click a row for **Void** (the row stays, struck through, and counts for nothing), **Mark as cleared** (Ctrl+M), **Tax line…** (see [[taxes|Taxes]]) and **Delete**; the **Delete** button below the register removes the selected row outright. A transfer edited on either side moves both halves.

# Views

**View** narrows the list — all transactions, unreconciled (optionally grouped into Deposits, Checks and Other Withdrawals the way Money's balancing view does), uncleared, uncategorized, transfers only, voided — **covering** a date range, **sorted by** date, payee, amount, Num or entry order. The one-line description to the right says what you are looking at. The Balance column only reads in date order, so it is blank under the other sorts.

# Balancing

**Balance this account** starts reconciling against a statement. See [[reconcile|Balancing (reconciling) an account]].
`,
  },
  {
    id: "undo",
    group: "Banking",
    title: "Undo",
    blurb: "Taking back a transaction you added, edited, deleted, voided or split.",
    body: `
**Ctrl+Z** takes back the last thing you did to a transaction; **Ctrl+Y** does it again. The **Edit** menu names it — "Undo delete a transaction" — so you know what you are about to get back before you press it.

# What it covers

Transactions: **added, edited, deleted, voided**, and **splits changed**. A deleted transfer comes back as both halves, linked, with both balances right. A split that put a row in another account takes that row with it when you undo, and brings it back when you redo.

Applying the payee rules to existing transactions is one step too, however many rows it changed — see [[categories-payees|Categories and payees]]. So is **tagging with a classification**, and so are **merging, renaming and deleting a payee**.

**An import is one step.** Ctrl+Z takes out every transaction it added, in every account it touched — the answer to importing into the wrong account. Payees and securities it created stay in their lists, unused. See [[import-export|Import and export]].

The two ways of writing a transaction that are not typing one are covered as well:

- **Update value…** on a house, a vehicle or another asset. A mistyped appraisal is one Ctrl+Z, and if that value was dated in the past — so the next valuation after it absorbed the difference — undo puts that one back exactly as it was too.
- **Record payment…** on a loan. One press takes back the whole thing: the row in the account it was paid from, every one of its split lines, the principal (and any extra principal) off the loan and the escrow out of the escrow account.

# What it does not

Accounts and categories. Deleting an account takes every transaction in it, and something that consequential stays confirm-then-commit rather than becoming a thing you can shrug off. The menu says so by staying gray — an undo that quietly covers half of what you assume is worse than none.

# It is not a history

The stack lives in memory and is emptied when you close the program, and again whenever you open a different file. It is for the last few minutes, not for traveling back through a session you no longer remember. Doing something new also clears the redo side, because redoing into a history that no longer exists is how a deleted row comes back from the dead.
`,
  },
  {
    id: "splits-transfers",
    group: "Banking",
    title: "Splits, transfers and goals",
    blurb: "One transaction across several categories; moving money between accounts; counting a deposit toward a goal.",
    body: `
# Splits

Click **Split** in the transaction form to divide one payment across categories — a Walmart run that is part groceries, part fuel. Each line has a category, description and amount; the transaction's amount becomes the total of the lines and is set from them ("Set by the split lines — open the split to change it"). Reports count each line under its own category.

If you typed the amount first, the foot of the split shows the **transaction amount**, the lines' **total**, and the **difference** between them — 0.00 when the lines account for all of it. Done with lines that total something else changes the transaction amount to match, after asking; if the transaction has already been reconciled the question says by how much the next reconcile would be out. **Enter** is Done and **Esc** is Cancel, and a description completes from the ones you have used on earlier split lines. When the split closes the caret is back in the form, so Enter saves the transaction.

A split line can also be a **transfer**: the accounts are offered at the bottom of the same category field, as **Transfer : (account)**. That is how one entry becomes a paycheck — salary in, tax out, and the part that went straight to savings — with the savings row written and linked for you. Undoing the split takes that far row with it.

# Transfers

Choose **Transfer : (account)** in the Category field. One transfer writes two linked rows — money out of this account, money into the other — and either side can be edited or deleted; the other follows. Transfers are not income or spending, so they never appear in the category and payee reports.

A transaction that is already in the register can become a transfer the same way: open it, choose **Transfer : (account)**, Enter. The row in the other account is written and linked for you, and this row keeps its date, Num, memo and cleared mark — which is how a bank download that only said "Transfer" is pointed at the account it actually went to. The reverse works too: give a transfer a category and it becomes an ordinary transaction, and the other account's row goes. Both can be undone.

A scheduled transfer (a monthly move to savings, a 401(k) contribution) is set up on the [[bills|Bills tab]] with Direction **Transfer to…**.

# Goals

If a [[goals|savings goal]] watches an account, a deposit or transfer into that account shows a **For goal** field; pick the goal and the row counts toward it (a ⚑ tag appears on the row). The goal's progress is the sum of the rows tagged to it.
`,
  },
  {
    id: "reconcile",
    group: "Banking",
    title: "Balancing (reconciling) an account",
    blurb: "Matching the register to a statement, and updating holdings from a brokerage statement.",
    body: `
Click **Balance this account** in the register. Enter the statement's ending date and ending balance (the starting balance is carried from the last statement). The register switches to the unreconciled view, grouped into Deposits, Checks and Other Withdrawals, with a **Balance Account** strip above it showing the difference as you go.

- Check the **C** column (or press Ctrl+M, or the **Mark cleared** button) on each row that appears on the statement — a row that is open for editing has the same C cell in its form. The difference in the strip reaches **0.00** when everything matches.
- Rows that clear automatically are noted above the grid, so you can see what the program did for you.
- **Finish** marks the cleared rows **R** (reconciled) and files the statement. Reconciled rows drop out of the unreconciled views and the next balancing starts from this ending balance.
- **Postpone** throws the statement header away; cleared marks stay so you can pick up later.

Every account type balances the same way, including investment and retirement accounts.

# Reconciling by hand

History brought in from another program is usually already balanced, so the old months need no statement. Right-click a transaction → **Mark as reconciled** sets that one row to R. **Mark reconciled through…** beside Balance this account does it for every transaction on or before a date you choose: **Count** shows how many rows it would touch before anything is written, rows already R and voided rows are left alone, and the next Balance starts from that date. Check the count against what you expect — it is deliberately not automatic.

# Investment accounts: Update from statement

An investment register also has **Update from statement**: type each holding's shares (and price or value) as printed on the statement and the program works out the buys, sells or adjustments needed to make the register match, showing them before anything is written. See [[investing|Investment accounts]].
`,
  },
  {
    id: "categories-payees",
    group: "Banking",
    title: "Categories and payees",
    blurb: "The category tree, standard categories, tax lines, and tidying payees.",
    body: `
# Categories

Budget → **Categories** lists every category as Income or Expense, with its subcategories. You can add, rename, re-parent, merge and delete categories; deleting one that is in use asks which category should take its transactions. **Standard categories** adds Money's default set to a new file in one go. Each category can carry a **tax line** (see [[taxes|Taxes]]).

Category names are unique per parent, so "Repairs & Maintenance" can exist under both Automobile and House.

# Payee rename rules, and running them backwards

Your bank writes "NETFLIX.COM 866-579-7172 CA"; you want it to say Netflix. Banking → Payees → **Payee rename rules** holds one rule per pattern — match text, the name to use, and optionally a category. Rules run on every import from then on.

Tools → **Rename payees in existing transactions…** runs them over what is already in the file. It shows every row it would change first, grouped by the rule that claimed it, with what each says now and what it would say. Uncheck any row, or a whole rule's worth at once. That grouping is the point: a surprising row is nearly always a rule matching more widely than you meant, and seeing all of one rule's rows together is the fastest way to notice.

It lands on the undo stack as **one step**, so Ctrl+Z takes the whole batch back. Two things it will not do: touch transfers, investment activity or revaluations, and overwrite a category you chose yourself — a rule only ever FILLS IN a category that is empty.

# Payees

Bills → **Payees** lists everyone you have paid or been paid by, with how often. Rename a payee to change it on every transaction, or **Merge** two spellings ("NETFLIX.COM" and "Netflix") into one — reports, and the Subscriptions card, group by the payee name, so tidy names make better reports.

**Rename rules** (top of the Payees page) do that tidying for you. A rule says: when a downloaded payee *contains* this text, call it this — and file it under this category when the download gave none. "NETFLIX" → Netflix; "AMAZON" → Amazon; "AMAZON PRIME" → Amazon Prime (the longest match wins). A rule can also be narrowed to an amount range, a memo that contains some text, or one account — so "AMAZON" under $20 can be Books while "AMAZON" is Household, and the same card charge on the joint account can file differently from the one on yours. A rule with a condition outranks one without; the amount's sign is ignored, so a refund follows the same rule as the charge. Rules run on every import. **Apply to existing transactions** runs them over what is already in the file; a re-import of a file brought in before the rule existed is still recognized as duplicates.

**Rules learn from the register.** When you give a category to a transaction that had none — an import the rules did not recognize — the register asks *File every "…" under … from now on?* with a **Remember** button. Remember makes a rule for that exact payee text; open Payees to broaden it to part of the name or add a condition. No offer is made when a rule already covers the payee, or for transfers and splits.

**Find duplicates…** on a register lists rows with the same payee and amount on the same day, or within a few days, which is what overlapping downloads leave behind when the file carried no bank ids. Each set shows what tells the copies apart — cleared mark, category, memo, check number, bank id — and you delete the one that is the copy. Nothing is deleted without a click.
`,
  },

  {
    id: "classifications",
    group: "Banking",
    title: "Classifications",
    blurb: "The second tag: what money was FOR, beside what kind of spending it was.",
    body: `
A category says what KIND of money something is — Repairs, Utilities, Insurance. A **classification** says what it was **for**: which house, which vehicle, which person, which project. The two are independent, which is the whole point: without one, answering “what did the lake house cost me last year” means either a category for every combination (Repairs : Lake house, Utilities : Lake house, Insurance : Lake house…) or a convention in the memo field that no report can add up.

# Making one — the question, then the answers

**A classification is the question; its values are the answers.** Make one called **Property** and put each address in it as a value — not one classification per address. Two or three questions (Property, Person, Project) is the usual whole setup, however many houses or people there are.

Budget → **Classifications**. Add the classification, then add its values. A value can have sub-values one level deep (“27 Birch Lane : Roof 2026”), and choosing the parent in a report takes its sub-values with it.

A classification with no values yet has nothing to choose, so its field in the register is grayed out and says so. If you find yourself with a classification named after one house, delete it — nothing is lost while nothing is tagged — and make **Property** with both addresses in it instead.

There is no limit of two, as Money had, and a classification or a value can be **deleted** even after it has been used: the confirmation says how many lines it will untag first. Those lines keep their category, amount and everything else — they simply stop being tagged.

# Tagging a transaction

The transaction form has one dropdown per classification, beside Memo. A transfer carries the same value on both halves, so it reads the same from either account.

**Split lines carry their own.** One Home Depot receipt, six thousand of it one house and three the other, is one transaction with two split lines and a different value on each — open **Split** and each line has its own column.

A value **in brackets** — “(same as the transaction — 27 Birch Lane)” — means the line has none of its own and follows the transaction: change the transaction and the line changes with it. Choosing a value on the line pins it there instead, whatever the transaction says. For a mortgage split into principal, interest and escrow, all for the same house, set it once on the transaction and leave the lines in brackets — that is one place to change it. Pin values on the lines when the lines are genuinely for different things.

The register row shows both, and marks which is which: **◆** is the transaction's own value, **◇** is what its split lines say. A mortgage split into principal, interest and escrow with all three lines tagged to one house shows ◇ and that house; lines that disagree show ◇ "2 values" rather than picking one. The field on the open transaction is the transaction's OWN value, so on a row like that it is empty on purpose — it says beside it what the lines carry.

Renaming a value never untags anything. The tag is to the value itself, so every transaction and split line that carried it simply shows the new name.

# Reporting on it

Two ways, and they compose:

- **Scope any report by one.** Customize → the classification's list picks values to include; “(not classified)” picks the lines carrying nothing on that axis. Values on different classifications narrow together (Lake house AND Alex); values on the same one widen (either house).
- **Group by one.** The **Classifications** group in the report gallery — Spending by classification, Transactions by classification, Classification by month, Classification by category, Classification comparison — groups on the classification chosen under Customize → Group by. The group appears once the file has a classification.

See [[reports|Reports]] and [[categories-payees|Categories and payees]].
`,
  },

  // ------------------------------------------------------------ Bills and budget
  {
    id: "bills",
    group: "Bills and budget",
    title: "Bills and deposits",
    blurb: "Scheduled bills, income and transfers; entering, skipping, the calendar and the cash forecast.",
    body: `
Bills → **Bills to Pay** holds your scheduled bills, deposits and transfers.

# A bill rule

- **Direction** — a bill (money out), a deposit (money in) or **Transfer to…** another account.
- **Payee**, **Amount**, **Account** it comes from, and the **Category** (or the account it transfers to, and optionally a **goal** it counts toward).
- **Repeats** — weekly, every two weeks, twice a month (with a second day), monthly, every N months, quarterly, yearly, or once; **First due**; **Ends** never, on a date, or after N times.
- **Weekend rule** — leave a due date alone, or move it to the Friday before or the Monday after.

# Upcoming

The upcoming list shows each due occurrence with its status — due, overdue, entered, skipped. **Enter** writes the transaction into the register (a transfer writes both halves); **Skip** passes over one occurrence. A transaction entered by hand in the register with the same payee, amount and date range settles the occurrence automatically.

# List or Calendar

Switch to **Calendar** to see the month with each bill on its day, colored by status. Double-click a day to schedule something on that date; click a bill to open its rule.

# Cash forecast

The chart projects the chosen account's balance over the coming weeks from its scheduled bills and deposits (both sides of a scheduled transfer count), and shows the lowest point, so an overdraft is visible before it happens. The **Scheduled bills** and **Upcoming bills and deposits** reports list the same rules.

It also projects the **recurring charges T-Money has noticed** in that account — the same ones the Home page's Subscriptions card finds: a payee charged on a steady schedule at a steady amount over the last two years. Each is projected from its last charge forward, a monthly one on the same day of the month, and listed under the chart with its next date so a projection can be traced to the charge behind it. A payee that already has a scheduled rule is left to the rule; one you have told the Subscriptions card to ignore is projected all the same and says so, because ignoring it there means "not a reminder", not "not a bill". The switch under the chart turns the noticed charges off, and the choice is kept with the file. A charge that comes on a schedule at a different amount each time — the power bill, the weekly groceries — is projected too, at a typical recent amount, and the list says *amount varies*; the Subscriptions card keeps to the steady ones. Two charges on one day count as that day's charge; a skipped bill (a gap of two cadences) does not break the pattern; and a payee billed twice a month is projected once a month at a typical recent month's total. A payee that already has a scheduled bill in the account is projected by the bill and named under the list instead, so nothing looks missed. What it cannot find: a pattern only a few months old (give that one a scheduled bill), and anything paid by transfer or from another account.
`,
  },
  {
    id: "level-pay",
    group: "Bills and budget",
    title: "Level Pay budgeting",
    blurb: "The method behind the year plan: every bill at its monthly rate, the reservoir it fills, and why the twelve columns roll.",
    body: `
T-Money's budget rests on one idea. It is worth having before the screens make sense, because it is not the idea most budgeting software has.

# The idea

Your income arrives monthly. Your bills do not. Insurance lands twice a year, property tax once, the water bill every other month, heating oil in the cold months. A budget that compares each month's income to that month's bills sees a $2,000 spike in July and eleven quiet months, and teaches you nothing except that July is bad.

**Level Pay** does what your gas company offers: it flattens every bill to its monthly rate. A $2,000 insurance bill is $166.67 a month, every month, whichever month the check goes out. Budget that, and every month looks like every other month — which is the only way to know whether you can actually afford your life, rather than whether you can afford July.

# The reservoir

Flattening a bill means saving for it. The $166.67 you set aside in January is still there in June, and in July the bill takes it. T-Money keeps that balance for you. On a line marked **Saved every month, paid in these months**, the last column is not a variance but a level — **saved so far, not yet spent**. Think of each such line as a reservoir: the monthly amount fills it, the bill drains it, and the figure is the water level. A negative level, shown as **short**, means the bill arrived before enough had gone in. That is normal in the first year of a plan and a real warning after it.

# Why this is unusual

Businesses budget this way, and almost no household tool does. An accountant would say T-Money **budgets on an accrual basis and records on a cash basis**: the monthly figure is the accrued cost, the July payment is the cash event, and the reservoir is a prepaid-expense balance. Envelope-budgeting apps have the saving discipline but refuse to project forward on principle; the classic desktop programs project forward but have no notion of accrual at all. The year plan does both, in one table, and that combination is what makes it work for a household whose bills are lumpy and whose income is not.

# The three readings of a line

Every line on the year plan has an annual figure, a set of months, and one of three readings:

- **Every month** — a twelfth a month, all year. Groceries.
- **Spent only in these months** — the money goes out in those months and nothing the rest of the year. Heating oil over the winter. The other months show a dash and count nothing against you.
- **Saved every month, paid in these months** — the Level Pay reading. A twelfth every month; the marked months are when the bill lands, and that month is marked rather than counted against you.

Uncheck a month on an expense and the line takes the third reading on its own, because for a household bill that is almost always the right guess. Income is left alone: money that arrives in four months is not money you save for.

# The rolling year

The twelve columns always show a figure. A month that has gone shows what actually happened. A month still ahead shows what is planned: the monthly figure, or the payment in a month the bill is due. A due month that has passed with nothing recorded shows the ordinary monthly figure, because you were still setting the money aside whatever the bill did. Next year is proposed from this one with **Build from history**. The plan is a living document, read and adjusted through the year, not a form filled in each January.

How the screens work is in [[budget|Budgets]].
`,
  },
  {
    id: "budget",
    group: "Bills and budget",
    title: "Budgets",
    blurb: "The year plan, where a budget is made, and This month, which reads it back; parents and subcategories; zero versus empty; finding a line.",
    body: `
Budget → **Year plan** is where a budget is made. **This month** is a reading of it. The thinking behind both is in [[level-pay|Level Pay budgeting]]; read that first if the year plan's columns look unfamiliar.

# The year plan

One row per category and twelve month columns. The three things you author are on the left — **Annual**, **Monthly** and **Spread over** — and everything to their right is read back to you.

Click an amount box and type; either box will do, and the other follows. Press **Tab** or **Enter** to keep it, **Esc** to abandon it. **Spread over** opens the months: check the ones the line runs in, and choose which of the three readings the line takes — every month, spent only in those months, or saved every month and paid in those months. The box underneath says in money what the choice does to the row before you make it.

The month columns show what actually happened in months gone and what is planned in months ahead; a projected figure is grayed, a due month is marked, and the current month is tinted. **So far** is the year to date. **vs plan** is a variance on an ordinary line — ahead or behind — and on a set-aside line a balance, marked **saved** or **short**. Hover any figure for the sentence behind it.

Income lines sit above expense lines. The strip across the top totals both and says what is left over, planned and so far.

# Parents and subcategories

A parent category is the envelope for everything under it, and its figure is never less than what its subcategories claim. Type $600 into Bills, budget $810 across its children, and Bills shows $810 — then settles back onto your $600 when they shrink. Budgeting a subcategory under a parent that has no plan gives the parent one, at the next whole ten above what the children claim, and the screen says so. A subcategory at 0.00 gives its parent a 0.00 too.

# Zero, and empty

Typing **0** is a plan of nothing: it is measured against, and it stays. **Emptying** the box is a different act — it removes the plan, the row goes blank, and This month stops showing it. Clearing a subcategory brings its parent back down to whatever you typed there, or clears the parent too if you never typed anything into it.

# Starting a year

**Build from history…** reads a year you have lived through and proposes the next: every line that year saw, with expenses rounded up to the next ten and income rounded down, so the year errs on the side of holding. Change anything, uncheck anything, then apply. Categories with nothing planned and nothing spent are hidden to keep the table short; check **Show every category** to list them all and type into any one.

# This month

**This month** shows the current month as the year plan wrote it, with what has been spent against each line and what is left. Nothing is typed here: a figure you want changed is changed on the year plan, and the row says so. Use **‹** and **›** to move between months and **This month** to come back. Click **▸** beside a parent to see its subcategories.

# Finding a line

**Ctrl+F** on either screen goes to **Find a category on this page**. It narrows the table to the categories whose names match what you type, planned or not, and opens the group it found them in. **Esc** clears it. With an account register open, Ctrl+F is Find in that register; everywhere else in T-Money it is the transaction search.

# Watching the budget

The Home tab's Spending Tracker compares the month's spending to these figures. The **Monthly budget** and **Annual budget** reports show budget against actual, by month and for the year.
`,
  },

  // ------------------------------------------------------------ Investing
  {
    id: "investing",
    group: "Investing",
    title: "Investment accounts",
    blurb: "The investment register, activities, lots, prices, and the Portfolio page.",
    body: `
An **investment** or **retirement** account has a register of investment activities alongside its cash. The Investing tab's **Portfolio** page shows every holding across accounts with cost, value and gain, and the **Return on investment** card gives the past month, year to date, twelve months and all time.

The **Performance** card has two pickers at its top right: the **account** (every investment account, or one — the whole TSP, say) and the **holding** (the whole of that, or one fund in it). So you can read the plan's return and then the S Fund's own return for the time you have held it. For each period the table shows the **start value**, the **money in** and **money out** during the period, the **end value**, and the **gain** — end value minus start value, minus money in, plus money out: what the investments themselves made once your own deposits and withdrawals are taken back out. For an account, value is the holdings at the day's price plus cash, and money in and out is what crossed into or out of the account — contributions, transfers, withdrawals; dividends and fees stay inside and are part of the gain. For one holding, value is its shares at the day's price, money in is what it cost to buy plus the value of shares moved into it, and money out is what selling it brought plus the value of shares moved out. A fund you move in and out of often will show money in and money out far larger than its balance, because every move counts; that is expected, and the gain and the returns are still right.

Two returns, because they answer two questions. **Time-weighted** is the investments' return, the way a fund or an index reports it: growth is measured between the days money moved and the pieces are chained, so a large deposit the day before a drop does not count against the fund. Compare it with the fund's published return or with an index. **Money-weighted** is *your* return: one yearly rate that accounts for when your money went in and came out. When most of the money arrived late and then fell, it is lower than time-weighted; when it arrived early and rose, higher. A worked example: $100 in January that grows 10% by August, then $3,800 more in August that falls 5% by September. Time-weighted chains +10% and −5% and reports about +4.5% — that is what the fund did. Money-weighted sees that nearly all the dollars were only there for the fall and reports a small loss — that is what you got. **Per year** figures, and the money-weighted rate, are shown only for periods of a year or more; a month's move made into a yearly rate is not a number to act on.

The **Allocation** card, and the **Asset allocation** report, show what kind of thing the money is in — stocks, funds, bonds, cash — by the type set on each security under **Securities…**. A security brought in by an import starts as Other until you say what it is.

A TSP contribution — payroll deferral, agency match, the automatic 1% — is money that never touched a bank. The TSP importer writes its deposit beside the buy (**Retirement Contributions**), so the plan's cash stays right and contributions are a number a report can show. A contribution imported earlier through the Import QIF dialog already has its deposit and is left as it is; one that came in bare gets its deposit the first time the file is opened.

# Activities

Buy, Sell, Dividend, Interest, long- and short-term capital gains distributions, the four **Reinvest** forms of those, Add Shares, Remove Shares, Return of Capital, and Split. A buy or sell exchanges cash for shares; a dividend adds cash; a reinvested dividend adds shares with no cash moving; a split multiplies the shares held. Cash entries (a deposit, a fee, a transfer) go in the same register as ordinary transactions.

# Paying from another account

A buy can be paid from another account (**Pay from**), and a sell's proceeds — or a dividend, interest or distribution paid in cash — deposited to one (**Deposit to**): the cash moves as a linked transfer written with the entry, so a dividend swept to checking is one entry, not a dividend plus a transfer. Open the transaction again to change or remove that account; the transfer is rewritten to match.

# Quantity, price and total

Type any two and the third is filled in, grayed. Type in the grayed field and it becomes yours too — a row can carry a price **and** a total that do not multiply out exactly, which is what a broker's confirmation looks like (the price to four or six decimals, the total to the cent); a note under the row says by how much, and nothing is blocked. The total is what the cash did; the price is what the shares were worth. Clear a field to have it derived again.

**A holding a penny off the statement** is almost always the broker's rounding, not a hidden decimal: 20.125 shares at $10.07 is $202.65875, which rounding gives as $202.66 and some brokers print as $202.65. Settings → Money → **Holding values** picks the broker's way. Retyping a price on a row (to six places, total left alone, Enter) is for when the price itself was rounded by the download; the row's price and the day's price in the history follow, the cost basis and the cash do not, and a fetched or typed price for that day in the security's price history outranks it.

# Symbols and prices

The Investing tab lists holdings by security. The **Symbol** column is where a symbol is set: click the symbol (or **add symbol** when there is none), type the ticker, press Enter. **Update prices** sends only those symbols.

Beside "Portfolio as of…" the page says **how old the prices are** — the oldest holding's newest price, since a total priced by one fresh symbol and two stale ones is stale — and turns red once anything is a week behind or has never been priced. A market value is only as current as the price under it.

Settings → Money → **Prices** chooses when prices are fetched: *Only when I ask* (the default — nothing leaves this machine until you press Update prices), *once a day* or *once a week* **while T-Money is open**. There is no background service and nothing runs while the app is closed; a scheduled run sends the same ticker symbols and nothing else, and a machine that was offline asks again the next day rather than every few minutes. The same field is under **Securities…** (Edit → Symbol). Money's QIF export carries no symbols, so an imported file whose securities are named by their tickers arrives with the names filled and the symbols blank — the import now copies a name that reads as a ticker (MUB, VTSAX, BRK.B) into the symbol, and **Use names as symbols** on the Securities panel does the same for a file imported before this. Securities with a descriptive name ("Vanguard Total Market") need the symbol typed in once.

# Dividends: paid, swept, or reinvested

- **Paid in cash and kept in the account** — enter a **Dividend**; the account's cash goes up.
- **Paid and swept to the bank** — enter a **Dividend** with **Deposit to** the bank account.
- **Reinvested** — enter a **Reinvest Dividend** with the shares bought and the price: the dividend is recorded as income and the shares are added, and no cash moves at all. That is the whole reinvestment in one line; do not also enter a Dividend, or the income is counted twice.
- A brokerage or cash-management account whose statement shows a dividend and its reinvestment as two lines that net to nothing is the third case: one **Reinvest Dividend** entry.

# Securities and prices

Pick a security by name or symbol; a new one can be created from the form. Prices are recorded by date — from a buy or sell, from a statement update, or typed on the Portfolio page — and the portfolio is valued at the latest price on or before the date asked.

# Lots

Every buy (or reinvestment, or Add Shares) opens a lot with its date, shares and cost. A sell closes shares from lots by the **Lot method** you choose in the form: first in first out, last in first out, highest cost first (smallest gain), lowest cost first (largest gain), or **Specify lots** to pick them by hand. The realized gain is worked out per lot and appears on the **Capital gains** report, split into short- and long-term.

# Moving shares between accounts

**Transfer shares** removes shares from this account and adds them to another with the original lots and cost carried across, so nothing is realized.

# Updating from a statement

**Update from statement** in an investment register takes the holdings as printed on a brokerage statement and works out the buys, sells or share adjustments needed to match, showing the list before anything is written. It is the quick way to catch up an account that is only reviewed quarterly. See also [[reconcile|Balancing an account]].
`,
  },

  // ------------------------------------------------------------ Reports and taxes
  {
    id: "reports",
    group: "Reports and taxes",
    title: "Reports",
    blurb: "The gallery, date ranges, Customize, favorites, drilling through rows, charts, printing and export.",
    body: `
Reports → **View a report** is a gallery in Money's groups: Income and expenses, Assets and liabilities, Investment, Taxes, Comparison. Click one to open it.

# The report page

- **Date range** at the bottom — this month, last month, quarters, year to date, previous year, last 12 months, last 2 years, last 30 or 90 days, all dates, or custom dates.
- **Change view: chart / table** swaps between the table and the chart.
- **Customize…** narrows the report and shapes it. The scope is the same on **every** report, not only the ones that happen to support it: **Accounts**, **Categories**, **Payees** (each list can be turned into a leave-these-OUT list), an **Amounts** range, **Status** (open, cleared, reconciled) and **Containing** — text in a payee or memo. With [[classifications|classifications]] in the file, each one gets its own list, including "(not classified)". The same panel picks **Securities** on investment reports and a **Benchmark** on Performance against a benchmark, sorts the **Rows** by Money's order, name or amount, folds small rows into "Other", sets the **Level of detail** on Net worth, chooses the **Chart** style, and on a Classifications report chooses which classification to **Group by**. Comparison reports take a second range to **Compare with**. When any filter is on, the rail says **Customize… (filtered)** and the line under the title says what was left out, so a number that looks wrong is explained rather than doubted.
- **Add to my favorite reports…** saves the report with its range and customization under a name of your own. Favorites open from the gallery; saving again while one is open updates it, and **Remove from my favorites** takes it off the list.
- **Print this report**, **Copy as CSV (for Excel)** and **Save as CSV file…** do what they say. A register prints too (**Print…** in its toolbar — the view as shown, every row, no buttons) and exports the same way (**Export CSV…**), and the Taxes tab has its own Print.

# Drilling through

Rows are links, as in Money, and so are the chart's bars, slices and legend entries. A category or payee row — or its bar or slice — opens a **quick look** — a small window listing that row's transactions for the same range, with its total; click a transaction there to open it in its register, or **Make this a report** to open that listing as a report of its own (Transactions by category, or by that payee), which can then be saved as a favorite. A month opens that month's Income and spending; a transaction row opens its register row; an account opens its register.

# Charts

The bar above the chart chooses the style — bar, stacked bar, horizontal bar, line, area, pie or doughnut (pie and doughnut need a single series) — and **3-D** switches Money-style depth on and off. Hovering a bar or slice shows its value; clicking one opens the quick look at its transactions, as clicking its row does; the choice is saved with a favorite. A chart of named things — categories, payees, accounts, holdings — reads largest to smallest; a chart along time keeps the calendar's order. See [[charts|Charts]].

# Which reports

- Spending by category / by payee, Monthly budget, Annual budget, Monthly income and expenses, Transactions by category / by payee, Account transactions, Income and spending (this month's report), Income and spending over time, [[subscriptions|Subscriptions and recurring charges]].
- Net worth, Credit card debt, Net worth over time, Account balances (with details), Account balance history, Scheduled bills, Upcoming bills and deposits.
- Portfolio value, Performance by holding, Capital gains, Investment transactions, Investment income, **Performance against a benchmark** — every holding's price movement over the range beside one security's, and the difference. Choose the security under Customize → Benchmark. It is a **price** return on the shares held on the range's first day, which is what makes it comparable with an index: money paid in or taken out during the range does not move it, and dividends are not in it. Performance by holding is still the report for what the money did.
- Spending by classification, Transactions by classification, Classification by month, Classification by category, Classification comparison — once the file has a [[classifications|classification]].
- Tax-related transactions, Tax summary by line.
- Spending by category / by payee comparison, Income and spending comparison.
`,
  },
  {
    id: "charts",
    group: "Reports and taxes",
    title: "Charts",
    blurb: "Chart styles, 3-D, and what each one is for.",
    body: `
Every report with a chart draws it from the same numbers as its table. Open the chart with **Change view: chart**, then choose a style from the bar above it:

- **Bar** — one bar per row (or per month); several series side by side.
- **Stacked bar** — series stacked into one bar per month, so income and spending, or several accounts, add up visibly.
- **Horizontal bar** — the same, turned on its side; best with many categories, since every label is readable.
- **Line** and **Area** — trends over time (net worth, balances, income and spending over time).
- **Pie** and **Doughnut** — shares of a whole, with the percentage on each slice; only for a single series.

**3-D** adds Money-style depth: lit and shaded faces on bars, an extruded pie, a shadow under lines. It is on by default and remembered with a favorite report. Hover any mark for its value; hover a legend entry to pick a series out.
`,
  },
  {
    id: "subscriptions",
    group: "Reports and taxes",
    title: "Subscriptions and recurring charges",
    blurb: "How the program spots subscriptions, and choosing which accounts it watches.",
    body: `
The **Subscriptions and recurring charges** report (Income and expenses group) finds payees you pay on a schedule at a steady amount. A payee counts when its charges come back at a regular interval — weekly, every two weeks, monthly, every two months, quarterly, every six months or yearly — and the amounts stay within about 20% of each other; a price rise still counts, a grocery store visited every week at different totals does not. Yearly and six-monthly charges need to have happened twice, which is why the report opens on the last two years.

Each line shows how often it bills, the amount, when it was last charged, when the next charge is expected, how many charges were found and the cost per year. **Active** ones (charged within the last cycle and a half) come first with per-month and per-year totals; ones that look to have **stopped** follow, so a canceled service can be checked off. Click a payee to open Transactions by payee.

# Which accounts

Left alone, the report watches the spending accounts — checking, savings, cash and credit cards — since a retirement or brokerage account has no subscriptions in it. To watch a different set, **Customize…** the accounts and **Add to my favorite reports…**: the Home tab's Subscriptions card runs your favorite of this kind (the first by name) and says so in its footnote. Without a favorite it uses the default set.

> Anything paid monthly at a fixed amount shows here — utilities, insurance, a loan entered as an expense rather than a transfer. That is deliberate: they are recurring charges too. Two spellings of one payee are two lines; merge them under Bills → Payees.
`,
  },
  {
    id: "taxes",
    group: "Reports and taxes",
    title: "Taxes",
    blurb: "Tax lines on categories and transactions, the tax year summary, and which accounts count.",
    body: `
The Taxes tab gathers what the tax return needs for the chosen **Tax year**.

- **Tax Line Manager** assigns a tax line (Schedule A charitable, Schedule B interest, Schedule C, 1099-DIV, and so on) to each category, and lists categories that have none. A transaction takes its category's line unless it has one of its own: right-click a register row → **Tax line…** to put that one transaction on a different line, or mark it not tax-related.
- **Tax-related totals** shows the year's income and deductions by line; **Investment income summary** and **Capital gains summary** come from the investment registers and lots.
- **Accounts included in tax information** — uncheck a Roth or a 401(k) and its dividends and sales stay out of the tax reports while still showing everywhere else. Reports opened from this tab carry the same scope.
- The **Tax-related transactions** and **Tax summary by line** reports list the detail behind the totals.
`,
  },

  // ------------------------------------------------------------ Planning
  {
    id: "goals",
    group: "Planning",
    title: "Savings goals",
    blurb: "Setting a goal on an account and watching it fill.",
    body: `
Planning → **Savings Goals**. A goal has a name, a target amount, an optional deadline, and the account it **watches**. Its progress is the money put into that account and tagged to the goal — a deposit or transfer with **For goal** chosen in the register, a scheduled transfer set to count toward it on the Bills tab, or a contribution recorded on the goal itself (date, amount, from which account). The goal shows what is saved against the target, the percentage, and the deadline.
`,
  },
  {
    id: "debt",
    group: "Planning",
    title: "Debt Reduction Planner",
    blurb: "Paying off cards and loans with one monthly budget; the one-debt mini planner.",
    body: `
Planning → **Debt Reduction Planner** lists every account that owes something (credit cards, loans, mortgages). Enter each one's **rate** and **minimum payment** — they are remembered in your file — and a **monthly budget** for all of them together.

- **Payoff order** — highest rate first pays the least interest; smallest balance first (the snowball) clears accounts sooner.
- The plan pays every minimum, puts the rest on the first debt in line, and rolls each payment on to the next as debts are paid off. It reports the debt-free month, total interest, and the month each debt ends; the timeline shows the balances month by month.
- If the budget is below the minimums, or never gets ahead of the interest, it says so in dollars.

# Mini planner

For one debt: give a monthly payment and see how many months and how much interest; or give a deadline and see the payment that meets it. **Show the schedule** lists every month's interest, principal and balance.

Interest is calculated the way a statement does it: the month's rate applied to the balance, in whole cents.
`,
  },

  // ------------------------------------------------------------ Tools and settings
  {
    id: "import-export",
    group: "Tools and settings",
    title: "Import and export",
    blurb: "Bringing accounts in from Microsoft Money or a bank (QIF, OFX) and exporting a register as QIF.",
    body: `
# The TSP (thrift savings plan)

File → Import → **TSP activity detail** takes the *Investment Activity Detail* CSV from tsp.gov and turns it into transactions, prices and holdings. Choosing that same file in the ordinary CSV importer opens this one instead, with the file already read — it is a .csv, but not one the column mapper can make sense of.

Two things about that file are worth knowing, because the importer is built around them. Its **ACCOUNT column is not an account** — it is the money source (Traditional, Match, Auto 1%, Roth), so one reallocation on one day is five rows; those are folded back into one transaction each. And the export **starts partway through the account's life**, so the position held before it begins is missing: it is worked out, not estimated, because every unit change in the file is known and the ending position is known. Once you choose the account, that opening position is checked against **what the account already holds** on that date, and only the shortfall is written — a second export that overlaps the first does not double your holdings, and each fund's line says what was already there.

The part the dialog asks about is the part the plan's file cannot know: **what actually reached your bank.** A distribution with tax withheld is the full amount out of the funds and less than that into checking, and importing the gross as a transfer puts money in checking that never arrived. So each payment is listed with what the plan sold, and you fill in what the bank received and on what date, from your own register. The difference becomes its own categorized row — withholding, or a loan fee — and Import stays grayed until every line is possible. A file with no withdrawal or loan in it asks none of this, and needs no bank account named. The whole import is one Undo step, prices included.

**Cost basis follows the money between funds.** A contribution — yours, the automatic 1%, the agency match — is a Buy at that day's price, and that is the basis. A reallocation (an interfund transfer) is an **exchange**: the shares that leave one fund arrive in the other carrying the basis and the dates they had, so the plan's cost basis stays what was paid in and nothing is "realized" by moving money from G to I. The register shows the two halves as **Exchange (out)** and **Exchange (in)**. Earlier imports had written a reallocation as a Sell and a Buy at the day's price; opening the file turns those into exchanges. The one thing the file cannot tell is the basis of the position held before the export begins — that opening position is written at the price on the day before the file starts, so a longer export makes a truer basis.

Afterwards, two things by hand that no QIF can carry: set the tax line on the withholding category (Form 1099-R: Federal income tax withheld), and turn on **include in tax reports** for the plan account, which retirement accounts start with off.

# From Microsoft Money

Money cannot be read directly — its .mny file is a closed format — but it writes each account out as QIF, which comes in whole. In Money, open the account and use **File → Export**, choosing **Loose QIF** (Strict QIF also works), one file per account. Investment accounts export as investment QIF with their buys, sells, dividends, reinvestments, splits and share moves, and those build the lots here.

In T-Money, Banking → Account List → **Import QIF / OFX**: choose the **target account** (create it first with the right type and a zero opening balance) and the file. Categories named in the file are created as needed — "Automobile:Fuel" becomes the subcategory Fuel under Automobile — and cleared and reconciled marks carry over. **Splits** come in as split lines under their own categories. **Transfers link up.** Money writes the other account's name in brackets where the category would be. If an account by that name exists, the row becomes one side of a linked transfer: the other account's balance moves with it, and when that account's own file is imported its copy of the transfer is recognized and skipped. If the other account does not exist yet, the row comes in plain and the summary says so; add the account and import its file, and the two rows link at that point. So the order does not matter — but every account must exist under the same name Money used. A buy or sell paid from another account (BuyX / SellX) links the cash the same way. Importing the same file again skips rows already there. Import one account at a time and check its ending balance against Money's.

> To rehearse, run the program against a **scratch database** first: make a shortcut to \`t-money.exe\` and add \`--data-dir D:\\TMoneyScratch\` (any empty folder) to its target. That run has its own file and its own key; the real file is never opened. When the import looks right, close it, delete the folder, and do it again on the real file — or keep the scratch file and make it the real one by pointing the shortcut at it for good. Importing the same file twice skips what is already there; duplicate accounts can be folded together with Merge on the Account List.

# From a bank

The same importer reads **OFX/QFX** downloads from a bank or card website.

# CSV downloads

Every bank offers a CSV, and no two agree on the columns, so a CSV is imported in two steps. Choose the file and the account, click **Import CSV…**, and a dialog shows the file's column names, its first rows, and a guess at which column is the date, the payee, the amount (one signed column, or separate Debit / Withdrawal and Credit / Deposit columns), the memo, the check number and the category. Correct the guess with the selects. Two tables say which is which: **From the bank — the file as it is** is the first rows under the bank's own column names, untouched; **Into T-Money — what will be written** is the same rows as the register will show them, re-read on every change, with the Num, memo and category alongside when a column was chosen for them. Two switches: **Dates read as** (for a file where 3/4/2026 could be either), and **Flip the signs** — most card statements list a charge as a positive number and a payment as a negative one; flipping makes them payments and deposits. A row the mapping cannot read (a heading, an opening-balance line) is skipped and named afterwards. Rename rules apply, the same file twice is duplicates, and a new account starts from an empty register — set its opening balance first, or add an Opening Balance row for what the account held before the first line of the file.

# Houses, cars and anything else you own

Net worth is only true if the things you own are in the file. **New account → Other account type** offers **Home**, **Car or other Vehicle** and **Asset** for what you own, and **Mortgage**, **Loan**, **Home Equity Line of Credit** and **Liability** for what you owe on them. Give each one what it is worth, or what is owed, as its opening balance. Net worth groups them the way Money does — Property and other assets on one side, Loans and mortgages on the other — and the Net Worth report nets the two.

## What it is worth now

A house or a car does not change value because you spent anything, so its register has nothing to move it. **Update value…** in the register toolbar does: type the date and **what it is worth on that date**, and the difference is worked out and written for you. It is a value, not an adjustment — you know the truck is worth $9,000, not that it fell $1,850 since you last looked.

**A change in value counts in Net worth and Net worth over time, and in nothing else.** It is not income and not spending: a house gaining $20,000 is not money you can spend, and counting it would bury a year of real spending under one number. The same is true of the opening balance on one of these accounts — it is the first appraisal, not income.

Put in a value whenever you have a real one — a Kelley Blue Book figure, an appraisal, a Zillow estimate, the January statement — and **backdate it**. Values on a handful of past dates are what make Net worth over time a real curve instead of a flat line that jumps the day you got around to it. Entering an earlier value never disturbs a later one: each date keeps saying what you said it was worth.

## What is owed against it

On the debt's **Change account details** there is **Secured by**: name the asset it is borrowed against. The Account List then shows that asset's equity underneath it — *House $350,000, less $150,000 owed = $200,000 equity*. One asset can carry several debts (a mortgage and a HELOC both against the house) and each is added in.

Equity is a reading, not a third number: both accounts were already in net worth on their own sides, so linking them changes no total anywhere.

## A mortgage payment, and where each part of it goes

One payment leaves your checking account and goes several places. **Loan terms…** in a loan, mortgage, HELOC, liability or line-of-credit register sets it up once: the **interest rate**, the **payment** (principal and interest), how much **escrow** rides on top, whether the escrow goes to an escrow account or straight to a category, how much **extra principal** you pay each month, which category the interest is, and which account the payment usually comes out of. The next twelve payments appear underneath as you type — nothing is saved to show them.

Then **Record payment…** writes it as **one transaction**, split:

- **Interest** → a category. This is the only part that is spending.
- **Principal** → the loan itself. This is what makes the balance fall.
- **Extra principal** → the loan as well, on a line of its own. Left at zero it writes no line at all.
- **Escrow** → the escrow account (money you still have, held by the bank), or a category if you would rather it be spent the month it is paid.

Your register shows one payment, and the loan's balance is lower by the principal the next time you look. If the mortgage is **Secured by** the house, the equity line moves too — same payment, no second entry.

**Extra principal belongs inside the payment, not beside it.** If you send $1,800 a month and $150 of it is principal ahead of schedule, your bank shows one debit of $1,800 — so this shows one row of $1,800, with the extra as its own line in the split. Recording it as a second payment to the mortgage would leave two rows in your register where the statement has one, and a register that cannot be reconciled against the statement is worth less than no register at all. In the loan itself the two principal lines stay apart, which is how you can see a year later which months carried the extra.

Set the amount in **Loan terms…** and it is filled in on every payment; a month you skip it, type a zero over it. The schedule applies it too, so the payoff date underneath is the one you are actually driving toward and not the lender's original thirty years. Interest is still charged on the balance you started the month with — paying ahead shrinks next month's interest, not this month's.

**The schedule is a starting point, never the truth.** Banks round differently, change escrow mid-year, and apply a payment a day late and charge an extra day of interest. Every one of the numbers is typed over on the way in: put in what the statement says, and the total and the resulting balance follow what you typed. The loan's balance is what your payments actually applied, not what the arithmetic here thinks it should be — so a schedule that drifts from the statement is a schedule to correct, and never a balance to argue with.

**Only the interest reaches a spending report.** Principal, extra principal and escrow are transfers — the money moved between things you own and owe, and no category, payee or tax report counts any of them. Neither does a loan's opening balance: $150,000 already owed on the day you started keeping records is not $150,000 spent that month.

Deleting the payment puts every part back: the principal and anything extra return to the loan, the escrow comes out of the escrow account, and the money returns to checking.

# A 401(k) or other plan statement

A plan administrator's file is not a brokerage statement. It records **only the share side**: a purchase for every payroll contribution with no record of the money arriving, a share removal for the quarterly fee, another purchase for a reinvested dividend. Imported literally, the account buys thousands of dollars of shares with money that never arrived, its cash goes deeply negative, and the fees vanish — a share removal moves no cash and carries no category, so the dollars are in no report at all.

What tells those rows apart is the **memo**, and no two administrators word it the same. So a file with investment rows opens **What the memos mean** first: every distinct memo, what the file calls it (Buy, ShrsOut, Sell), how many rows and how much, and a guess at what it means. Correct any of them, then Import.

- **Contribution** — the purchase, and a deposit beside it for the same amount. This is money you earned and never saw: payroll deferral, employer match. It lands in an income category (**Retirement Contributions** unless you name another), so "what did I put in last year" is a report rather than arithmetic.
- **Reinvested dividend** — the plan paid a distribution in shares. Books the income, adds the shares, moves no cash.
- **Fee** — the shares that were taken to pay it are sold, and the fee written as an expense (**Investment Fees**), so it appears in your spending where it belongs. The lots close properly, so the cost basis stays right.
- **Withdrawal** — the sale, and the money leaving the account beside it.
- **Leave as it is** — exactly what the file says, which is what every import did before this existed.

A category is created if it does not exist, on the correct side of the tree. Type \`Parent : Child\` to nest one.

Done right, an imported plan account's **cash comes out at zero** and its worth is its holdings — which is what the plan's own statement shows you. If the value still looks low afterwards, the file's newest price is simply older than today: open the security on the Portfolio page and type the current price. A fund named the way plans name them (\`TARGET DATE FUND (0000)\`) has no ticker, so there is nothing to fetch automatically.

# Entering plan activity by hand

Many plans only let you download 90 days at a time, so some of the year gets typed rather than imported. In an investment or retirement register, **New** opens the investment form and its **Activity** list ends with a group of cash entries that move no shares:

- **Contribution** and **Employer Contribution** — money in, filed as income (Retirement Contributions, and Employer Match under it).
- **Deposit (cash in)** — money in with no category chosen for you.
- **Withdrawal (cash out)** and **Fee** — money out.

Picking one swaps the form for the ordinary transaction row with the payee and category already filled and the cursor in the right amount box, so the only thing left to type is the number. They are exactly the rows an import writes beside a purchase, with the same categories, so a year that is half typed and half imported still adds up. (**New cash entry** on the toolbar does the same thing from a blank form.)

# Reviewing matches before anything is written

A statement usually contains transactions you already entered by hand, and the two rarely agree letter for letter: the bank posts a day or two after you wrote the check, and it writes \`SAFEWAY #1234 ANYTOWN US\` where you wrote \`Safeway\`. Left alone that arrives as a second copy of everything.

So every import looks first. A row that is *exactly* what the register already holds is skipped as it always was, a row with nothing like it is imported without asking, and anything in between opens **Review matches**. Each row of that dialog shows the file's row, the transaction it might be, and why — how many days apart, how alike the names are, whether the check number agrees. The confident ones are already checked; the rest default to importing as new. Per row you can take the match, **Import as new**, or **Skip**. **Look for matches within** widens or narrows the date window if your bank posts slowly.

**Amounts must agree to the cent.** Nothing is ever offered as a match unless the money is identical — only the date, the name and the check number are judged loosely.

Taking a match does not overwrite what you typed: your payee, category, memo and date all stand. The transaction is marked **cleared**, the bank's own id is stored on it so a re-import recognizes it without asking again, and a check number is filled in only if the row had none. Nothing is written until you click Import, and a match writes no new row, so it moves no balance.

If a bank's description defeats the guess every month, a **rename rule** (Payees tab) fixes it at the source: the rule renames the row as it comes in, so the exact match works and the review never has to ask.

# Rows with no category

The same review also lists any new row that would land with **no category** — the file did not say and no payee rule caught it — under **No category yet**. Choose a category for each, or leave it blank and it arrives as Uncategorized, as before. Check **remember** beside a choice to make a payee rule from it, so the next statement files that payee without asking. A file whose every row is already categorized does not open the review for this at all.

# Export

**Export** on the same card writes an account's register as a QIF file, splits and transfers included, for a spreadsheet or another program.
`,
  },
  {
    id: "tools",
    group: "Tools and settings",
    title: "The Tools menu",
    blurb: "The calculator, finding duplicates, and payee rename rules.",
    body: `
# Calculator (Ctrl+K)

A tape, not a keypad — though it has one. You are entering a transaction, the receipt has three numbers on it, and you need the total. Type an amount and press **Enter**; type an operator (**+ − × ÷** on the buttons, or \`+ - * /\` on the keyboard) and then the next number. Every completed step writes a line showing what you entered and the running total after it, so when the answer is wrong you can see **which line** is wrong.

**%** is a percentage of the running total, the way a receipt means it: after 100.00, \`+ 8.5%\` is 8.50, not 0.085 — and it lands in the entry box so you see it before it counts. **Copy total** puts bare digits on the clipboard, ready to paste into an amount field.

# Find duplicates

See [[register|The account register]] — it works on the account you are in.

# Payee rename rules

See [[categories-payees|Categories and payees]].
`,
  },
  {
    id: "settings",
    group: "Tools and settings",
    title: "Settings, backup and the master key",
    blurb: "Text size, theme, where the file is, automatic backups, the encryption key, scratch databases.",
    body: `
The gear at the top right opens Settings.

- **Text size** — Money's type was small. Choose a size and everything scales together; it is remembered on this computer.
- **Theme** — pick a look for the program; a preview shows it before you apply. See [[themes|Themes]].
- **Holding values — broker's rounding** — how shares × price is rounded to the cent, for every investment account in the file. Brokers differ: on 20.125 shares at $10.07 rounding gives $202.66 and some brokers print $202.65. An account at a different broker can choose its own under Banking → Accounts → Change details → Holding values. Cost basis, proceeds and cash are never touched by this.
- **Prices** — when share prices are fetched: *Only when I ask* (the default), once a day or once a week **while T-Money is open** — including the moment a file is opened, if its last fetch is older than that. Nothing runs when the program is closed, and a fetch sends only your ticker symbols. The pane also says how many securities have a symbol, the newest and oldest stored price, and when a scheduled run last happened. See [[investing|Investing]].
- **Verify this file** — reads the whole file back against itself: SQLite's integrity check, every account's balance against the sum of its transactions, transfers missing their other half, splits that do not add up. **Check** changes nothing; **Repair balances** recomputes a balance that drifted and unlinks a half transfer. A split that does not add up is listed for you to open and fix.
- **Light and dark** — the ☾ / ☀ button beside the gear switches between the light theme you use and Evening, one click, and remembers which light theme to come back to.
- **Window** — the window's size, position and maximized state are remembered when you close the program and restored the next time it opens. There is nothing to set.
- **Database** — where the file is and how big it is, and that it is encrypted.
- **Master Key** — the encryption key lives in the Windows credential store, so the file opens without a password here. **Reveal** it and keep a copy somewhere safe: a backup restored on another machine needs it. **Change** re-encrypts the file with a new key.
- **Automatic backup** — choose a folder and every session ends with a fresh copy there, keeping the number you set. A backup can be restored from here; restoring one made on another machine asks for that machine's key.
- **Scratch database** — not a switch in Settings but a way of starting the program: run the installed \`t-money.exe --data-dir D:\\some\\folder\` and it opens, or creates, a separate file in that folder with its own key, leaving the real file untouched. A banner across the top of Settings says when you are on one. Delete the folder to start over. See [[import-export|Import and export]] for using it to rehearse an import.
`,
  },
  {
    id: "themes",
    group: "Tools and settings",
    title: "Looks, colors and text size",
    blurb: "Fourteen layouts, fourteen color schemes, and how big everything is.",
    body: `
Two settings, deliberately separate: a **look** is the SHAPE of the app and a **theme** is its COLORS. Sidebar in Evening and Compact in Copper are both things you can have. Both live under Settings → Appearance and both are remembered on this computer.

# Looks

**Money Classic** is the default and always will be — the tab strip, the blue header, the left rail. It is what the program is for; a different look is something you go and choose, never something you arrive in.

The other thirteen: **Sidebar** (no tab strip — navigation runs down the left), **Compact** (the same shape tightened, far more rows on screen), **Card** (rounded panels and soft shadows), **Rounded** (tabs as detached pills, no square corners anywhere), **Ledger** (accounting paper — banded rows, a heavier rule every fifth, small-caps headings, a serif), **Ribbon** (actions grouped and labeled across the top), **Three-pane** (icons, then every account with its balance, then the register), **Workbench** (three-pane mirrored, accounts on the right under your mouse hand), **Document tabs** (registers open as tabs across the top), **Two-up** (a second register beside the one you are working, to watch one account while you type in another), **Terminal** (dense monospace, for a long session), **Focus** (one column, wide margins, for reading rather than entering) and **Wide** (edge to edge, no card frames, for a large monitor).

A look never sets a color of its own — it takes the theme's, which is what stops fourteen looks times fourteen themes being a hundred and ninety-six things to check.

# Colors

**Money Plus** is the blue the program starts with, measured from the real thing. Then **Forest**, **Slate**, **Plum**, **Copper**, **Ocean**, **Sandstone**, **Mint**, **Sepia**, **Graphite** and **High contrast** in the light family, and **Evening**, **Midnight** and **Ember** for a dim room. Each swatch previews the header, rail, a card with a chart and a register; click one and it applies at once.

Every pairing is checked for readability before it ships — the menus and the navigation tabs have to clear a contrast threshold in every theme, so a scheme cannot be added that makes a label disappear.

# Text size

The same pane. It scales the registers, reports and dialogs together, so the whole program grows rather than one part of it.
`,
  },
];

/** The topic to open for a header tab (F1, or the Help tab's first visit). */
export function topicForTab(tab: string): string {
  switch (tab) {
    case "Home":
      return "home";
    case "Banking":
      return "register";
    case "Bills":
      return "bills";
    case "Reports":
      return "reports";
    case "Budget":
      return "budget";
    case "Investing":
      return "investing";
    case "Planning":
      return "goals";
    case "Taxes":
      return "taxes";
    case "Settings":
      return "settings";
    case "Search":
      return "search";
    default:
      return "welcome";
  }
}

/** Case-insensitive search over title, blurb and body. Returns the topics
 *  that match with a snippet around the first body hit, best first: title
 *  hits before blurb hits before body hits, then by how many times the
 *  words appear. */
export function searchTopics(query: string, topics: readonly HelpTopic[] = HELP_TOPICS): { topic: HelpTopic; snippet: string; score: number }[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return [];
  const out: { topic: HelpTopic; snippet: string; score: number }[] = [];
  for (const t of topics) {
    const title = t.title.toLowerCase();
    const blurb = t.blurb.toLowerCase();
    const body = t.body.toLowerCase();
    if (!words.every((w) => title.includes(w) || blurb.includes(w) || body.includes(w))) continue;
    let score = 0;
    for (const w of words) {
      if (title.includes(w)) score += 100;
      if (blurb.includes(w)) score += 20;
      score += body.split(w).length - 1;
    }
    const at = body.indexOf(words[0]);
    let snippet = "";
    if (at >= 0) {
      const start = Math.max(0, at - 60);
      const raw = t.body.slice(start, at + 90).replace(/[#>*`\[\]\n]/g, " ").replace(/\s+/g, " ").trim();
      snippet = `${start > 0 ? "…" : ""}${raw}…`;
    }
    out.push({ topic: t, snippet, score });
  }
  return out.sort((a, b) => b.score - a.score || a.topic.title.localeCompare(b.topic.title));
}
