const NotebookDocument = require("../lib/notebook-document");
const NotebookDocumentRegistry = require("../lib/notebook-document-registry");
const JupyterNotebookEditor = require("../lib/jupyter-notebook-editor");

describe("notebook change tracking", () => {
  let documents = [];
  let editors = [];

  afterEach(() => {
    for (const editor of editors) {
      if (!editor._destroyed) editor.destroy();
    }
    for (const document of documents) {
      if (document.refCount <= 0) document.destroy();
    }
    editors = [];
    documents = [];
  });

  async function buildDocument() {
    const document = new NotebookDocument(null);
    documents.push(document);
    await document.initialize();
    document._markCurrentStateSaved();
    return document;
  }

  it("classifies history, runtime and transient changes without hashing outputs", async () => {
    const document = await buildDocument();
    const cell = document.getCell(0);
    const events = [];
    document.onDidChange((event) => events.push(event));

    cell.outputs = [
      {
        output_type: "display_data",
        toJSON() {
          throw new Error("output was serialized on the interactive path");
        },
      },
    ];

    expect(() => document.updateCellSource(0, "print('fast')")).not.toThrow();
    expect(events.length).toBe(1);
    expect(events[0].category).toBe("history");
    expect(events[0].affectsSource).toBe(true);

    document._markCurrentStateSaved();
    events.length = 0;
    cell.toggleInputVisibility();
    expect(events.length).toBe(1);
    expect(events[0].category).toBe("transient");
    expect(document.isModified()).toBe(false);

    cell.addOutput({ output_type: "stream", name: "stdout", text: "x" });
    expect(events[1].category).toBe("runtime");
    expect(document.isModified()).toBe(true);
  });

  it("keeps runtime dirty when source history returns to the saved state", async () => {
    const document = await buildDocument();
    const savedStateId = document.savedHistoryStateId;
    const savedNotebook = document.toJSON();

    document.updateCellSource(0, "changed");
    document.getCell(0).addOutput({ output_type: "stream", name: "stdout", text: "result" });
    document.applySourceSnapshot(savedNotebook, {
      historyStateId: savedStateId,
      cellIds: [document.getCell(0).id],
    });

    expect(document.currentHistoryStateId).toBe(savedStateId);
    expect(document.runtimeRevision).toBeGreaterThan(document.savedRuntimeRevision);
    expect(document.isModified()).toBe(true);
  });

  it("uses one source controller and one source editor for split views", async () => {
    const document = await buildDocument();
    const first = new JupyterNotebookEditor(document);
    const second = new JupyterNotebookEditor(document);
    editors.push(first, second);
    await Promise.all([first._sourceEditorSetupPromise, second._sourceEditorSetupPromise]);

    expect(first.sourceController).toBe(second.sourceController);
    expect(first.getSourceEditor()).toBe(second.getSourceEditor());
    expect(first.sourceController.editors.size).toBe(2);

    spyOn(first.sourceController, "scheduleSnapshot").and.callThrough();
    document.getCell(0).addOutput({ output_type: "stream", name: "stdout", text: "x" });
    expect(first.sourceController.scheduleSnapshot).not.toHaveBeenCalled();
    document.updateCellSource(0, "changed", first);
    expect(first.sourceController.scheduleSnapshot).toHaveBeenCalledTimes(1);
  });

  it("serializes a document and its source history once regardless of split count", async () => {
    const registry = new NotebookDocumentRegistry();
    const document = await registry.createUntitledDocument();
    const serialize = jasmine.createSpy("serializeSourceHistory").and.returnValue({
      bufferState: { text: "{}" },
    });
    document._sourceController = { serialize };

    const state = registry.serialize();
    expect(Object.keys(state)).toEqual([document.id]);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(state[document.id].sourceControllerState.bufferState.text).toBe("{}");
    registry.destroy();
  });

  it("restores shared undo history from the package-level document record", async () => {
    const registry = new NotebookDocumentRegistry();
    const document = await registry.createUntitledDocument();
    const editor = new JupyterNotebookEditor(document);
    await editor._sourceEditorSetupPromise;

    document.updateCellSource(0, "after restart", editor);
    editor.sourceController.flushPendingChanges(editor);
    const packageState = registry.serialize();
    const documentId = document.id;
    editor.destroy();
    registry.destroy();

    const restoredRegistry = new NotebookDocumentRegistry(packageState);
    const restoredDocument = await restoredRegistry.getOrCreateDocumentById(documentId);
    const first = new JupyterNotebookEditor(restoredDocument);
    const second = new JupyterNotebookEditor(restoredDocument);
    await Promise.all([first._sourceEditorSetupPromise, second._sourceEditorSetupPromise]);

    expect(first.document).toBe(second.document);
    expect(first.getSourceEditor()).toBe(second.getSourceEditor());
    expect(restoredDocument.getCell(0).source).toBe("after restart");

    restoredDocument.updateCellSource(0, "other content", first);
    first.sourceController.commitSnapshot("test", first);
    first.getCellEditor(1).setCursorBufferPosition([0, 3]);
    second.getCellEditor(1).setCursorBufferPosition([0, 8]);
    second.undoCellOperation();
    expect(restoredDocument.getCell(0).source).toBe("after restart");
    expect(first.getCellEditor(1).getCursorBufferPosition().column).toBe(3);

    first.undoCellOperation();
    expect(restoredDocument.getCell(0).source).toBe("");
    expect(second.document.getCell(0).source).toBe("");

    first.destroy();
    second.destroy();
    restoredRegistry.destroy();
  });
});

describe("large notebook performance fixture", () => {
  it("keeps the source projection independent of 50 MB of outputs", async () => {
    const document = new NotebookDocument(null);
    await document.initialize();
    const template = document.getCell(0);
    const CellModel = require("../lib/cell-model");
    const oneMegabyte = "x".repeat(1024 * 1024);
    template.outputs = Array.from({ length: 50 }, () => ({
      output_type: "display_data",
      data: { "image/png": oneMegabyte },
    }));
    document.cells = Array.from(
      { length: 1000 },
      (_, index) =>
        new CellModel({
          id: `cell-${index}`,
          type: "code",
          source: "x".repeat(1024),
          outputs: index === 0 ? template.outputs : [],
          executionCount: null,
          metadata: {},
        }),
    );
    document._resubscribeCells();

    const editor = Object.create(JupyterNotebookEditor.prototype);
    editor.document = document;
    editor.activeCellIndex = 0;
    editor.view = null;
    const projection = editor.getSourceEditorJSON({ includeHistoryState: false });

    expect(projection.cells.length).toBe(1000);
    expect(projection.cells[0].outputs).toEqual([]);
    expect(JSON.stringify(projection).length).toBeLessThan(2 * 1024 * 1024);
    document.destroy();
  });
});
