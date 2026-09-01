const etch = require("@lumine-code/etch");
const NotebookView = require("../lib/notebook-view");

// The view kept its own map of cell views and compared the container's children
// against the expected order to decide whether to rebuild the list by hand.
// Etch keys the cells by id, so it moves them instead — which is what keeps a
// cell's TextEditor alive across a reorder. These specs pin that, plus the
// toolbar state that used to be patched imperatively.

const flush = (view) => etch.updateSync(view);

function cell(id, overrides = {}) {
  return { id, type: "code", source: `# ${id}`, outputs: [], status: "idle", ...overrides };
}

function mount(cells, props = {}) {
  const view = new NotebookView({ cells, activeCellIndex: 0, editor: null, ...props });
  flush(view);
  return view;
}

describe("notebook view", () => {
  let view;

  afterEach(() => {
    view?.destroy();
    view = null;
  });

  const cellElements = () => [...view.element.querySelectorAll(".jupyter-cell")];

  it("renders one cell per notebook cell, in order", () => {
    view = mount([cell("a"), cell("b"), cell("c")]);

    expect(cellElements().length).toBe(3);
    expect(cellElements().map((c) => c.getAttribute("data-cell-id"))).toEqual(["a", "b", "c"]);
  });

  it("keeps a cell's editor across a reorder", () => {
    view = mount([cell("a"), cell("b")]);
    const editorA = view.cellViews.get("a").editor;
    const elementA = cellElements()[0];

    view.update({ cells: [cell("b"), cell("a")] });
    flush(view);

    expect(cellElements().map((c) => c.getAttribute("data-cell-id"))).toEqual(["b", "a"]);
    // The same view, the same editor, moved rather than rebuilt.
    expect(view.cellViews.get("a").editor).toBe(editorA);
    expect(cellElements()[1]).toBe(elementA);
  });

  it("adds and removes cells without disturbing the rest", () => {
    view = mount([cell("a"), cell("b")]);
    const editorB = view.cellViews.get("b").editor;

    view.update({ cells: [cell("a"), cell("x"), cell("b")] });
    flush(view);
    expect(cellElements().map((c) => c.getAttribute("data-cell-id"))).toEqual(["a", "x", "b"]);
    expect(view.cellViews.get("b").editor).toBe(editorB);

    view.update({ cells: [cell("b")] });
    flush(view);
    expect(cellElements().map((c) => c.getAttribute("data-cell-id"))).toEqual(["b"]);
  });

  it("renders the toolbar", () => {
    view = mount([cell("a")]);

    expect(view.element.querySelectorAll(".jupyter-notebook-toolbar .btn").length).toBe(13);
    expect(view.element.querySelector(".cell-type-select[role=combobox]")).toBeTruthy();
    expect(view.element.querySelector("select")).toBeNull();
  });

  it("shows the active cell's type in the dropdown", () => {
    view = mount([cell("a"), cell("b", { type: "markdown" })]);
    expect(view.refs.cellTypeSelect.controller.value).toBe("code");

    view.update({ activeCellIndex: 1 });
    flush(view);

    expect(view.refs.cellTypeSelect.controller.value).toBe("markdown");
  });

  it("reflects the mode in its class and its indicator", () => {
    view = mount([cell("a")]);
    expect(view.element.classList.contains("command-mode")).toBe(true);
    expect(view.element.querySelector(".mode-indicator").textContent).toBe("Command");

    view.setMode("edit");

    // The keymap selectors read this class, so it must be current immediately.
    expect(view.element.classList.contains("edit-mode")).toBe(true);
    expect(view.element.querySelector(".mode-indicator").textContent).toBe("Edit");
  });

  it("marks the selected cells", () => {
    view = mount([cell("a"), cell("b"), cell("c")]);

    view.selectedCells = new Set([1]);
    flush(view);

    const selected = view.element.querySelectorAll(".jupyter-cell.selected");
    expect(selected.length).toBe(1);
    expect(selected[0].getAttribute("data-cell-id")).toBe("b");
  });

  it("exposes its cell views by id", () => {
    view = mount([cell("a"), cell("b")]);

    expect([...view.cellViews.keys()].sort()).toEqual(["a", "b"]);
    expect(view.cellViews.get("a").props.cell.id).toBe("a");
  });

  it("destroys its cell views with itself", () => {
    view = mount([cell("a")]);
    const editor = view.cellViews.get("a").editor;

    view.destroy();
    view = null;

    expect(editor.isDestroyed()).toBe(true);
  });
});
