const etch = require("@lumine-code/etch");

describe("Notebook cell syntax in the worker", () => {
  let view, execution;
  beforeEach(async () => {
    jasmine.useRealClock();
    execution = lumine.grammars.syntaxExecution;
    lumine.grammars.syntaxExecution = "worker";
    for (const name of [
      "language-python",
      "language-html",
      "language-shellscript",
      "language-gfm",
      "language-text",
    ])
      await lumine.packages.activatePackage(name);
  });
  afterEach(() => {
    view?.destroy();
    lumine.grammars.syntaxWorkerService?.dispose();
    lumine.grammars.syntaxWorkerService = null;
    lumine.grammars.syntaxExecution = execution;
  });
  function mount(source) {
    const CellView = require("../lib/cell-view");
    view = new CellView({
      cell: { id: "worker-magic", type: "code", source, outputs: [], metadata: {} },
      index: 0,
      active: true,
      selected: false,
      mode: "edit",
      notebookLanguage: "python",
      cellSourceRevision: 0,
    });
    etch.updateSync(view);
    return view.editor;
  }
  async function inspect() {
    expect(view.editor.getBuffer().getLanguageMode().asynchronousSyntax).toBeTrue();
    await view.editor.whenGrammarSettled();
    return view.editor.analyzeSyntax(require.resolve("./helpers/cell-syntax"), "inspect");
  }
  it("keeps CRLF and Unicode source while excluding the magic header and retaining body-edit ownership", async () => {
    const source = "\r\n%%html --isolated\r\n<b>😀</b>\r\n";
    const editor = mount(source);
    const first = await inspect();
    expect(first.start.row).toBe(2);
    expect(first.hasError).toBeFalse();
    expect(first.source).toBe(source);
    const mode = editor.getBuffer().getLanguageMode(),
      policy = view.rootRangesDisposable;
    const marker = view._magicPrefix.marker;
    editor.setTextInBufferRange(
      [
        [2, 3],
        [2, 5],
      ],
      "text",
    );
    expect((await inspect()).hasError).toBeFalse();
    expect(editor.getBuffer().getLanguageMode()).toBe(mode);
    expect(view.rootRangesDisposable).toBe(policy);
    expect(view._magicPrefix.marker).toBe(marker);
    editor.setText("%%bash\nprintf 'ok'\n");
    expect((await inspect()).start.row).toBe(1);
    expect(editor.getGrammar().scopeName).toBe("source.shell");
    editor.undo();
    await inspect();
    expect(editor.getGrammar().scopeName).toBe("text.html.basic");
    editor.redo();
    await inspect();
    expect(editor.getGrammar().scopeName).toBe("source.shell");
  });
  it("updates the range policy when the notebook language changes but the body grammar stays the same", async () => {
    const editor = mount("%%bash\nprintf 'ok'\n");
    expect((await inspect()).start.row).toBe(1);
    const mode = editor.getBuffer().getLanguageMode();
    await view.update({ ...view.props, notebookLanguage: "shell" });
    expect((await inspect()).start.row).toBe(0);
    expect(editor.getBuffer().getLanguageMode()).toBe(mode);
    expect(view.cellMagic()).toBeNull();
    await view.update({ ...view.props, notebookLanguage: "python" });
    expect((await inspect()).start.row).toBe(1);
    expect(editor.getBuffer().getLanguageMode()).toBe(mode);
  });
  it("reinstalls a portable policy after rebuilding the cell editor", async () => {
    const editor = mount("%%html\n<b>text</b>\n");
    await inspect();
    await view.update({ cell: { ...view.props.cell, type: "markdown" } });
    expect((await inspect()).start.row).toBe(0);
    expect(editor.isDestroyed()).toBeTrue();
    await view.update({ cell: { ...view.props.cell, type: "code" } });
    expect((await inspect()).start.row).toBe(1);
    view.editor.setText("%%html");
    expect((await inspect()).children).toBe(0);
  });
});
