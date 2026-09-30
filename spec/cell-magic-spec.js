const etch = require("@lumine-code/etch");

describe("notebook cell magic syntax", () => {
  let view;
  let CellView;

  const mount = (source, overrides = {}) => {
    view = new CellView({
      cell: { id: "magic-cell", type: "code", source, outputs: [], metadata: {}, ...overrides },
      index: 0,
      active: true,
      selected: false,
      mode: "edit",
      notebookLanguage: "python",
      cellSourceRevision: 0,
    });
    etch.updateSync(view);
    return view.editor;
  };

  const settle = async (editor) => {
    const mode = editor.getBuffer().getLanguageMode();
    await mode.ready;
    await mode.atGrammarSettlement();
    return mode;
  };

  beforeEach(async () => {
    for (const name of [
      "language-python",
      "language-ipython",
      "language-html",
      "language-shellscript",
      "language-gfm",
      "language-text",
    ]) {
      await lumine.packages.activatePackage(name);
    }
    CellView = require("../lib/cell-view");
  });

  afterEach(() => view?.destroy());

  it("parses only Bash body and keeps percent comments inside the notebook cell", async () => {
    const source = "%%bash -e\nprintf 'ok'\n# %% [markdown]\nprintf 'later'\n";
    const editor = mount(source);
    const mode = await settle(editor);
    expect(editor.getGrammar().scopeName).toBe("source.shell");
    expect(mode.tree.rootNode.hasError).toBe(false);
    expect(mode.tree.rootNode.startPosition.row).toBe(1);
    expect(editor.getText()).toBe(source);
    expect(view.props.cell.type).toBe("code");
    expect(mode.tree.rootNode.descendantsOfType("comment").map((node) => node.text)).toContain(
      "# %% [markdown]",
    );
  });

  it("keeps Python markers as comments and line magics as Python syntax errors", async () => {
    const editor = mount("# %% [markdown]\nvalue = 1\n");
    const mode = await settle(editor);
    expect(editor.getGrammar().scopeName).toBe("source.python");
    expect(mode.tree.rootNode.hasError).toBe(false);
    expect(mode.tree.rootNode.descendantsOfType("assignment").length).toBe(1);
    editor.setText("%pwd\n");
    await mode.atGrammarSettlement();
    expect(mode.tree.rootNode.hasError).toBe(true);
  });

  it("preserves the parser, range policy and header decoration on ordinary body edits", async () => {
    const editor = mount("\n%%html --isolated\n<b>one</b>\n");
    const mode = await settle(editor);
    const root = mode.rootLanguageLayer;
    const prefix = view._magicPrefix.marker;
    const decoration = view._magicDecoration;
    const assign = spyOn(lumine.grammars, "assignLanguageMode").and.callThrough();
    editor.setTextInBufferRange(
      [
        [2, 3],
        [2, 6],
      ],
      "two",
    );
    await mode.atGrammarSettlement();
    expect(editor.getBuffer().getLanguageMode()).toBe(mode);
    expect(mode.rootLanguageLayer).toBe(root);
    expect(view._magicPrefix.marker).toBe(prefix);
    expect(view._magicDecoration).toBe(decoration);
    expect(assign).not.toHaveBeenCalled();
    expect(mode.tree.rootNode.hasError).toBe(false);
    expect(mode.tree.rootNode.startPosition.row).toBe(2);
  });

  it("changes body grammar immediately when a header is edited or removed", async () => {
    const editor = mount("%%html\n<b>one</b>\n");
    await settle(editor);
    editor.setText("%%bash\nprintf 'ok'\n");
    let mode = await settle(editor);
    expect(editor.getGrammar().scopeName).toBe("source.shell");
    expect(mode.tree.rootNode.hasError).toBe(false);
    editor.setText("value = 1\n");
    mode = await settle(editor);
    expect(editor.getGrammar().scopeName).toBe("source.python");
    expect(mode.tree.rootNode.startPosition.row).toBe(0);
    expect(view._magicDecoration).toBeNull();
  });

  it("recomputes header syntax on undo and redo without restoring obsolete prefix markers", async () => {
    const editor = mount("%%html\n<b>one</b>\n");
    await settle(editor);
    editor.setText("%%bash\nprintf 'ok'\n");
    await settle(editor);
    editor.undo();
    await settle(editor);
    expect(editor.getGrammar().scopeName).toBe("text.html.basic");
    expect(view.cellMagic().name).toBe("html");
    editor.redo();
    await settle(editor);
    expect(editor.getGrammar().scopeName).toBe("source.shell");
    expect(view.cellMagic().name).toBe("bash");
  });

  it("handles a header without body, unknown magics and explicit body languages", async () => {
    const editor = mount("%%bash");
    let mode = await settle(editor);
    expect(mode.tree.rootNode.hasError).toBe(false);
    expect(mode.tree.rootNode.namedChildCount).toBe(0);
    editor.setText("%%custom\nopaque content\n");
    await settle(editor);
    expect(editor.getGrammar().scopeName).toBe("text.plain");
    view.props.cell.metadata = { vscode: { languageId: "html" } };
    view.update({ cell: view.props.cell });
    mode = await settle(editor);
    expect(editor.getGrammar().scopeName).toBe("text.html.basic");
    expect(mode.tree.rootNode.startPosition.row).toBe(1);
  });

  it("does not interpret a later magic or a magic in a non-Python notebook", async () => {
    const editor = mount("# comment\n%%bash\nprintf 'ok'\n");
    await settle(editor);
    expect(editor.getGrammar().scopeName).toBe("source.python");
    expect(view.cellMagic()).toBeNull();
    view.props.notebookLanguage = "shell";
    editor.setText("%%bash\nprintf 'ok'\n");
    view.update({ cell: view.props.cell });
    await settle(editor);
    expect(view.cellMagic()).toBeNull();
    expect(editor.getBuffer().getLanguageMode().tree.rootNode.startPosition.row).toBe(0);
  });
});
