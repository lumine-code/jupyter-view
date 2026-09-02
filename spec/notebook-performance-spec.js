const fs = require("fs");
const os = require("os");
const path = require("path");
const { FileState } = require("lumine");
const NotebookDocument = require("../lib/notebook-document");
const NotebookDocumentRegistry = require("../lib/notebook-document-registry");
const JupyterNotebookEditor = require("../lib/jupyter-notebook-editor");
const main = require("../lib/main");

describe("notebook change tracking", () => {
  let documents = [];
  let editors = [];
  let tempDirectories = [];

  afterEach(() => {
    for (const editor of editors) {
      if (!editor._destroyed) editor.destroy();
    }
    for (const document of documents) {
      if (document.refCount <= 0) document.destroy();
    }
    editors = [];
    documents = [];
    for (const directory of tempDirectories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    tempDirectories = [];
  });

  async function buildDocument() {
    const document = new NotebookDocument(null);
    documents.push(document);
    await document.initialize();
    document._markCurrentStateSaved();
    return document;
  }

  async function buildFileDocument() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jupyter-file-state-"));
    const filePath = path.join(directory, "notebook.ipynb");
    const notebook = {
      cells: [
        {
          cell_type: "code",
          id: "cell-1",
          metadata: {},
          source: ["saved\n"],
          execution_count: null,
          outputs: [],
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    fs.writeFileSync(filePath, JSON.stringify(notebook, null, 2));
    tempDirectories.push(directory);
    const document = new NotebookDocument(filePath);
    documents.push(document);
    await document._loadFromFile();
    document._markCurrentStateSaved();
    return { document, filePath, notebook };
  }

  it("shares one exclusive file state across split views", async () => {
    const { document } = await buildFileDocument();
    const first = new JupyterNotebookEditor(document);
    const second = new JupyterNotebookEditor(document);
    editors.push(first, second);
    const firstStates = [];
    const secondStates = [];
    first.onDidChangeFileState((fileState) => firstStates.push(fileState));
    second.onDidChangeFileState((fileState) => secondStates.push(fileState));

    expect(first.getFileState()).toBe(FileState.UNMODIFIED);
    document.updateCellSource(0, "local edit", first);

    expect(first.getFileState()).toBe(FileState.MODIFIED);
    expect(second.getFileState()).toBe(FileState.MODIFIED);
    expect(firstStates).toEqual([FileState.MODIFIED]);
    expect(secondStates).toEqual([FileState.MODIFIED]);
    expect(first.shouldPromptToSave()).toBe(false, "another split still owns the document");

    second.destroy();
    expect(first.shouldPromptToSave()).toBe(true);
    const promptOnClose = lumine.config.get("core.promptOnCloseDirtyBuffer");
    lumine.config.set("core.promptOnCloseDirtyBuffer", false);
    expect(first.shouldPromptToSave()).toBe(false);
    lumine.config.set("core.promptOnCloseDirtyBuffer", promptOnClose);
  });

  it("distinguishes no-op disk events, conflicts, disk reverts, and removal", async () => {
    const { document, filePath, notebook } = await buildFileDocument();
    const states = [];
    document.onDidChangeFileState((fileState) => states.push(fileState));
    document.updateCellSource(0, "local edit");

    // Reformatting the saved revision is not a conflict.
    fs.writeFileSync(filePath, JSON.stringify(notebook));
    await document._handleFileChange();
    expect(document.getFileState()).toBe(FileState.MODIFIED);

    const external = structuredClone(notebook);
    external.cells[0].source = ["external\n"];
    fs.writeFileSync(filePath, JSON.stringify(external));
    await document._handleFileChange();
    expect(document.getFileState()).toBe(FileState.CONFLICTED);
    expect(document.getCell(0).source).toBe("local edit");

    fs.writeFileSync(filePath, JSON.stringify(notebook, null, 2));
    await document._handleFileChange();
    expect(document.getFileState()).toBe(FileState.MODIFIED);

    document._watchFile();
    document.file.emitter.emit("did-delete");
    expect(document.getFileState()).toBe(FileState.REMOVED);
    document.savedHistoryStateId = document.currentHistoryStateId;
    document.savedRuntimeRevision = document.runtimeRevision;
    document.updateModifiedState();
    expect(document.getFileState()).toBe(FileState.REMOVED);

    expect(await document.save()).toBe(true);
    expect(document.getFileState()).toBe(FileState.UNMODIFIED);
    expect(states).toEqual([
      FileState.MODIFIED,
      FileState.CONFLICTED,
      FileState.MODIFIED,
      FileState.REMOVED,
      FileState.UNMODIFIED,
    ]);
  });

  it("reloads a changed disk revision when the document is clean", async () => {
    const { document, filePath, notebook } = await buildFileDocument();
    const external = structuredClone(notebook);
    external.cells[0].source = ["external\n"];
    fs.writeFileSync(filePath, JSON.stringify(external));

    await document._handleFileChange();

    expect(document.getCell(0).source).toBe("external\n");
    expect(document.getFileState()).toBe(FileState.UNMODIFIED);
  });

  it("turns an async reload into a conflict when an edit wins the race", async () => {
    const { document, filePath, notebook } = await buildFileDocument();
    const external = structuredClone(notebook);
    external.cells[0].source = ["external\n"];
    fs.writeFileSync(filePath, JSON.stringify(external));
    const revision = await document._readFile();
    let finishRead;
    spyOn(document, "_readFileWithRetries").and.returnValue(
      new Promise((resolve) => {
        finishRead = () => resolve(revision);
      }),
    );

    const reload = document._handleFileChange();
    document.updateCellSource(0, "local edit");
    finishRead();
    await reload;

    expect(document.getCell(0).source).toBe("local edit");
    expect(document.getFileState()).toBe(FileState.CONFLICTED);
  });

  it("serializes and revalidates a restored non-unmodified state", async () => {
    const { document, filePath, notebook } = await buildFileDocument();
    document.updateCellSource(0, "local edit");
    const external = structuredClone(notebook);
    external.cells[0].source = ["external\n"];
    fs.writeFileSync(filePath, JSON.stringify(external));
    await document._handleFileChange();
    const state = document.serializeState();

    expect(state.fileState).toBe(FileState.CONFLICTED);
    expect(state.notebookData.cells[0].source).toEqual(["local edit"]);
    expect(state.savedDiskFingerprint).not.toBeNull();

    const restored = new NotebookDocument(filePath);
    documents.push(restored);
    await restored.initializeFromData(state.notebookData);
    restored.restoreState(state);
    await restored.reconcileRestoredFileState();
    expect(restored.getFileState()).toBe(FileState.CONFLICTED);
    expect(restored.getCell(0).source).toBe("local edit");

    fs.writeFileSync(filePath, JSON.stringify(notebook));
    await restored.reconcileRestoredFileState();
    expect(restored.getFileState()).toBe(FileState.MODIFIED);

    fs.rmSync(filePath);
    await restored.reconcileRestoredFileState();
    expect(restored.getFileState()).toBe(FileState.REMOVED);
  });

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

  it("projects one cell diagnostic onto every split cell buffer", async () => {
    const document = await buildDocument();
    const first = new JupyterNotebookEditor(document);
    const second = new JupyterNotebookEditor(document);
    editors.push(first, second);
    await Promise.all([first._sourceEditorSetupPromise, second._sourceEditorSetupPromise]);
    const sourceBuffer = first.getSourceEditor().getBuffer();
    const diagnostic = {
      location: {
        buffer: sourceBuffer,
        cell: 1,
        position: [
          [0, 0],
          [0, 1],
        ],
      },
    };
    const previousEditors = main.notebookEditors;
    main.notebookEditors = new Set([first, second]);

    try {
      const locations = main.provideLinterAdapter().getMarkerLocationsForMessage(diagnostic);

      expect(locations.length).toBe(2);
      expect(locations.map((location) => location.buffer)).toEqual([
        first.getCellEditor(1).getBuffer(),
        second.getCellEditor(1).getBuffer(),
      ]);
      expect(locations.map((location) => location.cell)).toEqual([1, 1]);
      expect(diagnostic.location.buffer).toBe(sourceBuffer);
    } finally {
      main.notebookEditors = previousEditors;
    }
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

  it("restores the source projection of a file-backed notebook", async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "jupyter-view-source-"));
    const filePath = path.join(tempDirectory, "restored-notebook.ipynb");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
          language_info: { name: "python" },
        },
        cells: [
          {
            cell_type: "code",
            id: "restored-cell",
            metadata: {},
            source: ["undefined_name\n"],
            execution_count: null,
            outputs: [],
          },
        ],
      }),
    );
    const registry = new NotebookDocumentRegistry();
    const document = await registry.getOrCreateDocument(filePath);
    const editor = new JupyterNotebookEditor(document);
    await editor._sourceEditorSetupPromise;
    const sourceText = editor.getSourceEditor().getText();
    const documentId = document.id;
    const packageState = registry.serialize();

    expect(packageState[documentId].notebookData).toBeNull();
    expect(packageState[documentId].sourceControllerState.bufferState.filePath).toBeUndefined();
    expect(packageState[documentId].sourceControllerState.bufferState.text).toBe(sourceText);

    // State written by the previous implementation had history metadata but
    // neither a file path nor text. The first restart after upgrading must
    // recover directly from that state instead of requiring an edit and a
    // second restart.
    delete packageState[documentId].sourceControllerState.bufferState.text;

    editor.destroy();
    registry.destroy();

    await lumine.packages.activatePackage("language-json");
    const restoredRegistry = new NotebookDocumentRegistry(packageState);
    const restoredDocument = await restoredRegistry.getOrCreateDocumentById(documentId);
    const restoredEditor = new JupyterNotebookEditor(restoredDocument);
    await restoredEditor._sourceEditorSetupPromise;
    const restoredSourceEditor = restoredEditor.getSourceEditor();

    expect(restoredSourceEditor.getText()).toBe(sourceText);
    expect(restoredSourceEditor.getText()).toContain("undefined_name");
    expect(restoredSourceEditor.getPath()).toBe(restoredDocument.filePath);
    expect(restoredSourceEditor.getGrammar().scopeName).toBe("source.jupyter");
    expect(lumine.textEditors.roleFor(restoredSourceEditor)).toBe("background");

    restoredEditor.destroy();
    restoredRegistry.destroy();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
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
