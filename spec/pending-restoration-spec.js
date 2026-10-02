describe("pending notebook view ownership", () => {
  let Registry, NotebookEditor, registry;
  const data = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        id: "cell",
        cell_type: "code",
        source: ["restored source"],
        metadata: {},
        outputs: [],
        execution_count: null,
      },
    ],
  };

  beforeEach(() => {
    Registry = require("../lib/notebook-document-registry");
    NotebookEditor = require("../lib/jupyter-notebook-editor");
    registry = new Registry({ document: { filePath: null, notebookData: data } });
  });
  afterEach(() => registry.destroy());

  it("releases a restored document when its only placeholder closes during loading", async () => {
    const editor = NotebookEditor.deserialize(
      { documentId: "document" },
      { documentRegistry: registry },
    );
    const loading = editor._loadingPromise;
    editor.destroy();
    await loading;
    expect(editor.document).toBeNull();
    expect(registry.getDocuments()).toEqual([]);
    expect(registry._pendingViews.size).toBe(0);
  });

  it("keeps the shared load for a surviving split when the earlier placeholder closes", async () => {
    const first = NotebookEditor.deserialize(
      { documentId: "document" },
      { documentRegistry: registry },
    );
    const second = NotebookEditor.deserialize(
      { documentId: "document" },
      { documentRegistry: registry },
    );
    const loading = Promise.all([first._loadingPromise, second._loadingPromise]);
    first.destroy();
    try {
      await loading;
      expect(first.document).toBeNull();
      expect(second.document).toBeDefined();
      expect(second.document.isDestroyed()).toBe(false);
      expect(second.document.refCount).toBe(1);
      expect(second.document.getCell(0).source).toBe("restored source");
      expect(registry.getDocuments()).toEqual([second.document]);
      expect(registry._pendingViews.size).toBe(0);
    } finally {
      second.destroy();
    }
  });
});
