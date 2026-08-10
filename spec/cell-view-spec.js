const etch = require("@lumine-code/etch");
const CellView = require("../lib/cell-view");

// The cell view kept a cache of its own DOM nodes and a copy of every value it
// had rendered, so an update could patch only what changed. Etch's diff does
// that, and the caches are gone — but the embedded TextEditor still must not be
// rebuilt by a render, because it carries the buffer, the cursor and the
// selection. These specs pin that, and the markdown round trip that decides
// whether the editor exists at all.

const flush = (view) => etch.updateSync(view);

function makeCell(overrides = {}) {
  return {
    id: "cell-1",
    type: "code",
    source: "print('hi')",
    outputs: [],
    executionCount: null,
    status: "idle",
    ...overrides,
  };
}

function mount(cell, props = {}) {
  const view = new CellView({
    cell,
    index: 0,
    active: false,
    selected: false,
    mode: "command",
    editor: null,
    notebookView: null,
    notebookLanguage: "python",
    cellSourceRevision: 0,
    ...props,
  });
  flush(view);
  return view;
}

describe("cell view", () => {
  let view;

  afterEach(() => {
    view?.destroy();
    view = null;
  });

  it("renders a code cell with an editor holding the source", () => {
    view = mount(makeCell());

    expect(view.element.classList.contains("jupyter-cell-code")).toBe(true);
    expect(view.editor).toBeTruthy();
    expect(view.editor.getText()).toBe("print('hi')");
    expect(view.element.querySelector("lumine-text-editor.jupyter-cell-editor")).toBeTruthy();
  });

  it("upgrades a TextMate fallback when the Tree-sitter grammar loads later", async () => {
    await lumine.packages.activatePackage("language-python");
    const grammars = lumine.grammars.getGrammars({ includeTreeSitter: true });
    const treeSitter = grammars.find(
      (grammar) => grammar.scopeName === "source.python.ipy" && grammar.type === "tree-sitter",
    );
    const textMate = grammars.find(
      (grammar) => grammar.scopeName === "source.python.ipy" && grammar.type !== "tree-sitter",
    );
    expect(treeSitter).toBeDefined();
    expect(textMate).toBeDefined();

    lumine.grammars.removeGrammar(treeSitter);
    try {
      view = mount(makeCell());
      expect(view.editor.getGrammar()).toBe(textMate);

      lumine.grammars.addGrammar(treeSitter);
      expect(view.editor.getGrammar()).toBe(treeSitter);
    } finally {
      if (!lumine.grammars.getGrammars({ includeTreeSitter: true }).includes(treeSitter)) {
        lumine.grammars.addGrammar(treeSitter);
      }
    }
  });

  it("renders markdown instead of an editor when it is not being edited", () => {
    view = mount(makeCell({ type: "markdown", source: "# Head" }));

    expect(view.editor).toBe(null);
    const rendered = view.element.querySelector(".markdown-rendered");
    expect(rendered).toBeTruthy();
    expect(rendered.innerHTML).toContain("<h1>");
  });

  it("swaps markdown for an editor on edit, and back again", () => {
    view = mount(makeCell({ type: "markdown", source: "# Head" }));
    expect(view.element.querySelector(".markdown-rendered")).toBeTruthy();

    view.update({ cell: view.props.cell, active: true, mode: "edit" });
    flush(view);

    expect(view.editor).toBeTruthy();
    expect(view.element.querySelector(".markdown-rendered")).toBeFalsy();

    view.update({ cell: view.props.cell, active: true, mode: "command" });
    flush(view);

    expect(view.editor).toBe(null);
    expect(view.element.querySelector(".markdown-rendered")).toBeTruthy();
  });

  it("keeps the same editor across an unrelated update", () => {
    view = mount(makeCell());
    const editor = view.editor;
    const element = view.editorElement;
    view.editor.setCursorBufferPosition([0, 5]);

    // A status change is not a reason to rebuild the editor.
    view.update({ cell: makeCell({ status: "running" }), index: 0 });
    flush(view);

    expect(view.editor).toBe(editor);
    expect(view.editorElement).toBe(element);
    expect(view.editor.getCursorBufferPosition().column).toBe(5);
    expect(element.parentNode).toBeTruthy();
  });

  it("shows the execution count, and a marker while running", () => {
    view = mount(makeCell({ executionCount: 7 }));
    expect(view.element.querySelector(".execution-count").textContent).toBe("[7]");

    view.update({ cell: makeCell({ executionCount: 7, status: "running" }) });
    flush(view);

    expect(view.element.querySelector(".execution-count").textContent).toBe("[*]");
    expect(view.element.classList.contains("running")).toBe(true);
    expect(view.element.querySelector(".cell-gutter").classList.contains("running")).toBe(true);
  });

  it("numbers the cell from its index", () => {
    view = mount(makeCell(), { index: 4 });
    expect(view.element.querySelector(".cell-number").textContent).toBe("5");

    view.update({ cell: view.props.cell, index: 9 });
    flush(view);

    expect(view.element.querySelector(".cell-number").textContent).toBe("10");
  });

  it("renders displayable outputs and skips protocol ones", () => {
    view = mount(
      makeCell({
        outputs: [
          { output_type: "stream", name: "stdout", text: "shown" },
          { output_type: "status", execution_state: "idle" },
        ],
      }),
    );

    expect(view.element.querySelectorAll(".jupyter-output").length).toBe(1);
    expect(view.element.textContent).toContain("shown");
  });

  it("drops the output container when the outputs go", () => {
    view = mount(makeCell({ outputs: [{ output_type: "stream", name: "stdout", text: "x" }] }));
    expect(view.element.querySelector(".cell-output-container")).toBeTruthy();

    view.update({ cell: makeCell({ outputs: [] }) });
    flush(view);

    expect(view.element.querySelector(".cell-output-container")).toBeFalsy();
  });

  it("hides the input when the cell asks it to", () => {
    view = mount(makeCell({ inputVisible: false }));
    expect(view.element.querySelector(".cell-input").style.display).toBe("none");

    view.update({ cell: makeCell({ inputVisible: true }) });
    flush(view);

    expect(view.element.querySelector(".cell-input").style.display).toBe("");
  });

  it("takes an external source change into the editor", () => {
    view = mount(makeCell());

    view.update({ cell: makeCell({ source: "changed elsewhere" }) });
    flush(view);

    expect(view.editor.getText()).toBe("changed elsewhere");
  });

  it("offers run, clear and delete on a code cell, delete alone otherwise", () => {
    view = mount(makeCell());
    expect(view.element.querySelectorAll(".cell-actions button").length).toBe(3);
    view.destroy();

    view = mount(makeCell({ type: "markdown", source: "text" }));
    expect(view.element.querySelectorAll(".cell-actions button").length).toBe(1);
  });

  it("destroys its editor with itself", () => {
    view = mount(makeCell());
    const editor = view.editor;

    view.destroy();
    view = null;

    expect(editor.isDestroyed()).toBe(true);
  });
});
