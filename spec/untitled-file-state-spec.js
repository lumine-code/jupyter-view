const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("untitled notebook file state", () => {
  let NotebookDocumentRegistry;
  let directory;
  let registries;
  let editors;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const name of ["language-json", "language-python", "language-gfm", "language-text"]) {
      const grammarPackage = await lumine.packages.activatePackage(name);
      await grammarPackage.resourceLoadPromise;
    }
    NotebookDocumentRegistry = require("../lib/notebook-document-registry");
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "notebook-untitled-state-"));
    registries = [];
    editors = [];
  });

  afterEach(async () => {
    for (const editor of editors) editor.destroy();
    for (const registry of registries) registry.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    await fs.promises.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  function createRegistry(state) {
    const registry = new NotebookDocumentRegistry(state);
    registries.push(registry);
    return registry;
  }

  async function createEditor(registry = createRegistry(), filePath = null) {
    const editor = await registry.buildEditor(filePath);
    editors.push(editor);
    await editor._sourceEditorSetupPromise;
    return editor;
  }

  it("starts clean and prompts only after an edit, including undo and redo", async () => {
    const editor = await createEditor();
    const document = editor.document;
    const states = [];
    editor.onDidChangeFileState((state) => states.push(state));
    lumine.config.set("core.promptOnCloseDirtyBuffer", true);

    expect(editor.getPath()).toBeNull();
    expect(document.isModified()).toBe(false);
    expect(editor.getFileState()).toBe("unmodified");
    expect(editor.shouldPromptToSave({ lastView: true })).toBe(false);
    document.updateCellSource(0, "");
    expect(states).toEqual([]);

    editor.getCellEditor(1).insertText("print('changed')");
    expect(document.getCell(0).source).toBe("");
    expect(editor.getFileState()).toBe("modified");
    expect(editor.shouldPromptToSave({ lastView: true })).toBe(true);
    editor.sourceController.flushPendingChanges(editor);
    expect(document.isModified()).toBe(true);
    expect(editor.getFileState()).toBe("modified");
    expect(editor.shouldPromptToSave({ lastView: true })).toBe(true);

    editor.undoCellOperation();
    expect(document.getCell(0).source).toBe("");
    expect(document.isModified()).toBe(false);
    expect(editor.getFileState()).toBe("unmodified");
    expect(editor.shouldPromptToSave({ lastView: true })).toBe(false);

    editor.redoCellOperation();
    expect(document.getCell(0).source).toBe("print('changed')");
    expect(editor.getFileState()).toBe("modified");
    expect(states).toEqual(["modified", "unmodified", "modified"]);
  });

  it("shares pending input state across splits and clears it when input is reverted", async () => {
    const editor = await createEditor();
    const copy = editor.copy();
    editors.push(copy);
    await copy._sourceEditorSetupPromise;
    const firstStates = [];
    const secondStates = [];
    editor.onDidChangeFileState((state) => firstStates.push(state));
    copy.onDidChangeFileState((state) => secondStates.push(state));
    const cellEditor = editor.getCellEditor(1);

    cellEditor.insertText("pending");
    expect(editor.document.getCell(0).source).toBe("");
    expect(editor.getFileState()).toBe("modified");
    expect(copy.getFileState()).toBe("modified");

    cellEditor.setText("");
    expect(editor.document.isModified()).toBe(false);
    expect(editor.getFileState()).toBe("unmodified");
    expect(copy.getFileState()).toBe("unmodified");
    expect(firstStates).toEqual(["modified", "unmodified"]);
    expect(secondStates).toEqual(firstStates);
  });

  it("preserves pending input when the edited split closes", async () => {
    const editor = await createEditor();
    const copy = editor.copy();
    editors.push(copy);
    await copy._sourceEditorSetupPromise;
    editor.getCellEditor(1).insertText("pending input");

    editor.destroy();

    expect(copy.document.getCell(0).source).toBe("pending input");
    expect(copy.getFileState()).toBe("modified");
  });

  it("commits pending markdown before command mode destroys its cell editor", async () => {
    const editor = await createEditor();
    editor.changeCellType("markdown");
    await editor.saveAs(path.join(directory, "markdown.ipynb"));
    editor.view.enterEditMode();
    const cellId = editor.document.getCell(0).id;
    editor.getCellEditorById(cellId).insertText("# Pending markdown");
    expect(editor.document.getCell(0).source).toBe("");
    expect(editor.getFileState()).toBe("modified");

    editor.view.enterCommandMode();

    expect(editor.document.getCell(0).source).toBe("# Pending markdown");
    expect(editor.getCellEditorById(cellId)).toBeNull();
    expect(editor.view.element.querySelector(".markdown-rendered h1").textContent).toBe(
      "Pending markdown",
    );
    expect(editor.getFileState()).toBe("modified");
  });

  it("marks execution output as a change to the initial notebook", async () => {
    const editor = await createEditor();
    editor.document.getCell(0).addOutput({
      output_type: "stream",
      name: "stdout",
      text: "result",
    });

    expect(editor.document.isModified()).toBe(true);
    expect(editor.getFileState()).toBe("modified");
  });

  it("saves a pristine notebook when explicitly requested", async () => {
    const editor = await createEditor();
    const filePath = path.join(directory, "pristine.ipynb");
    expect(editor.getFileState()).toBe("unmodified");

    expect(await editor.saveAs(filePath)).toBe(true);

    expect(editor.getPath()).toBe(filePath);
    expect(editor.getFileState()).toBe("unmodified");
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(saved.cells.length).toBe(1);
    expect(saved.cells[0].source).toEqual([]);
    expect(saved.metadata.kernelspec.name).toBe("python3");

    await lumine.workspace.open(editor);
    editor.getCellEditor(1).insertText("saved immediately");
    await lumine.workspace.saveAll();
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).cells[0].source).toEqual([
      "saved immediately",
    ]);
    expect(editor.getFileState()).toBe("unmodified");
  });

  it("includes pending input when serializing a previously saved notebook", async () => {
    const editor = await createEditor();
    await editor.saveAs(path.join(directory, "saved.ipynb"));
    editor.getCellEditor(1).insertText("pending after save");
    expect(editor.document.getCell(0).source).toBe("");

    const state = editor.document.serializeState();

    expect(state.notebookData.cells[0].source).toEqual(["pending after save"]);
    expect(state.fileState).toBe("modified");
    expect(state.currentHistoryStateId).not.toBe(state.savedHistoryStateId);
  });

  for (const source of ["", "unsaved source"]) {
    it(`restores an untitled notebook ${source ? "with edits" : "without edits"}`, async () => {
      const registry = createRegistry();
      const editor = await createEditor(registry);
      const documentId = editor.document.id;
      if (source) {
        editor.getCellEditor(1).insertText(source);
        expect(editor.document.getCell(0).source).toBe("");
      }
      const state = registry.serialize();
      editor.destroy();
      registry.destroy();

      const restoredRegistry = createRegistry(state);
      const restoredDocument = await restoredRegistry.getOrCreateDocumentById(documentId);
      const NotebookEditor = require("../lib/jupyter-notebook-editor");
      const restored = new NotebookEditor(restoredDocument);
      editors.push(restored);
      await restored._sourceEditorSetupPromise;

      expect(restored.getPath()).toBeNull();
      expect(restoredDocument.getCell(0).source).toBe(source);
      expect(restoredDocument.isModified()).toBe(Boolean(source));
      expect(restored.getFileState()).toBe(source ? "modified" : "unmodified");
    });
  }

  it("keeps a notebook opened at a missing path modified", async () => {
    const editor = await createEditor(createRegistry(), path.join(directory, "missing.ipynb"));

    expect(editor.document.isModified()).toBe(true);
    expect(editor.getFileState()).toBe("modified");
  });

  it("keeps imported notebook data modified before its first save", async () => {
    const initial = await createEditor();
    const registry = createRegistry();
    const imported = await registry.buildEditorFromData(initial.document.toJSON());
    editors.push(imported);
    await imported._sourceEditorSetupPromise;

    expect(imported.getPath()).toBeNull();
    expect(imported.document.isModified()).toBe(true);
    expect(imported.getFileState()).toBe("modified");
  });
});
