const NotebookDocument = require("../lib/notebook-document");
const JupyterNotebookEditor = require("../lib/jupyter-notebook-editor");

// The workspace resolves the status bar's editors through this item protocol
// (Workspace#getActiveFileTextEditor / #getActiveEmbeddedTextEditor): the
// backing source editor answers for the file — encoding and line endings —
// and the active cell's editor for what is being edited.
describe("JupyterNotebookEditor text-editor resolution", () => {
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

  it("names the backing source editor as the file text editor", () => {
    expect(editor.getFileTextEditor()).not.toBe(null);
    expect(editor.getFileTextEditor()).toBe(editor.getSourceEditor());
  });

  it("names the active cell's editor as the embedded text editor and signals cell changes", () => {
    const signals = [];
    editor.onDidChangeActiveTextEditors(() => signals.push(true));

    editor.setActiveCell(0);
    const first = editor.getActiveEmbeddedTextEditor();
    expect(first).not.toBe(null);
    expect(first).toBe(editor.getCellEditor(1));

    editor.setActiveCell(2);
    expect(signals.length).toBeGreaterThan(0);
    const third = editor.getActiveEmbeddedTextEditor();
    expect(third).toBe(editor.getCellEditor(3));
    expect(third).not.toBe(first);
  });

  it("resolves no embedded editor for a rendered markdown cell", () => {
    editor.setActiveCell(1);
    expect(editor.getActiveEmbeddedTextEditor()).toBe(null);
  });
});
