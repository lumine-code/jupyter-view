const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { NotebookControl } = require("../lib/notebook-control");
const { notebookTools } = require("../lib/notebook-tools");
const Registry = require("../lib/notebook-document-registry");
const AdapterService = require("../lib/jupyter-adapter");

describe("live notebook MCP control", () => {
  let registry, control, editors, directory, host;

  beforeEach(async () => {
    for (const name of ["language-json", "language-python", "language-gfm", "language-text"]) {
      const grammar = await lumine.packages.activatePackage(name);
      await grammar.resourceLoadPromise;
    }
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "notebook-mcp-"));
    registry = new Registry();
    editors = [];
    host = {
      getDocumentRegistry: () => registry,
      getNotebookEditors: (document) =>
        editors.filter((editor) => !editor._destroyed && editor.document === document),
      provideJupyterAdapter: () => new AdapterService(),
      async openNotebook(filePath) {
        const editor = await registry.buildEditor(filePath);
        editors.push(editor);
        return editor;
      },
      async newNotebook() {
        const editor = await registry.buildEditor(null);
        editors.push(editor);
        return editor;
      },
    };
    control = new NotebookControl(host);
  });

  afterEach(async () => {
    control.dispose();
    for (const editor of editors) editor.destroy();
    registry.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function create() {
    const editor = await host.newNotebook();
    await editor._sourceEditorSetupPromise;
    return { editor, document: editor.document, notebookId: editor.document.id };
  }

  async function edit(notebookId, operation, options = {}) {
    return control.editCell({
      notebookId,
      operation,
      expectedRevision: control.getNotebookRevision(notebookId),
      operationId: `${operation}-${Math.random()}`,
      ...options,
    });
  }

  it("discovers unsaved IDs and reads bounded source and outputs without active fallback", async () => {
    const { document, notebookId } = await create();
    document.updateCellSource(0, "x".repeat(5000));
    document.cells[0].addOutput({
      output_type: "display_data",
      data: { "image/png": "a".repeat(200000), "text/plain": "text".repeat(1000) },
    });
    expect(control.listNotebooks().notebooks[0].notebookId).toBe(notebookId);
    const snapshot = await control.getNotebookSnapshot({ notebookId });
    expect(snapshot.cells[0].source.text.length).toBe(1000);
    expect(snapshot.cells[0].source.truncated).toBe(true);
    const cell = await control.getCellSnapshot({
      notebookId,
      cellId: document.cells[0].id,
      sourceOffset: 4900,
      sourceLimit: 200,
    });
    expect(cell.source.text.length).toBe(100);
    expect(cell.outputs[0].representations[0]).toEqual({
      mimeType: "image/png",
      kind: "binary",
      chars: 200000,
    });
    expect(JSON.stringify(cell).length).toBeLessThan(5000);
    await expectAsync(control.getNotebookSnapshot({ notebookId: "unknown" })).toBeRejectedWithError(
      /closed|unknown/,
    );
    expect(() => control.getNotebookRevision()).toThrowError(/explicit notebookId/);
  });

  it("keeps CRUD edits undoable and projected into split views", async () => {
    const { editor, document, notebookId } = await create();
    const split = editor.copy();
    editors.push(split);
    await split._sourceEditorSetupPromise;
    const initialId = document.cells[0].id;
    const added = await edit(notebookId, "insert", {
      source: "answer = 42",
      type: "code",
      beforeCellId: initialId,
    });
    expect(document.cells[0].id).toBe(added.cellId);
    expect(split.document.cells[0].source).toBe("answer = 42");
    expect(JSON.parse(editor.sourceEditor.getText()).cells[0].source.join("")).toBe("answer = 42");
    await edit(notebookId, "replace", {
      cellId: added.cellId,
      source: "# heading",
      type: "markdown",
    });
    expect(document.cells[0].type).toBe("markdown");
    editor.undoCellOperation();
    expect(document.cells[0].type).toBe("code");
    expect(document.cells[0].source).toBe("answer = 42");
    await edit(notebookId, "move", { cellId: added.cellId, afterCellId: initialId });
    expect(document.cells[1].id).toBe(added.cellId);
    await edit(notebookId, "delete", { cellId: added.cellId });
    expect(document.cells.map((cell) => cell.id)).toEqual([initialId]);
    const cleared = await edit(notebookId, "delete", { cellId: initialId });
    expect(cleared.cleared).toBe(true);
    expect(document.cells[0].id).toBe(initialId);
  });

  it("replays an identical operation without duplicating cells and rejects ID reuse or stale edits", async () => {
    const { document, notebookId } = await create();
    const request = {
      notebookId,
      operation: "insert",
      source: "value",
      operationId: "same",
      expectedRevision: control.getNotebookRevision(notebookId),
    };
    const [first, retry] = await Promise.all([
      control.editCell(request),
      control.editCell({ ...request }),
    ]);
    expect(first.cellId).toBe(retry.cellId);
    expect(retry.replayed).toBe(true);
    expect(document.cells.length).toBe(2);
    await expectAsync(control.editCell({ ...request, source: "changed" })).toBeRejectedWithError(
      /different arguments/,
    );
    await expectAsync(control.editCell({ ...request, operationId: "stale" })).toBeRejectedWithError(
      /revision/,
    );
    const revision = control.getNotebookRevision(notebookId);
    document.cells[0].addOutput({ output_type: "stream", name: "stdout", text: "runtime" });
    expect(control.getNotebookRevision(notebookId)).toBe(revision);
  });

  it("flushes pending user source before validating a mutation revision", async () => {
    const { editor, document, notebookId } = await create();
    const revision = control.getNotebookRevision(notebookId);
    const cell = document.cells[0];
    const view = editor.view.cellViews.get(cell.id);
    view.editor.setText("typed by user");
    view._editorIsDirty = true;
    await expectAsync(
      control.editCell({
        notebookId,
        cellId: cell.id,
        operation: "replace",
        source: "stale replacement",
        operationId: "stale-user",
        expectedRevision: revision,
      }),
    ).toBeRejectedWithError(/revision/);
    expect(document.cells[0].source).toBe("typed by user");
  });

  it("saves the live model, preserves newer edits and refuses implicit overwrites", async () => {
    const { document, notebookId } = await create();
    const filePath = path.join(directory, "saved.ipynb");
    await edit(notebookId, "replace", { cellId: document.cells[0].id, source: "saved source" });
    const request = {
      notebookId,
      path: filePath,
      operationId: "save",
      expectedRevision: control.getNotebookRevision(notebookId),
    };
    const saved = await control.saveNotebook(request);
    expect(saved.saved).toBe(true);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).cells[0].source.join("")).toBe(
      "saved source",
    );
    expect((await control.saveNotebook(request)).replayed).toBe(true);
    const other = path.join(directory, "other.ipynb");
    fs.writeFileSync(other, "existing");
    await expectAsync(
      control.saveNotebook({ notebookId, path: other, operationId: "overwrite" }),
    ).toBeRejectedWithError(/exists/);
    expect(fs.readFileSync(other, "utf8")).toBe("existing");
  });

  it("restores an untitled file binding after failed Save As without discarding source", async () => {
    const { document, editor, notebookId } = await create();
    document.updateCellSource(0, "unsaved source", editor);
    const destination = path.join(directory, "missing-folder", "failed.ipynb");
    await expectAsync(
      control.saveNotebook({ notebookId, path: destination, operationId: "failed-save" }),
    ).toBeRejectedWithError(/could not be saved/);
    expect(document.filePath).toBeNull();
    expect(document.file).toBeNull();
    expect(editor.sourceEditor.getPath()).toBeUndefined();
    expect(registry.getDocument(destination)).toBeUndefined();
    expect(document.cells[0].source).toBe("unsaved source");
    expect(document.modified).toBe(true);
  });

  it("does not roll back a user's path or source change while a failed save is pending", async () => {
    const { document, editor, notebookId } = await create();
    let fail, started;
    const savingStarted = new Promise((resolve) => {
      started = resolve;
    });
    spyOn(document, "save").and.callFake(() => {
      started();
      return new Promise((resolve) => {
        fail = resolve;
      });
    });
    const destination = path.join(directory, "attempt.ipynb");
    const userPath = path.join(directory, "user.ipynb");
    const pending = control.saveNotebook({
      notebookId,
      path: destination,
      operationId: "user-race",
    });
    await savingStarted;
    document.setPath(userPath);
    document.updateCellSource(0, "new human source", editor);
    fail(false);
    await expectAsync(pending).toBeRejectedWithError(/could not be saved/);
    expect(document.filePath).toBe(userPath);
    expect(editor.sourceEditor.getPath()).toBe(userPath);
    expect(document.cells[0].source).toBe("new human source");
  });

  it("restores a file-backed notebook's path after a real Save As write failure", async () => {
    const { document, editor, notebookId } = await create();
    const previousPath = path.join(directory, "previous.ipynb");
    await control.saveNotebook({ notebookId, path: previousPath, operationId: "baseline" });
    document.updateCellSource(0, "still unsaved", editor);
    const destination = path.join(directory, "missing-folder", "failed.ipynb");
    await expectAsync(
      control.saveNotebook({ notebookId, path: destination, operationId: "failed-as" }),
    ).toBeRejectedWithError(/could not be saved/);
    expect(document.filePath).toBe(previousPath);
    expect(editor.sourceEditor.getPath()).toBe(previousPath);
    expect(registry.getDocument(previousPath)).toBe(document);
    expect(registry.getDocument(destination)).toBeUndefined();
    expect(document.cells[0].source).toBe("still unsaved");
    expect(document.modified).toBe(true);
    expect(JSON.parse(fs.readFileSync(previousPath, "utf8")).cells[0].source.join("")).toBe("");
  });

  it("preserves a user rename away and back to the attempted path by File identity", async () => {
    const { document, notebookId } = await create();
    let fail, started;
    const savingStarted = new Promise((resolve) => {
      started = resolve;
    });
    spyOn(document, "save").and.callFake(() => {
      started();
      return new Promise((resolve) => {
        fail = resolve;
      });
    });
    const destination = path.join(directory, "attempt.ipynb");
    const pending = control.saveNotebook({
      notebookId,
      path: destination,
      operationId: "roundtrip-race",
    });
    await savingStarted;
    const attemptedFile = document.file;
    document.setPath(path.join(directory, "intermediate.ipynb"));
    document.setPath(destination);
    expect(document.file).not.toBe(attemptedFile);
    fail(false);
    await expectAsync(pending).toBeRejectedWithError(/could not be saved/);
    expect(document.filePath).toBe(destination);
  });

  it("requires a fresh generation for create retries and rejects closed notebook handles", async () => {
    const request = {
      operationId: "create",
      expectedGeneration: control.listNotebooks().generation,
      language: "julia",
    };
    const first = await control.createNotebook(request);
    const retry = await control.createNotebook(request);
    expect(first.notebookId).toBe(retry.notebookId);
    expect(first.language).toBe("julia");
    expect(control.listNotebooks().total).toBe(1);
    await expectAsync(
      control.createNotebook({ ...request, operationId: "old", expectedGeneration: "old" }),
    ).toBeRejectedWithError(/generation/);
    const adapter = control.getExecutionAdapter(first.notebookId);
    expect(adapter.getAdapterId()).toBe(`jupyter-view:${first.notebookId}`);
    editors[0].destroy();
    await expectAsync(
      control.getNotebookSnapshot({ notebookId: first.notebookId }),
    ).toBeRejectedWithError(/closed/);
  });

  it("rejects non-boolean overwrite and unexpected fields before changing file binding or contents", async () => {
    const { document, notebookId } = await create();
    const destination = path.join(directory, "protected.ipynb");
    fs.writeFileSync(destination, "protected bytes");
    spyOn(document, "save").and.callThrough();
    for (const overwrite of ["false", "true", 1, null, {}, []]) {
      expect(() =>
        control.saveNotebook({
          notebookId,
          operationId: `invalid-${String(overwrite)}`,
          path: destination,
          overwrite,
        }),
      ).toThrowError(/boolean/);
    }
    expect(document.save).not.toHaveBeenCalled();
    expect(document.filePath).toBeNull();
    expect(fs.readFileSync(destination, "utf8")).toBe("protected bytes");
    expect(() =>
      control.saveNotebook({
        notebookId,
        operationId: "unexpected",
        path: destination,
        overwrite: true,
        action: "edit",
      }),
    ).toThrowError(/Unexpected/);
    expect(() =>
      control.editCell({
        notebookId,
        operation: "delete",
        cellId: document.cells[0].id,
        operationId: "unexpected-cell",
        expectedRevision: control.getNotebookRevision(notebookId),
        action: "save",
      }),
    ).toThrowError(/Unexpected/);
    await expectAsync(
      control.getCellSnapshot({
        notebookId,
        cellId: document.cells[0].id,
        includeOutputs: "false",
      }),
    ).toBeRejectedWithError(/boolean/);
    await expectAsync(
      control.getNotebookSnapshot({ notebookId, unexpected: true }),
    ).toBeRejectedWithError(/Unexpected/);
    const result = await control.saveNotebook({
      notebookId,
      path: destination,
      operationId: "explicit-true",
      overwrite: true,
    });
    expect(result.saved).toBe(true);
    expect(document.save).toHaveBeenCalledTimes(1);
  });

  it("reuses an explicit file notebook and refuses non-notebook or missing paths", async () => {
    const filePath = path.join(directory, "open.ipynb");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            id: "stored",
            cell_type: "code",
            source: "1",
            metadata: {},
            execution_count: null,
            outputs: [],
          },
        ],
      }),
    );
    const request = { path: filePath, expectedGeneration: control.generation, operationId: "open" };
    const first = await control.openNotebook(request);
    const second = await control.openNotebook(request);
    expect(first.notebookId).toBe(second.notebookId);
    expect(editors.length).toBe(1);
    await expectAsync(
      control.openNotebook({ ...request, operationId: "relative", path: "relative.ipynb" }),
    ).toBeRejectedWithError(/absolute/);
    await expectAsync(
      control.openNotebook({
        ...request,
        operationId: "missing",
        path: path.join(directory, "missing.ipynb"),
      }),
    ).toBeRejected();
  });

  it("retains receipts at capacity and retains failed create attempts without running them twice", async () => {
    const request = { expectedGeneration: control.generation, operationId: "original" };
    const first = await control.createNotebook(request);
    for (let index = 1; index < 128; index++) {
      control.operations.set(`reserved-${index}`, {
        fingerprint: "{}",
        settled: true,
        promise: Promise.resolve(),
      });
    }
    await expectAsync(
      control.createNotebook({ ...request, operationId: "overflow" }),
    ).toBeRejectedWithError(/128 operation receipts/);
    expect((await control.createNotebook(request)).notebookId).toBe(first.notebookId);
    expect(editors.length).toBe(1);
    control.dispose();
    control = new NotebookControl(host);
    spyOn(host, "newNotebook").and.callFake(async () => {
      const editor = await registry.buildEditor(null);
      editors.push(editor);
      throw new Error("setup failed after create");
    });
    const failed = { expectedGeneration: control.generation, operationId: "failed" };
    await expectAsync(control.createNotebook(failed)).toBeRejectedWithError(/setup failed/);
    await expectAsync(control.createNotebook(failed)).toBeRejectedWithError(/setup failed/);
    expect(host.newNotebook).toHaveBeenCalledTimes(1);
  });

  it("provides complete execution source or rejects bounds rather than running a preview", async () => {
    const { document, notebookId } = await create();
    document.updateCellSource(0, "full source".repeat(500));
    const snapshot = await control.getExecutionSnapshot({ notebookId });
    expect(snapshot.cells[0].source).toBe(document.cells[0].source);
    expect(snapshot.cells[0].sourceRevision).toBe(document.cells[0].sourceRevision);
    await expectAsync(
      control.getExecutionSnapshot({ notebookId, maxSourceChars: 1 }),
    ).toBeRejectedWithError(/limit/);
  });

  it("budgets only selected execution cells, excluding unrelated or markdown source", async () => {
    const document = await registry.createUntitledDocument();
    const cell = document.cells[0];
    document.updateCellSource(0, "run_me()");
    document.insertCellsFromData(
      1,
      Array.from({ length: 1001 }, () => ({ cell_type: "markdown", source: "m".repeat(2048) })),
    );
    const notebookId = document.id;
    await expectAsync(control.getExecutionSnapshot({ notebookId })).toBeRejectedWithError(/limit/);
    const selected = await control.getExecutionSnapshot({ notebookId, cellIds: [cell.id] });
    expect(selected.cells).toEqual([
      {
        cellId: cell.id,
        index: 0,
        type: "code",
        source: "run_me()",
        sourceRevision: cell.sourceRevision,
      },
    ]);
    const code = await control.getExecutionSnapshot({ notebookId, codeOnly: true });
    expect(code.cells).toEqual(selected.cells);
    await expectAsync(
      control.getExecutionSnapshot({ notebookId, cellIds: [cell.id, cell.id] }),
    ).toBeRejectedWithError(/unique/);
  });

  it("waits for runtime changes, handles cancellation and bounds pending listeners", async () => {
    const { document, notebookId } = await create();
    const snapshot = await control.getNotebookSnapshot({ notebookId });
    const request = { notebookId, afterRevision: snapshot.changeRevision, timeoutMs: 1000 };
    const wait = control.waitForNotebookChange(request);
    document.cells[0].addOutput({ output_type: "stream", name: "stdout", text: "output" });
    const result = await wait;
    expect(result.changed).toBe(true);
    expect(result.revision).toBe(snapshot.revision);
    expect(result.changeRevision).not.toBe(snapshot.changeRevision);
    const current = await control.getNotebookSnapshot({ notebookId });
    const controller = new AbortController();
    const cancelled = control.waitForNotebookChange(
      { ...request, afterRevision: current.changeRevision },
      { signal: controller.signal },
    );
    controller.abort();
    await expectAsync(cancelled).toBeRejectedWithError(/cancelled/);
    expect(control.waits.size).toBe(0);
    const waits = Array.from({ length: 8 }, () =>
      control.waitForNotebookChange({ ...request, afterRevision: current.changeRevision }),
    );
    await expectAsync(
      control.waitForNotebookChange({ ...request, afterRevision: current.changeRevision }),
    ).toBeRejectedWithError(/eight/);
    control.dispose();
    expect((await Promise.allSettled(waits)).every((result) => result.status === "rejected")).toBe(
      true,
    );
    expect(control.waits.size).toBe(0);
  });

  it("reports timeout and close and advertises explicit MCP schemas", async () => {
    const { notebookId, editor, document } = await create();
    const read = await control.getNotebookSnapshot({ notebookId });
    expect(
      (
        await control.waitForNotebookChange({
          notebookId,
          afterRevision: read.changeRevision,
          timeoutMs: 0,
        })
      ).changed,
    ).toBe(false);
    const close = control.waitForNotebookChange({ notebookId, afterRevision: read.changeRevision });
    editor.destroy();
    expect(document.isDestroyed()).toBe(true);
    expect(control.records.has(notebookId)).toBe(false);
    expect(control.waits.size).toBe(0);
    expect((await close).kind).toBe("closed");
    const tools = notebookTools(control);
    expect(tools.map((tool) => tool.name)).toContain("EditJupyterCell");
    expect(tools.find((tool) => tool.name === "EditJupyterCell").inputSchema.required).toContain(
      "expectedRevision",
    );
    expect(
      tools.find((tool) => tool.name === "WaitForJupyterNotebookChange").annotations.readOnlyHint,
    ).toBe(true);
  });
});
