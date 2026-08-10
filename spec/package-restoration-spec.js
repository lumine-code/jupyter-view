const NotebookDocumentRegistry = require("../lib/notebook-document-registry");
const main = require("../lib/main");

describe("package restoration lifecycle", () => {
  it("restores the document registry before pane deserialization", async () => {
    const sourceRegistry = new NotebookDocumentRegistry();
    const sourceDocument = await sourceRegistry.createUntitledDocument();
    sourceDocument.updateCellSource(0, "print('restored')");
    const documentId = sourceDocument.id;
    const packageState = { documents: sourceRegistry.serialize() };
    sourceRegistry.destroy();

    const previousRegistry = main.documentRegistry;
    const previousEditors = main.notebookEditors;
    const previousScrollmaps = main.notebookScrollmaps;
    let editor;

    try {
      main.documentRegistry = null;
      main.notebookEditors = new Set();
      main.notebookScrollmaps = new Map();
      main.initialize(packageState);

      editor = main.deserializeNotebookEditor({
        documentId,
        viewState: { activeCellIndex: 0 },
      });
      await editor._loadingPromise;

      expect(editor._loadError).toBeNull();
      expect(editor.document).toBeDefined();
      expect(editor.document.id).toBe(documentId);
      expect(editor.document.getCell(0).source).toBe("print('restored')");
    } finally {
      if (editor && !editor._destroyed) editor.destroy();
      main.documentRegistry?.destroy();
      main.documentRegistry = previousRegistry;
      main.notebookEditors = previousEditors;
      main.notebookScrollmaps = previousScrollmaps;
    }
  });
});
