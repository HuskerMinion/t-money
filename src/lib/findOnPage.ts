// §156 — Ctrl+F on the Budget tab finds a budget LINE, not a transaction.
//
// Found at S9: typing "heating oil" while looking at the year plan jumped to
// the header search box and found a transaction, when the thing on screen was
// a table with a Heating oil row in it. The header search is the right Ctrl+F
// everywhere else; the two budget screens are tables of named lines, and on
// a table, Find means "show me the row".
//
// The filter is a plain case-insensitive substring over category names. A
// parent that matches keeps all its children (you asked for "Bills"); a
// child that matches is shown under its parent with only the matching
// siblings (you asked for "heating oil", not for all of Bills). A find also
// bypasses the "interesting" filter, because a search for a category is the
// clearest possible statement that you want to see it, planned or not.

interface Named {
  name: string;
}

export interface Grouped<T extends Named> {
  parent: T;
  children: T[];
}

/** The groups that match `query`, narrowed as described above. An empty or
 *  blank query matches everything, unchanged. */
export function matchGroups<T extends Named, G extends Grouped<T>>(groups: readonly G[], query: string): G[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...groups];
  const hit = (n: string) => n.toLowerCase().includes(q);
  const out: G[] = [];
  for (const g of groups) {
    if (hit(g.parent.name)) {
      out.push(g);
      continue;
    }
    const kids = g.children.filter((c) => hit(c.name));
    if (kids.length > 0) out.push({ ...g, children: kids });
  }
  return out;
}

/** Is a find in progress — i.e. should the screen show matches rather than
 *  its ordinary view? */
export function isFinding(query: string): boolean {
  return query.trim() !== "";
}
