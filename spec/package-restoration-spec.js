const fs = require("fs");
const os = require("os");
const path = require("path");
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

  it("feeds a restored notebook's cells to the language-server bridge without an edit", async () => {
    // The user's startup flow: an unmodified notebook restores by reading the
    // disk after the pane item and the bridge already exist. The servers must
    // receive the loaded cells with no keystroke involved.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jv-restore-"));
    const filePath = path.join(dir, "restored.ipynb");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        cells: [
          { cell_type: "markdown", id: "m1", metadata: {}, source: ["# hi\n"] },
          {
            cell_type: "code",
            id: "c1",
            metadata: {},
            outputs: [],
            execution_count: null,
            source: ["import os\n"],
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
    );

    const sourceRegistry = new NotebookDocumentRegistry();
    const sourceDocument = await sourceRegistry.getOrCreateDocument(filePath);
    const documentId = sourceDocument.id;
    const packageState = { documents: sourceRegistry.serialize() };
    sourceRegistry.destroy();

    const previousRegistry = main.documentRegistry;
    const previousEditors = main.notebookEditors;
    const previousScrollmaps = main.notebookScrollmaps;
    let editor;
    let serviceDisposable;

    try {
      main.documentRegistry = null;
      main.notebookEditors = new Set();
      main.notebookScrollmaps = new Map();
      main.initialize(packageState);

      const opened = [];
      serviceDisposable = main.consumeIdeClient({
        adaptersForNotebook: () => [],
        openNotebookDocument(descriptor) {
          const bridge = {
            descriptor,
            updates: [],
            attached: Promise.resolve(),
            updateCells(cells) {
              this.updates.push(cells);
              return Promise.resolve();
            },
            didSave() {},
            dispose() {},
          };
          opened.push(bridge);
          return bridge;
        },
      });

      editor = main.deserializeNotebookEditor({
        documentId,
        viewState: { activeCellIndex: 0 },
      });
      await editor._loadingPromise;
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));

      expect(editor._loadError).toBeNull();
      expect(opened.length).toBe(1);
      const cellsSeen = opened[0].updates.length
        ? opened[0].updates[opened[0].updates.length - 1]
        : opened[0].descriptor.cells;
      expect(cellsSeen.map((cell) => cell.kind)).toEqual(["markup", "code"]);
      expect(cellsSeen[1].text).toBe("import os\n");
    } finally {
      serviceDisposable?.dispose();
      if (editor && !editor._destroyed) editor.destroy();
      main.documentRegistry?.destroy();
      main.documentRegistry = previousRegistry;
      main.notebookEditors = previousEditors;
      main.notebookScrollmaps = previousScrollmaps;
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
