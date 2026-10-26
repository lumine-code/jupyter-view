const { TextBuffer } = require("lumine");

describe("canonical notebook source snapshots", () => {
  let documents;
  beforeEach(() => {
    jasmine.useRealClock();
    documents = [];
  });
  afterEach(() => {
    for (const document of documents) document.destroy();
  });

  function source(text) {
    const buffer = new TextBuffer(text);
    const result = buffer.getTextSnapshot();
    buffer.destroy();
    return result;
  }

  async function setup(text, serializedState) {
    const Document = require("../lib/notebook-document");
    const Editor = require("../lib/jupyter-notebook-editor");
    const document = new Document();
    documents.push(document);
    await document.initializeFromData({
      nbformat: 4,
      nbformat_minor: 5,
      cells: [{ id: "cell", cell_type: "code", source: text, metadata: {}, outputs: [] }],
    });
    if (serializedState?.pendingWrites?.length)
      document.currentHistoryStateId = serializedState.pendingWrites.at(-1).historyStateId;
    const editor = Object.create(Editor.prototype);
    editor.document = document;
    editor.activeCellIndex = 0;
    editor.view = null;
    editor.requestFrame = (callback) => callback();
    editor.updateView = () => {};
    editor.focusHistoryMode = () => {};
    const controller = document.getSourceController(serializedState);
    controller.ensureGrammar = () => {};
    editor.sourceController = controller;
    await controller.attach(editor);
    editor.sourceEditor = controller.sourceEditor;
    return { document, editor, controller };
  }

  it("projects and undoes a cell larger than a native string without reading it", async () => {
    let original = source("x".repeat(32768));
    while (original.canMaterialize())
      original = original.replace(original.length, original.length, original);
    const prototype = Object.getPrototypeOf(original);
    const toString = prototype.toString;
    const materializations = [];
    spyOn(prototype, "toString").and.callFake(function (...args) {
      if (this.length > 1024 * 1024) {
        materializations.push(this.length);
        throw new Error("Whole cell materialization");
      }
      return toString.apply(this, args);
    });
    const { document, editor, controller } = await setup(original);
    expect(controller.sourceEditor.getBuffer().getLength()).toBeGreaterThan(original.length);
    spyOn(controller.sourceEditor, "getText").and.throwError("Whole projection materialization");
    const changed = original.replace(original.length, original.length, "\r\n😀e\u0301");
    document.updateCellSource(0, changed, editor);
    await controller.commitSnapshot("edit", editor);
    expect(document.cells[0].getSourceSnapshot()).toBe(changed);
    await controller.performHistory("undo", editor);
    expect(document.cells[0].getSourceSnapshot().equals(original)).toBe(true);
    await controller.performHistory("redo", editor);
    expect(document.cells[0].getSourceSnapshot().equals(changed)).toBe(true);
    const state = controller.serialize();
    expect(state.bufferState.text).toBeUndefined();
    expect(state.bufferState.textSnapshot.length).toBeGreaterThan(original.length);
    expect(materializations).toEqual([]);
  });

  it("checks magic-prefix bounds before reading a giant first line", () => {
    const buffer = new TextBuffer();
    let text = source("x".repeat(32768));
    while (text.canMaterialize()) text = text.replace(text.length, text.length, text);
    buffer.setTextInRange(buffer.getRange(), text);
    const { CellMagicPrefix, rootRanges } = require("../lib/cell-magic");
    const prefix = new CellMagicPrefix(buffer);
    spyOn(buffer, "lineForRow").and.throwError("Whole first line");
    try {
      expect(prefix.get()).toBeNull();
      expect(rootRanges(text)).toBeNull();
      buffer.setTextInRange(buffer.getRange(), "\r\n%%html\r\n<b>😀</b>");
      expect(prefix.get().name).toBe("html");
      expect(rootRanges(buffer.getTextSnapshot())[0].start.row).toBe(2);
    } finally {
      prefix.destroy();
      buffer.destroy();
    }
  });

  it("mounts an oversized cell with a scrolling source editor and preserves exact content", () => {
    let text = source("x".repeat(32768));
    while (text.canMaterialize()) text = text.replace(text.length, text.length, text);
    text = text.replace(text.length, text.length, "\r\n😀\r\n");
    const cell = new (require("../lib/cell-model"))({
      id: "large-mounted",
      source: text,
      metadata: { vscode: { languageId: lumine.grammars.nullGrammar.scopeName } },
    });
    spyOnProperty(cell, "source", "get").and.throwError("Whole source getter");
    const view = new (require("../lib/cell-view"))({
      cell,
      index: 0,
      active: true,
      selected: false,
      mode: "edit",
      notebookLanguage: "python",
      cellSourceRevision: 0,
    });
    try {
      require("@lumine-code/etch").updateSync(view);
      expect(view.editor.autoHeight).toBe(false);
      expect(view.editor.getBuffer().getTextSnapshot().equals(text)).toBe(true);
      expect(view.editorElement.style.height).toBe("100%");
    } finally {
      view.destroy();
      cell.destroy();
    }
  });

  it("preserves edits and queued history captured while an earlier projection is preparing", async () => {
    const original = source("ab".repeat(100000));
    const { document, editor, controller } = await setup(original);
    const codec = require("../lib/notebook-json");
    const encode = codec.stringifySource;
    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    spyOn(codec, "stringifySource").and.callFake(async (...args) => {
      await barrier;
      return encode(...args);
    });
    const first = original.replace(original.length, original.length, "first");
    const second = first.replace(first.length, first.length, "second");
    document.updateCellSource(0, first, editor);
    controller.commitSnapshot("first", editor);
    document.updateCellSource(0, second, editor);
    controller.commitSnapshot("second", editor);
    const recovered = controller.serialize();
    expect(recovered.pendingWrites.length).toBe(2);
    expect(controller.sourceEditor.isReadOnly()).toBe(true);
    expect(document.cells[0].getSourceSnapshot()).toBe(second);
    release();
    await controller.flush(editor);
    expect(controller.sourceEditor.isReadOnly()).toBe(false);
    await controller.performHistory("undo", editor);
    expect(document.cells[0].getSourceSnapshot().equals(first)).toBe(true);
    await controller.performHistory("undo", editor);
    expect(document.cells[0].getSourceSnapshot().equals(original)).toBe(true);
    const restored = await setup(second, recovered);
    expect(restored.document.cells[0].getSourceSnapshot().equals(second)).toBe(true);
    await restored.controller.performHistory("undo", restored.editor);
    expect(restored.document.cells[0].getSourceSnapshot().equals(first)).toBe(true);
  });

  it("copies and duplicates roots with exact Unicode and line endings", async () => {
    const original = source("\t😀\r\n e\u0301\n");
    const { document, editor } = await setup(original);
    spyOnProperty(document.cells[0], "source", "get").and.throwError("Legacy source getter");
    editor.copyCell();
    editor.pasteCellBelow();
    expect(document.cells[1].getSourceSnapshot().equals(original)).toBe(true);
    editor.duplicateCell();
    expect(document.cells[2].getSourceSnapshot().equals(original)).toBe(true);
    expect(document.cells[2].getSourceSnapshot().toString()).toBe("\t😀\r\n e\u0301\n");
  });

  it("keeps invalid raw JSON dirty and recoverable instead of saving stale model content", async () => {
    const original = source("saved source");
    const { document, editor, controller } = await setup(original);
    document._markCurrentStateSaved();
    controller.sourceEditor.setText("{ invalid JSON\r\n");
    expect(document.isModified()).toBe(true);
    expect(controller.canSaveModel()).toBe(false);
    const state = document.serializeState();
    expect(state.notebookData.cells[0].sourceSnapshot.equals(original)).toBe(true);
    const restored = await setup(original, state.sourceControllerState);
    expect(restored.controller.sourceEditor.getText()).toBe("{ invalid JSON\r\n");
    expect(restored.controller.canSaveModel()).toBe(false);
    await restored.controller.performHistory("undo", restored.editor);
    expect(restored.document.cells[0].getSourceSnapshot().equals(original)).toBe(true);
    expect(restored.controller.canSaveModel()).toBe(true);
    expect(editor.document).toBe(document);
  });

  it("streams a multimegabyte UTF-8 save and reload with exact surrogate and CRLF content", async () => {
    const fs = require("node:fs"),
      os = require("node:os"),
      path = require("node:path");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notebook-source-stream-"));
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Unsafe scratch path");
    const filePath = path.join(directory, "source.ipynb");
    const original = source(("x".repeat(32767) + "😀\r\ne\u0301").repeat(40));
    const { document, controller } = await setup(original);
    document.setPath(filePath);
    spyOn(controller.sourceEditor, "getText").and.throwError("Whole source projection");
    try {
      expect(await document.save()).toBe(true);
      const Document = require("../lib/notebook-document");
      const loaded = new Document(filePath);
      documents.push(loaded);
      await loaded.load();
      expect(loaded.cells[0].getSourceSnapshot().equals(original)).toBe(true);
      expect(loaded.savedDiskFingerprint).toBe(document.savedDiskFingerprint);
    } finally {
      for (const item of documents) item.destroy();
      await lumine.fileWatchClient.settlePendingTeardown();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
