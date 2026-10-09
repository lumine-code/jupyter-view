const path = require("node:path");

describe("notebook source and structural operations", () => {
  let main, editor, editors, document, etch;

  beforeEach(async () => {
    for (const name of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, name).and.resolveTo();
    for (const name of ["language-json", "language-python", "language-gfm", "language-text"])
      await (
        await lumine.packages.activatePackage(name)
      ).resourceLoadPromise;
    await lumine.packages.deactivatePackage("jupyter-view");
    if (lumine.packages.getLoadedPackage("jupyter-view"))
      await lumine.packages.unloadPackage("jupyter-view");
    const pack = await lumine.packages.activatePackage("jupyter-view");
    main = pack.mainModule;
    etch = require(path.join(pack.path, "node_modules/@lumine-code/etch"));
    editor = await main.newNotebook();
    editors = [editor];
    document = editor.document;
    await editor._sourceEditorSetupPromise;
    etch.updateSync(editor.view);
  });

  afterEach(async () => {
    for (const item of editors) item.destroy();
    await lumine.packages.deactivatePackage("jupyter-view");
    await lumine.fileWatchClient.settlePendingTeardown();
  });

  async function splitWithThreeCells() {
    document.insertCell(1);
    document.insertCell(2);
    const split = editor.copy();
    editors.push(split);
    await split._sourceEditorSetupPromise;
    etch.updateSync(split.view);
    split.activeCellIndex = 2;
    split.view.selectedCells = new Set([2]);
    return split;
  }

  it("copies the latest native cell-buffer edit before debounce and preserves paste undo", () => {
    const cell = document.cells[0];
    const input = editor.view.cellViews.get(cell.id).editor;
    input.setText("latest owned source");
    expect(cell.source).not.toBe(input.getText());
    editor.copyCell();
    editor.pasteCellBelow();
    expect(document.cells[0].source).toBe("latest owned source");
    expect(document.cells[1].source).toBe("latest owned source");
    editor.undoCellOperation();
    expect(document.cells.length).toBe(1);
    expect(document.cells[0].source).toBe("latest owned source");
  });

  it("keeps a split's active and selected cell when copied data is inserted before it", async () => {
    const split = await splitWithThreeCells();
    const id = document.cells[2].id;
    const removed = jasmine.createSpy("delete notification");
    const lease = document.onDidDeleteCell(removed);
    try {
      document.insertCellsFromData(0, [document.cells[0].toJSON()], editor);
      expect(removed).not.toHaveBeenCalled();
      expect(document.cells[split.activeCellIndex].id).toBe(id);
      expect([...split.view.selectedCells]).toEqual([3]);
    } finally {
      lease.dispose();
    }
  });

  it("adjusts surviving splits for an actual deletion without double-adjusting its origin", async () => {
    const split = await splitWithThreeCells();
    editor.activeCellIndex = 2;
    const id = document.cells[2].id;
    editor.deleteCellAt(0);
    expect(document.cells[editor.activeCellIndex].id).toBe(id);
    expect(document.cells[split.activeCellIndex].id).toBe(id);
    expect([...split.view.selectedCells]).toEqual([1]);
    document.deleteCell(0);
    expect(split.activeCellIndex).toBe(0);
    expect([...split.view.selectedCells]).toEqual([0]);
  });

  it("terminates a zero-width Unicode search across a surrogate pair", () => {
    document.updateCellSource(0, "😀");
    etch.updateSync(editor.view);
    const adapter = main.provideSearchAdapter().getAdapterForItem(editor);
    const execute = RegExp.prototype.exec;
    let attempts = 0;
    spyOn(RegExp.prototype, "exec").and.callFake(function (text) {
      if (this.source === "(?=)" && this.flags === "gu" && ++attempts > 20) {
        throw new Error("Owned Unicode search exceeded its bounded execution budget");
      }
      return execute.call(this, text);
    });
    expect(() =>
      adapter.search({
        findPattern: "(?=)",
        useRegex: true,
        getFindPatternRegex: () => /(?=)/u,
      }),
    ).not.toThrow();
    expect(attempts).toBeLessThan(20);
    expect(adapter.getResultCount()).toBe(0);
  });

  it("preserves full-cell regex context and capture substitutions while replacing", () => {
    const adapter = main.provideSearchAdapter().getAdapterForItem(editor);
    const input = editor.view.cellViews.get(document.cells[0].id).editor;
    for (const [source, regex, replacement] of [
      ["foobar foobar", /(?<=foo)bar/g, "qux"],
      ["foo bar baz", /bar/g, "$`"],
      ["foo bar baz", /bar/g, "$'"],
      ["one=1 two=2", /(?<key>\w+)=(\d+)/g, "$<key>:$2"],
    ]) {
      input.setText(source);
      editor.flushPendingCellSourceChanges();
      adapter.search({
        findPattern: regex.source,
        useRegex: true,
        getFindPatternRegex: () => regex,
      });
      adapter.replaceAll(replacement);
      expect(input.getText()).toBe(source.replace(regex, replacement));
    }
  });

  it("recomputes matches against a visible cell edit before the delayed rescan", () => {
    const adapter = main.provideSearchAdapter().getAdapterForItem(editor);
    const input = editor.view.cellViews.get(document.cells[0].id).editor;
    input.setText("one target two");
    editor.flushPendingCellSourceChanges();
    adapter.search({
      findPattern: "target",
      useRegex: false,
      getFindPatternRegex: () => /target/g,
    });
    input.setText("prefix one target two");
    adapter.replaceAll("changed");
    expect(input.getText()).toBe("prefix one changed two");
  });
});
