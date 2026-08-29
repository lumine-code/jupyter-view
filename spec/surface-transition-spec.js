const NotebookDocument = require("../lib/notebook-document");
const JupyterNotebookEditor = require("../lib/jupyter-notebook-editor");

describe("Jupyter notebook detached surface", () => {
  let notebookDocument;
  let editor;
  let detachedPane;
  let frame;

  beforeEach(async () => {
    notebookDocument = new NotebookDocument(null);
    await notebookDocument.initialize();
    notebookDocument.updateCellSource(0, "value = 1");
    notebookDocument.getCell(0).outputs = [
      {
        output_type: "display_data",
        data: { "image/png": "AAAA", "text/plain": "<image>" },
        metadata: {},
      },
    ];
    editor = new JupyterNotebookEditor(notebookDocument);
    await editor._sourceEditorSetupPromise;
    lumine.workspace.getCenter().getActivePane().addItem(editor);
  });

  afterEach(async () => {
    if (detachedPane?.isAlive?.()) {
      await lumine.workspace.attachDetachedPane(detachedPane);
    }
    if (!editor._destroyed) editor.destroy();
    frame?.remove();
    if (notebookDocument.refCount <= 0) notebookDocument.destroy();
  });

  it("rebuilds outputs and cell editors while preserving edits, cursor and scroll", async () => {
    const primaryView = editor.view;
    const primaryCellEditor = editor.getCellEditor(1);
    primaryCellEditor.setCursorBufferPosition([0, 5]);
    editor.view.cellsContainer.scrollTop = 7;

    frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const primarySurface = { document, window };
    const detachedSurface = {
      document: frame.contentDocument,
      window: frame.contentWindow,
    };
    const transition = editor.beginWindowSurfaceTransition({
      item: editor,
      from: primarySurface,
      to: detachedSurface,
    });
    detachedPane = lumine.workspace.getCenter().detachPaneItem(editor);
    detachedSurface.document.body.appendChild(editor.getElement());
    transition.commit({ item: editor, from: primarySurface, to: detachedSurface });

    expect(editor.view).not.toBe(primaryView);
    expect(editor.getElement().ownerDocument).toBe(detachedSurface.document);
    expect(editor.view.element.ownerDocument).toBe(detachedSurface.document);
    expect(editor.view.element.querySelector(".jupyter-output-container").ownerDocument).toBe(
      detachedSurface.document,
    );

    const detachedCellEditor = editor.getCellEditor(1);
    detachedCellEditor.setCursorBufferPosition([0, 5]);
    detachedCellEditor.insertText("_detached");
    editor.view.cellsContainer.scrollTop = 11;
    const detachedView = editor.view;
    const attachTransition = editor.beginWindowSurfaceTransition({
      item: editor,
      from: detachedSurface,
      to: primarySurface,
    });
    lumine.workspace.getCenter().attachDetachedPane(detachedPane);
    document.body.appendChild(editor.getElement());
    attachTransition.commit({ item: editor, from: detachedSurface, to: primarySurface });
    detachedPane = null;

    expect(editor.view).not.toBe(detachedView);
    expect(editor.getElement().ownerDocument).toBe(document);
    expect(editor.view.element.ownerDocument).toBe(document);
    expect(editor.getCellEditor(1).getText()).toContain("_detached");
    expect(editor.getCellEditor(1).getCursorBufferPosition().column).toBeGreaterThan(5);
    expect(editor.view.element.querySelector(".jupyter-output-container")).toBeTruthy();
  });
});
