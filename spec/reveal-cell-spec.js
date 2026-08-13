const NotebookDocument = require("../lib/notebook-document");
const JupyterNotebookEditor = require("../lib/jupyter-notebook-editor");

// revealCell is the generic activate-scroll-place-cursor flow behind linter
// navigation and language-server locations. The scroll and cursor halves run
// under requestAnimationFrame, which the headless runner starves, so these
// specs pin the synchronous contract: bounds, active-cell selection, and the
// linter reveal delegating with the message's cell and position.
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

  it("activates the addressed cell and ignores an index out of range", () => {
    editor.revealCell(2);
    expect(editor.activeCellIndex).toBe(2);

    editor.revealCell(99);
    expect(editor.activeCellIndex).toBe(2);
    editor.revealCell(-1);
    expect(editor.activeCellIndex).toBe(2);
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
});
