// The tax lines a category can be assigned to (§43, Tier 2).
// A FIXED list, grouped by form, because free text cannot be grouped
// reliably — two spellings of one line become two lines in the report.
// The strings are the values stored in `categories.tax_line`; the standard
// chart (standard_categories.rs) uses these exact strings. A line that is
// not here (an older file, a hand-typed one) still round-trips: the picker
// keeps it as its own option and never rewrites it.
//
// Nothing here is tax advice: these are labels for what the user recorded.
export interface TaxLine {
  form: string;
  line: string;
}

export const TAX_LINES: readonly TaxLine[] = [
  { form: "W-2", line: "W-2: Wages" },
  { form: "W-2", line: "W-2: Federal income tax withheld" },
  { form: "W-2", line: "W-2: Social security tax withheld" },
  { form: "W-2", line: "W-2: Medicare tax withheld" },
  { form: "W-2", line: "W-2: State income tax withheld" },
  { form: "W-2", line: "W-2: Local income tax withheld" },
  { form: "Form 1040", line: "Form 1040: Wages" },
  { form: "Form 1040", line: "Form 1040: IRA distributions" },
  { form: "Form 1040", line: "Form 1040: Pensions and annuities" },
  { form: "Form 1040", line: "Form 1040: Social security benefits" },
  { form: "Form 1040", line: "Form 1040: Unemployment compensation" },
  { form: "Form 1040", line: "Form 1040: Other income" },
  { form: "Form 1040", line: "Form 1040: Student loan interest" },
  { form: "Form 1040", line: "Form 1040: Traditional IRA contributions" },
  { form: "Form 1040", line: "Form 1040: HSA deduction" },
  { form: "Form 1040", line: "Form 1040: Estimated tax payments" },
  { form: "Schedule A", line: "Schedule A: Medical and dental expenses" },
  { form: "Schedule A", line: "Schedule A: State and local income taxes" },
  { form: "Schedule A", line: "Schedule A: Real estate taxes" },
  { form: "Schedule A", line: "Schedule A: Personal property taxes" },
  { form: "Schedule A", line: "Schedule A: Home mortgage interest" },
  { form: "Schedule A", line: "Schedule A: Investment interest" },
  { form: "Schedule A", line: "Schedule A: Cash contributions" },
  { form: "Schedule A", line: "Schedule A: Non-cash contributions" },
  { form: "Schedule B", line: "Schedule B: Interest income" },
  { form: "Schedule B", line: "Schedule B: Dividend income" },
  { form: "Schedule C", line: "Schedule C: Gross receipts" },
  { form: "Schedule C", line: "Schedule C: Advertising" },
  { form: "Schedule C", line: "Schedule C: Car and truck expenses" },
  { form: "Schedule C", line: "Schedule C: Insurance" },
  { form: "Schedule C", line: "Schedule C: Office expense" },
  { form: "Schedule C", line: "Schedule C: Supplies" },
  { form: "Schedule C", line: "Schedule C: Utilities" },
  { form: "Schedule C", line: "Schedule C: Other expenses" },
  { form: "Schedule D", line: "Schedule D: Capital gains" },
  { form: "Schedule E", line: "Schedule E: Rents received" },
  { form: "Schedule E", line: "Schedule E: Repairs" },
  { form: "Schedule E", line: "Schedule E: Insurance" },
  { form: "Schedule E", line: "Schedule E: Mortgage interest" },
  { form: "Schedule E", line: "Schedule E: Taxes" },
  { form: "Form 8863", line: "Form 8863: Qualified education expenses" },
  { form: "Form 1099-R", line: "Form 1099-R: Gross distribution" },
  { form: "Form 1099-R", line: "Form 1099-R: Federal income tax withheld" },
];

export const TAX_FORMS: readonly string[] = TAX_LINES.map((t) => t.form).filter((f, i, a) => a.indexOf(f) === i);

/** The form a stored line belongs to — the text before the colon, which is
 *  also how a line not on the list is grouped. */
export function formOf(line: string): string {
  const i = line.indexOf(":");
  return i > 0 ? line.slice(0, i).trim() : "Other";
}

export function isKnownLine(line: string): boolean {
  return TAX_LINES.some((t) => t.line === line);
}

/** The tax years worth offering: this year back through `n` earlier ones. */
export function taxYears(today: string, n = 6): number[] {
  const y = Number(today.slice(0, 4));
  return Array.from({ length: n + 1 }, (_, i) => y - i);
}
