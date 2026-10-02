const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TextBuffer } = require("lumine");

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(predicate) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > 5000)
      throw new Error("Timed out waiting for notebook operation");
    await tick();
  }
}

function notebook(type = "code") {
  return {
    nbformat: 4,
    nbformat_minor: 0,
    metadata: {},
    cells: [
      {
        id: "cell",
        cell_type: type,
        source: ["original"],
        metadata: { nested: { value: "original" } },
        ...(type === "code"
          ? {
              outputs: [{ output_type: "stream", name: "stdout", text: "original" }],
              execution_count: 1,
            }
          : { attachments: { "image.png": { "image/png": "original-pixels" } } }),
      },
    ],
  };
}

describe("notebook persistence and ownership", () => {
  let NotebookDocument, NotebookDocumentRegistry, JupyterNotebookEditor, CellModel;
  let directory, documents, editors, registries;

  beforeEach(async () => {
    for (const name of ["language-json", "language-python", "language-gfm", "language-text"]) {
      const grammarPackage = await lumine.packages.activatePackage(name);
      await grammarPackage.resourceLoadPromise;
    }
    NotebookDocument = require("../lib/notebook-document");
    NotebookDocumentRegistry = require("../lib/notebook-document-registry");
    JupyterNotebookEditor = require("../lib/jupyter-notebook-editor");
    CellModel = require("../lib/cell-model");
    // Atomic saves resolve symlinks and Windows 8.3 aliases. Match the same
    // physical directory when scoping fault injection to our fixture files.
    directory = await fs.promises.realpath(
      fs.mkdtempSync(path.join(os.tmpdir(), "notebook-reliability-")),
    );
    documents = [];
    editors = [];
    registries = [];
  });

  afterEach(async () => {
    for (const editor of editors) editor.destroy();
    for (const registry of registries) registry.destroy();
    for (const document of documents) document.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function documentFor(data = notebook(), fileName = "notebook.ipynb") {
    const filePath = path.join(directory, fileName);
    fs.writeFileSync(filePath, JSON.stringify(data));
    const document = new NotebookDocument(filePath);
    documents.push(document);
    await document.load();
    return document;
  }

  function delayWrites() {
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    const pending = [];
    spyOn(fs.promises, "writeFile").and.callFake(async (...args) => {
      if (path.dirname(String(args[0])) !== directory) return writeFile(...args);
      await new Promise((resolve) => pending.push({ text: args[1], release: resolve }));
      return writeFile(...args);
    });
    return pending;
  }

  it("keeps attachments and v4.0 format through source editing, undo, copy and save", async () => {
    const document = await documentFor(notebook("markdown"));
    const editor = new JupyterNotebookEditor(document);
    editors.push(editor);
    await editor._sourceEditorSetupPromise;
    document.updateCellSource(0, "changed", editor);
    editor.sourceController.commitSnapshot("test", editor);
    editor.undoCellOperation();
    expect(document.getCell(0).source).toBe("original");
    expect(document.getCell(0).attachments).toEqual(notebook("markdown").cells[0].attachments);
    editor.copyCell();
    document.getCell(0).attachments["image.png"]["image/png"] = "later-pixels";
    editor.pasteCellBelow();
    expect(document.getCell(1).attachments["image.png"]["image/png"]).toBe("original-pixels");
    expect(await editor.save()).toBe(true);
    const saved = JSON.parse(fs.readFileSync(document.filePath, "utf8"));
    expect(saved.nbformat_minor).toBe(0);
    expect(saved.cells[1].attachments).toEqual(notebook("markdown").cells[0].attachments);
  });

  it("gives a duplicate its own outputs and nested metadata", async () => {
    const document = await documentFor();
    const original = document.getCell(0);
    const [copy] = document.insertCellsFromData(1, [original.toJSON()]);
    copy.metadata.nested.value = "copy";
    copy.addOutput({ output_type: "stream", name: "stdout", text: " appended" });
    expect(original.metadata.nested.value).toBe("original");
    expect(original.outputs[0].text).toBe("original");
    expect(copy.outputs[0].text).toBe("original appended");
  });

  it("serializes saves and preserves the last requested snapshot", async () => {
    const errors = spyOn(lumine.notifications, "addError").and.callThrough();
    const document = await documentFor();
    const pending = delayWrites();
    document.updateCellSource(0, "first");
    const first = document.save();
    await waitFor(() => pending.length === 1);
    document.updateCellSource(0, "second");
    const second = document.save();
    await tick();
    expect(pending.length).toBe(1);
    pending[0].release();
    expect(await first).toBe(true);
    await waitFor(() => pending.length === 2);
    window.advanceClock(600);
    expect(document._isSaving).toBe(true);
    pending[1].release();
    const secondSaved = await second;
    if (!secondSaved)
      throw new Error(`Second save failed: ${JSON.stringify(errors.calls.allArgs())}`);
    expect(secondSaved).toBe(true);
    expect(JSON.parse(fs.readFileSync(document.filePath, "utf8")).cells[0].source).toEqual([
      "second",
    ]);
    expect(document.isModified()).toBe(false);
  });

  it("does not mark a Save As destination saved when an earlier path finishes writing", async () => {
    const document = await documentFor();
    const originalPath = document.filePath;
    document.updateCellSource(0, "saving original path");
    const pending = delayWrites();
    const saving = document.save();
    await waitFor(() => pending.length === 1);
    document.setPath(path.join(directory, "new.ipynb"));
    pending[0].release();
    expect(await saving).toBe(true);
    expect(document.isModified()).toBe(true);
    expect(fs.existsSync(document.filePath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(originalPath, "utf8")).cells[0].source).toEqual([
      "saving original path",
    ]);
  });

  it("keeps the written fingerprint when runtime output changes during save", async () => {
    const document = await documentFor();
    const pending = delayWrites();
    const saving = document.save();
    await waitFor(() => pending.length === 1);
    document.getCell(0).addOutput({ output_type: "stream", name: "stdout", text: " later" });
    pending[0].release();
    expect(await saving).toBe(true);
    expect(document.isModified()).toBe(true);
    expect(document.savedDiskFingerprint).not.toContain("original later");
    expect(JSON.parse(fs.readFileSync(document.filePath, "utf8")).cells[0].outputs[0].text).toBe(
      "original",
    );
  });

  it("preserves the original file if replacing the atomic save fails", async () => {
    const document = await documentFor();
    const original = fs.readFileSync(document.filePath, "utf8");
    document.updateCellSource(0, "cannot save");
    const rename = fs.promises.rename.bind(fs.promises);
    spyOn(fs.promises, "rename").and.callFake((from, to) =>
      path.dirname(from) === directory
        ? Promise.reject(new Error("Replace failed"))
        : rename(from, to),
    );
    expect(await document.save()).toBe(false);
    expect(fs.readFileSync(document.filePath, "utf8")).toBe(original);
    expect(fs.readdirSync(directory)).toEqual(["notebook.ipynb"]);
    expect(document.isModified()).toBe(true);
  });

  it("refuses a corrupt notebook instead of creating a saveable empty replacement", async () => {
    const filePath = path.join(directory, "broken.ipynb");
    fs.writeFileSync(filePath, "broken content");
    const registry = new NotebookDocumentRegistry();
    registries.push(registry);
    await expectAsync(registry.getOrCreateDocument(filePath)).toBeRejected();
    expect(registry.getDocuments()).toEqual([]);
    expect(registry._loadingPromises.size).toBe(0);
    expect(fs.readFileSync(filePath, "utf8")).toBe("broken content");
  });

  it("makes concurrent opens join the load before exposing their data", async () => {
    const registry = new NotebookDocumentRegistry();
    registries.push(registry);
    let release;
    const read = new Promise((resolve) => {
      release = resolve;
    });
    spyOn(NotebookDocument.prototype, "_readFile").and.returnValue(read);
    const filePath = path.join(directory, "loading.ipynb");
    fs.writeFileSync(filePath, JSON.stringify(notebook()));
    const first = registry.getOrCreateDocument(filePath);
    let secondSettled = false;
    const second = registry.getOrCreateDocument(filePath).then((document) => {
      secondSettled = true;
      return document;
    });
    await tick();
    expect(secondSettled).toBe(false);
    release({
      notebook: notebook(),
      fingerprint: "saved",
      lineEndings: new Set(["\n"]),
      firstLineEnding: "\n",
    });
    const [firstDocument, secondDocument] = await Promise.all([first, second]);
    expect(firstDocument).toBe(secondDocument);
    expect(secondDocument.getCell(0).source).toBe("original");
  });

  it("does not resurrect a registry when a file load finishes after teardown", async () => {
    const registry = new NotebookDocumentRegistry();
    registries.push(registry);
    let reject;
    spyOn(NotebookDocument.prototype, "_readFile").and.returnValue(
      new Promise((_resolve, rejectRead) => {
        reject = rejectRead;
      }),
    );
    const pending = registry.getOrCreateDocument(path.join(directory, "missing.ipynb"));
    await tick();
    const [document] = registry.getDocuments();
    registry.destroy();
    reject(Object.assign(new Error("Missing file"), { code: "ENOENT" }));
    await expectAsync(pending).toBeRejectedWithError(/destroyed/);
    expect(document.cells).toEqual([]);
    expect(registry.getDocuments()).toEqual([]);
  });

  it("abandons source buffer restoration after the last notebook view closes", async () => {
    const document = await documentFor();
    const bufferState = { text: "{}" };
    document._serializedSourceControllerState = { bufferState };
    let release;
    const deserialize = TextBuffer.deserialize.bind(TextBuffer);
    spyOn(TextBuffer, "deserialize").and.callFake((state) =>
      state === bufferState
        ? new Promise((resolve) => {
            release = resolve;
          })
        : deserialize(state),
    );
    const editor = new JupyterNotebookEditor(document);
    editors.push(editor);
    const setup = editor._sourceEditorSetupPromise;
    editor.destroy();
    const buffer = new TextBuffer({ text: "restored text" });
    release(buffer);
    await setup;
    expect(buffer.isDestroyed()).toBe(true);
    expect(editor.sourceEditor).toBeNull();
    expect(editor.sourceController.sourceEditor).toBeNull();
  });

  it("makes editor destruction idempotent while a split still owns the document", async () => {
    const document = await documentFor();
    const first = new JupyterNotebookEditor(document);
    const second = new JupyterNotebookEditor(document);
    editors.push(first, second);
    await Promise.all([first._sourceEditorSetupPromise, second._sourceEditorSetupPromise]);
    first.destroy();
    first.destroy();
    expect(document.refCount).toBe(1);
    expect(document.isDestroyed()).toBe(false);
  });

  it("retains carriage-return cursor state across stream chunks", () => {
    const cell = new CellModel({ id: "stream" });
    cell.addOutput({ output_type: "stream", name: "stdout", text: "abcdef\r" });
    cell.addOutput({ output_type: "stream", name: "stdout", text: "12" });
    cell.addOutput({ output_type: "stream", name: "stdout", text: "3\nnext" });
    expect(cell.outputs[0].text).toBe("123def\nnext");
    cell.destroy();
  });

  it("cancels cell runtime timers on destruction", () => {
    const cell = new CellModel({ id: "timers" });
    const changed = jasmine.createSpy("changed");
    cell.onDidChange(changed);
    cell.setRunning();
    cell.scheduleClearOutputs();
    cell.destroy();
    window.advanceClock(100);
    expect(cell._runningTimer).toBeNull();
    expect(cell._pendingClearTimer).toBeNull();
    expect(cell.status).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });

  it("shares overlapping execution state across fresh adapter handles", async () => {
    const document = await documentFor();
    const editor = new JupyterNotebookEditor(document);
    editors.push(editor);
    await editor._sourceEditorSetupPromise;
    const AdapterService = require("../lib/jupyter-adapter");
    const service = new AdapterService();
    const first = service.getAdapterForItem(editor);
    const second = service.getAdapterForItem(editor);
    const cell = document.getCell(0);
    const firstTarget = first.getRunTarget(cell.id);
    const secondTarget = second.getRunTarget(cell.id);
    const clear = spyOn(cell, "clearRunning").and.callThrough();
    first.beginTargetExecution(firstTarget);
    second.beginTargetExecution(secondTarget);
    window.advanceClock(60);
    first.finishTargetExecution(firstTarget);
    expect(clear).not.toHaveBeenCalled();
    expect(cell.status).toBe("running");
    second.finishTargetExecution(secondTarget);
    expect(clear.calls.count()).toBe(1);
    expect(cell.status).toBeNull();
  });

  it("indexes cell ids once for repeated target lookups and refreshes after reordering", async () => {
    const document = new NotebookDocument(null);
    documents.push(document);
    await document.initializeFromData({
      ...notebook(),
      cells: Array.from({ length: 1000 }, (_, index) => ({
        id: `cell-${index}`,
        cell_type: "markdown",
        source: "",
        metadata: {},
      })),
    });
    let reads = 0;
    for (const cell of document.cells) {
      const id = cell.id;
      Object.defineProperty(cell, "id", {
        get: () => {
          reads++;
          return id;
        },
      });
    }
    for (let index = 0; index < 1000; index++) {
      expect(document.getCellIndexById(`cell-${index}`)).toBe(index);
    }
    expect(reads).toBe(1000);
    document.moveCell(999, 0);
    expect(document.getCellIndexById("cell-999")).toBe(0);
    expect(document.getCellIndexById("cell-0")).toBe(1);
    expect(reads).toBeLessThan(2100);
  });
});
