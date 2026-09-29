// @vitest-environment jsdom
// Classifications manager.
//
// The two things worth locking down here are the ones Money got wrong: a
// value must be deletable, and the delete must say how many lines it will
// untag BEFORE it happens rather than refusing forever once the value has
// been used.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import ClassificationsView, { valueTree } from "./ClassificationsView";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { Classification, ClassificationValue } from "../lib/types";

function value(over: Partial<ClassificationValue> & { id: string; name: string }): ClassificationValue {
  return {
    classification_id: "cl-prop",
    parent_id: null,
    full_name: over.name,
    usage_count: 0,
    ...over,
  };
}

const PROPERTY: Classification = {
  id: "cl-prop",
  name: "Property",
  sort_order: 0,
  usage_count: 9,
  values: [
    value({ id: "v-cos", name: "Maple", usage_count: 7 }),
    value({ id: "v-roof", name: "Roof 2026", parent_id: "v-cos", full_name: "Maple : Roof 2026", usage_count: 3 }),
    value({ id: "v-lak", name: "Birch Lane", usage_count: 2 }),
  ],
};

const PERSON: Classification = { id: "cl-per", name: "Person", sort_order: 1, usage_count: 0, values: [] };

beforeEach(() => {
  resetIpc();
  setIpcHandlers({ list_classifications: () => [PROPERTY, PERSON] });
});

describe("valueTree", () => {
  it("nests each value's sub-values under it", () => {
    const tree = valueTree(PROPERTY.values);
    expect(tree.map((t) => t.parent.name)).toEqual(["Maple", "Birch Lane"]);
    expect(tree[0].children.map((c) => c.name)).toEqual(["Roof 2026"]);
  });
});

describe("the classifications screen", () => {
  it("lists each axis as a tab and its values as a tree", async () => {
    render(<ClassificationsView />);
    expect(await screen.findByRole("button", { name: "Property" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Person" })).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Maple")).toBeInTheDocument();
    expect(within(table).getByText("Roof 2026")).toBeInTheDocument();
    // Usage is on screen before anything can be deleted, which is the point.
    expect(within(table).getByText("7")).toBeInTheDocument();
  });

  it("adds a value under the chosen parent", async () => {
    setIpcHandlers({
      list_classifications: () => [PROPERTY, PERSON],
      create_classification_value: () => value({ id: "v-new", name: "Shed" }),
    });
    render(<ClassificationsView />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/New value/i), "Shed");
    await user.selectOptions(screen.getByLabelText("Parent value"), "v-cos");
    await user.click(screen.getByRole("button", { name: "Add value" }));
    await waitFor(() =>
      expect(invokeCalls.find((c) => c.cmd === "create_classification_value")?.args).toEqual({
        classificationId: "cl-prop",
        name: "Shed",
        parentId: "v-cos",
      })
    );
  });

  it("says how many lines a delete will untag, and untags rather than blocking", async () => {
    // Money would not let you delete a classification that had been used.
    // This one can be deleted; it just tells you what that costs first.
    setIpcHandlers({
      list_classifications: () => [PROPERTY, PERSON],
      delete_classification_value: () => 7,
    });
    render(<ClassificationsView />);
    const user = userEvent.setup();
    // "Maple" is also an option in the parent-value picker, so scope to
    // the table rather than to the page.
    const table = await screen.findByRole("table");
    const row = within(table).getByText("Maple").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/7 lines are tagged with it/)).toBeInTheDocument();
    expect(within(dialog).getByText(/keep their category, their amount/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "delete_classification_value")).toBe(true));
    expect(await screen.findByText(/untagged 7 lines/)).toBeInTheDocument();
  });

  it("says plainly when nothing is tagged yet", async () => {
    render(<ClassificationsView />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Person" }));
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    expect(within(await screen.findByRole("dialog")).getByText(/Nothing is tagged with it/)).toBeInTheDocument();
  });

  it("invites the first one when the file has none", async () => {
    setIpcHandlers({ list_classifications: () => [] });
    render(<ClassificationsView />);
    expect(await screen.findByText(/No classifications yet/)).toBeInTheDocument();
  });

  it("shows what the backend refused rather than swallowing it", async () => {
    setIpcHandlers({
      list_classifications: () => [PROPERTY, PERSON],
      create_classification: () => {
        throw "there is already a classification named \"Property\"";
      },
    });
    render(<ClassificationsView />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/New classification/i), "Property");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/already a classification named/)).toBeInTheDocument();
  });
});

describe("The parent picker follows the classification", () => {
  it("does not carry a parent from one classification to another", async () => {
    setIpcHandlers({
      list_classifications: () => [PROPERTY, { ...PERSON, values: [value({ id: "v-me", name: "Me", classification_id: "cl-per" })] }],
      create_classification_value: () => value({ id: "v-new", name: "Kid" }),
    });
    render(<ClassificationsView />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Parent value"), "v-cos");
    await user.click(screen.getByRole("button", { name: "Person" }));
    await user.type(screen.getByLabelText(/New value/i), "Kid");
    await user.click(screen.getByRole("button", { name: "Add value" }));
    await waitFor(() =>
      expect(invokeCalls.find((c) => c.cmd === "create_classification_value")?.args).toEqual({
        classificationId: "cl-per",
        name: "Kid",
        parentId: null,
      })
    );
  });

  it("lets go of a parent that was just deleted", async () => {
    let list = [PROPERTY, PERSON];
    setIpcHandlers({
      list_classifications: () => list,
      delete_classification_value: () => {
        list = [{ ...PROPERTY, values: PROPERTY.values.filter((v) => v.id !== "v-lak") }, PERSON];
        return 2;
      },
      create_classification_value: () => value({ id: "v-new", name: "Shed" }),
    });
    render(<ClassificationsView />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Parent value"), "v-lak");
    const row = within(screen.getByRole("table")).getByText("Birch Lane").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: "Delete…" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The picker shows "(top level)" either way; what matters is what is SENT.
    await user.type(screen.getByLabelText(/New value/i), "Shed");
    await user.click(screen.getByRole("button", { name: "Add value" }));
    await waitFor(() =>
      expect(invokeCalls.find((c) => c.cmd === "create_classification_value")?.args.parentId).toBeNull()
    );
  });

  it("does not claim a category delete is outside undo (it is undoable now)", async () => {
    render(<ClassificationsView />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Person" }));
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText(/deleting a category/)).toBeNull();
  });
});
