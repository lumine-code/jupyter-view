const NotebookDocument = require("../lib/notebook-document");
const JupyterNotebookEditor = require("../lib/jupyter-notebook-editor");

// revealCell is the generic activate-scroll-place-cursor flow behind linter
// navigation and language-server locations. The scroll and cursor halves run
// under requestAnimationFrame, which the headless runner starves, so these
// specs pin the contract before those frames: workspace activation, bounds,
// active-cell selection, and linter delegation with the message's position.
describe("JupyterNotebookEditor.revealCell", () => {
  let document_;
  let editor;

  beforeEach(async () => {
    document_ = new NotebookDocument(null);
    await document_.initialize();
    document_.insertCell(1, "markdown");
    document_.insertCell(2, "code");
    editor = new JupyterNotebookEditor(document_);
    await editor._sourceEditorSetupPromise;
  });

  afterEach(() => {
    if (!editor._destroyed) editor.destroy();
    if (document_.refCount <= 0) document_.destroy();
  });

  it("activates the notebook through the workspace before addressing its cell", async () => {
    const open = spyOn(lumine.workspace, "open").and.callThrough();
    await editor.revealCell(2);
    expect(editor.activeCellIndex).toBe(2);
    expect(open).toHaveBeenCalledWith(editor, { searchAllPanes: true });

    await editor.revealCell(99);
    expect(editor.activeCellIndex).toBe(2);
    await editor.revealCell(-1);
    expect(editor.activeCellIndex).toBe(2);
  });

  it("completes source-range navigation with a native cell editor", async () => {
    await lumine.workspace.open(editor);
    jasmine.attachToDOM(lumine.workspace.getElement());
    const cell = document_.cells[2];
    document_.updateCellSource(2, "first\nsecond\nthird");
    editor.view.setMode("edit");
    const cellEditor = editor.getCellEditorById(cell.id);
    expect(cellEditor).toBeTruthy();
    const requested = jasmine.createSpy("native cell reveal");
    const subscription = cellEditor.onDidRequestAutoscroll(requested);
    try {
      const range = [
        [1, 0],
        [1, 3],
      ];
      await editor.revealCellById(cell.id, range);
      expect(cellEditor.getSelectedBufferRange().serialize()).toEqual(range);
      expect(requested.calls.mostRecent().args[0].options.mode).toEqual(cellEditor.getScrollZone());
      expect(requested.calls.mostRecent().args[0].options.reversed).toBe(
        cellEditor.getLastSelection().isReversed(),
      );
    } finally {
      subscription.dispose();
    }
  });

  it("reveals a linter message through its cell and cell-relative position", () => {
    spyOn(editor, "revealCell");
    const message = {
      location: {
        file: null,
        cell: 3,
        position: { start: { row: 1, column: 2 }, end: { row: 1, column: 5 } },
        buffer: null,
      },
    };
    // Message ownership is not the question here; resolve the index directly.
    spyOn(editor, "getLinterMessageCellIndex").and.returnValue(2);

    editor.revealLinterMessage(message);

    expect(editor.revealCell).toHaveBeenCalledWith(2, { row: 1, column: 2 });
  });

  it("activates the notebook through the workspace before revealing a navigation header", async () => {
    const open = spyOn(lumine.workspace, "open").and.callThrough();

    await editor.revealNavigationHeader({ cellIndex: 1, cellRow: 0 });

    expect(open).toHaveBeenCalledWith(editor, { searchAllPanes: true });
    expect(editor.activeCellIndex).toBe(1);
  });
});
