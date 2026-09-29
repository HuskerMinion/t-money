// @vitest-environment jsdom
// The Help tab: every topic renders, links cross over, search finds.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import HelpView, { linkedTopics, renderBody } from "./HelpView";
import { HELP_GROUPS, HELP_TOPICS, searchTopics, topicForTab } from "../help/topics";

describe("help content", () => {
  it("every topic has a group from the list, a unique id, and links only to topics that exist", () => {
    const ids = new Set<string>();
    for (const t of HELP_TOPICS) {
      expect(HELP_GROUPS).toContain(t.group);
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      for (const m of t.body.matchAll(/\[\[([a-z0-9-]+)\|/g)) {
        expect(ids.has(m[1]) || HELP_TOPICS.some((x) => x.id === m[1]), `${t.id} links to ${m[1]}`).toBe(true);
      }
    }
    // Every header tab has a topic.
    for (const tab of ["Home", "Banking", "Bills", "Reports", "Budget", "Investing", "Planning", "Taxes", "Settings"]) {
      expect(HELP_TOPICS.some((t) => t.id === topicForTab(tab))).toBe(true);
    }
  });

  it("renders the markdown subset", () => {
    const nodes = renderBody("# Heading\n\nA **bold** word and `code` and [[register|the register]].\n\n- one\n- two\n\n> a tip", () => {});
    const { container } = render(<div>{nodes}</div>);
    expect(container.querySelector("h3")).toHaveTextContent("Heading");
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("code")).toHaveTextContent("code");
    expect(container.querySelector("a")).toHaveTextContent("the register");
    expect(container.querySelectorAll("li").length).toBe(2);
    expect(container.querySelector(".tm-help-tip")).toHaveTextContent("a tip");
  });

  it("searches title first, then body, and returns a snippet", () => {
    const hits = searchTopics("check number");
    expect(hits[0].topic.id).toBe("register");
    expect(hits.some((h) => h.topic.id === "shortcuts")).toBe(true);
    expect(hits[0].snippet.toLowerCase()).toContain("check");
    expect(searchTopics("xyzzy")).toEqual([]);
    expect(searchTopics("")).toEqual([]);
  });
});

describe("HelpView", () => {
  it("opens on the topic asked for, navigates by the list and by links", async () => {
    render(<HelpView topic="bills" />);
    expect(screen.getByRole("heading", { name: "Bills and deposits" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "The account register" }));
    expect(screen.getByRole("heading", { name: "The account register" })).toBeInTheDocument();
    // A cross-link in the body.
    const article = screen.getByRole("article");
    await userEvent.click(within(article).getAllByRole("link", { name: /Splits, transfers and goals/ })[0]);
    expect(screen.getByRole("heading", { name: "Splits, transfers and goals" })).toBeInTheDocument();
    expect(linkedTopics(HELP_TOPICS.find((t) => t.id === "splits-transfers")!).map((t) => t.id)).toContain("bills");
  });

  it("search replaces the list with hits and clears when one is chosen", async () => {
    render(<HelpView />);
    await userEvent.type(screen.getByLabelText("Search help"), "subscription");
    const results = screen.getByLabelText("Help search results");
    expect(within(results).getByText("Subscriptions and recurring charges")).toBeInTheDocument();
    await userEvent.click(within(results).getByText("Subscriptions and recurring charges"));
    expect(screen.getByRole("heading", { name: "Subscriptions and recurring charges" })).toBeInTheDocument();
    expect((screen.getByLabelText("Search help") as HTMLInputElement).value).toBe("");
  });
});

// Help that has fallen behind the app is worse than no help, because
// it is believed. These are the checks that would have caught the drift a user
// found: the Themes page still said "seven looks" three sections after there
// were fourteen of each, and nothing in Help mentioned files, undo, the TSP
// importer or the calculator.
//
// Deliberately mechanical. Nobody is going to remember to reread the help
// after adding a look; a test will.
describe("help keeps up with the app", () => {
  const topic = (id: string) => HELP_TOPICS.find((t) => t.id === id);

  it("names every look and every theme that ships", async () => {
    const { LOOKS } = await import("../lib/layout");
    const { THEMES } = await import("../lib/theme");
    const body = topic("themes")!.body;
    const missing = [
      ...LOOKS.map((l) => l.label),
      ...THEMES.map((t) => t.label),
    ].filter((label) => !body.includes(label));
    expect(missing, `not mentioned in Help → Looks, colors and text size: ${missing.join(", ")}`).toEqual([]);
  }, 20_000); // two dynamic imports under a loaded worker can pass 5 s; the check itself is instant

  it("does not claim a count that the code can contradict", () => {
    // "seven looks" is how the last one went stale. A number written out in
    // words next to "look" or "theme" is a promise the code will break.
    const body = topic("themes")!.body.toLowerCase();
    const counted = /\b(three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen)\s+(looks|themes|colors)\b/.exec(body);
    expect(counted?.[0] ?? null).toBeNull();
  });

  it("has a page for each thing the File, Edit and Tools menus can do", () => {
    for (const id of ["files", "undo", "tools", "import-export"]) {
      expect(topic(id), `no help topic "${id}"`).toBeDefined();
    }
    // And each says the thing it exists to say.
    expect(topic("files")!.body).toMatch(/Close file/);
    expect(topic("files")!.body).toMatch(/does not start a second copy/);
    expect(topic("undo")!.body).toMatch(/Ctrl\+Z/);
    expect(topic("undo")!.body).toMatch(/Accounts and categories/);
    expect(topic("tools")!.body).toMatch(/Ctrl\+K/);
    expect(topic("import-export")!.body).toMatch(/tsp\.gov/);
    expect(topic("categories-payees")!.body).toMatch(/Rename payees in existing transactions/);
    expect(topic("splits-transfers")!.body).toMatch(/Transfer : \(account\)/);
  });
});
