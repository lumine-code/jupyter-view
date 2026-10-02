const { CompositeDisposable, Emitter } = require("lumine");
const { randomUUID, createHash } = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs").promises;
const { pathToFileURL } = require("node:url");
const { setTimeout, clearTimeout } = require("node:timers");

const MAX_OPERATIONS = 128;
const MAX_WAITS = 8;

function validateArguments(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Unexpected notebook request arguments.");
}

function booleanOption(value, name) {
  if (value !== undefined && typeof value !== "boolean")
    throw new Error(`${name} must be a boolean.`);
}

function boundedInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > maximum)
    throw new Error(`Expected an integer from 0 to ${maximum}.`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function aborted(message = "Notebook request cancelled.") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function textSlice(text, offset, limit) {
  text = Array.isArray(text) ? text.join("") : String(text ?? "");
  return {
    text: text.slice(offset, offset + limit),
    offset,
    totalChars: text.length,
    truncated: offset > 0 || offset + limit < text.length,
  };
}

function outputSnapshot(output, limit = 2000) {
  const value = {
    outputType: output.output_type,
    ...(output.name ? { name: output.name } : {}),
    ...(output.execution_count != null ? { executionCount: output.execution_count } : {}),
  };
  if (output.output_type === "error") {
    value.errorName = String(output.ename || "").slice(0, 200);
    value.errorValue = textSlice(output.evalue, 0, limit);
    value.traceback = textSlice((output.traceback || []).join("\n"), 0, limit);
  } else if (output.text != null) value.text = textSlice(output.text, 0, limit);
  if (output.data) {
    value.mimeTypes = Object.keys(output.data).slice(0, 50);
    value.representations = value.mimeTypes.map((mimeType) => {
      const data = output.data[mimeType];
      const textual = mimeType.startsWith("text/") && mimeType !== "text/vnd.plotly.v1+html";
      return {
        mimeType,
        ...(textual
          ? { preview: textSlice(data, 0, limit) }
          : {
              kind: typeof data === "object" ? "structured" : "binary",
              chars: typeof data === "string" ? data.length : null,
            }),
      };
    });
  }
  return value;
}

class NotebookControl {
  constructor(host) {
    this.host = host;
    this.registry = host.getDocumentRegistry();
    this.generation = randomUUID();
    this.records = new Map();
    this.operations = new Map();
    this.waits = new Set();
    this.emitter = new Emitter();
    this.disposed = false;
    this.subscriptions = new CompositeDisposable(
      this.registry.observeDocuments((document) => this.track(document)),
      this.registry.onDidRemoveDocument((document) => this.remove(document)),
    );
  }

  track(document) {
    if (this.records.has(document.id)) return;
    const record = {
      document,
      epoch: randomUUID(),
      source: 0,
      change: 0,
      operations: new Map(),
      tail: Promise.resolve(),
      subscriptions: new CompositeDisposable(),
    };
    this.records.set(document.id, record);
    const changed = (kind, source = false, cellIds = []) => {
      if (source) record.source++;
      record.change++;
      this.emitter.emit("did-change-notebook", this.event(record, kind, cellIds));
    };
    record.subscriptions.add(
      document.onDidChange((event) =>
        changed(event.reason || event.category, event.category === "history", event.cellIds),
      ),
      document.onDidLoad(() => changed("loaded", true)),
      document.onDidReload(() => changed("reloaded", true)),
      document.onDidSave(() => changed("saved")),
      document.onDidChangePath(() => changed("path")),
      document.onDidChangeFileState(() => changed("file-state")),
    );
  }

  revision(record) {
    return `${record.epoch}:source:${record.source}`;
  }
  changeRevision(record) {
    return `${record.epoch}:change:${record.change}`;
  }
  event(record, kind, cellIds = []) {
    return {
      notebookId: record.document.id,
      revision: this.revision(record),
      changeRevision: this.changeRevision(record),
      kind,
      cellIds: [...cellIds],
    };
  }

  remove(document) {
    const record = this.records.get(document.id);
    if (!record || record.document !== document) return;
    record.change++;
    this.emitter.emit("did-change-notebook", { ...this.event(record, "closed"), closed: true });
    record.subscriptions.dispose();
    record.operations.clear();
    this.records.delete(document.id);
  }

  record(notebookId) {
    if (this.disposed) throw new Error("The notebook provider was unloaded.");
    if (typeof notebookId !== "string" || !notebookId)
      throw new Error("An explicit notebookId is required.");
    const record = this.records.get(notebookId);
    if (!record || record.document.isDestroyed())
      throw new Error("The notebook is closed or its generation is unknown. List notebooks again.");
    return record;
  }

  getNotebookRevision = (notebookId) => {
    const record = this.record(notebookId);
    if (this.registry.isDocumentLoading(notebookId))
      throw new Error("The notebook is still loading.");
    this.flush(record.document);
    return this.revision(record);
  };

  flush(document) {
    const editors = this.host.getNotebookEditors(document);
    for (const editor of editors) editor.flushPendingCellSourceChanges();
    if (editors[0]) editors[0].sourceController?.flushPendingChanges(editors[0]);
    return editors[0] || null;
  }

  async ready(notebookId, writable = false) {
    const record = this.record(notebookId);
    await this.registry.whenDocumentReady(notebookId);
    if (this.record(notebookId) !== record) throw new Error("The notebook generation changed.");
    let editor = this.host.getNotebookEditors(record.document)[0] || null;
    if (editor?._sourceEditorSetupPromise) await editor._sourceEditorSetupPromise;
    if (this.record(notebookId) !== record)
      throw new Error("The notebook closed while preparing the request.");
    editor = this.flush(record.document);
    if (writable && (!editor || editor._destroyed || !editor.sourceController?.sourceEditor))
      throw new Error("The notebook has no ready editor. Open it before editing.");
    return { record, document: record.document, editor };
  }

  summary(record) {
    const document = record.document;
    return {
      notebookId: document.id,
      revision: this.revision(record),
      changeRevision: this.changeRevision(record),
      generation: this.generation,
      path: document.filePath || null,
      uri: document.filePath
        ? pathToFileURL(document.filePath).href
        : `lumine://jupyter-notebook/${document.id}`,
      cellCount: document.cells.length,
      modified: document.modified,
      fileState: document.getFileState(),
      language:
        document.metadata.language_info?.name || document.metadata.kernelspec?.language || null,
      loading: this.registry.isDocumentLoading(document.id),
    };
  }

  listNotebooks = (options = {}) => {
    validateArguments(options, ["offset", "limit"]);
    let { offset, limit } = options;
    if (this.disposed) throw new Error("The notebook provider was unloaded.");
    offset = boundedInteger(offset, 0, Number.MAX_SAFE_INTEGER);
    limit = boundedInteger(limit, 50, 100);
    const records = [...this.records.values()];
    return {
      generation: this.generation,
      total: records.length,
      offset,
      notebooks: records.slice(offset, offset + limit).map((record) => this.summary(record)),
      truncated: offset + limit < records.length,
    };
  };

  cellSnapshot(document, cell, options = {}) {
    booleanOption(options.includeOutputs, "includeOutputs");
    const sourceOffset = boundedInteger(options.sourceOffset, 0, Number.MAX_SAFE_INTEGER);
    const sourceLimit = boundedInteger(options.sourceLimit, 16000, 65536);
    const outputOffset = boundedInteger(options.outputOffset, 0, Number.MAX_SAFE_INTEGER);
    const outputLimit = boundedInteger(options.outputLimit, 10, 25);
    return {
      cellId: cell.id,
      index: document.cells.indexOf(cell),
      type: cell.type,
      sourceRevision: cell.sourceRevision,
      source: textSlice(cell.source, sourceOffset, sourceLimit),
      executionCount: cell.executionCount ?? null,
      status: cell.status || null,
      outputCount: cell.outputs?.length || 0,
      ...(options.includeOutputs === false
        ? {}
        : {
            outputOffset,
            outputs: (cell.outputs || [])
              .slice(outputOffset, outputOffset + outputLimit)
              .map((output) => outputSnapshot(output)),
            outputsTruncated: outputOffset + outputLimit < (cell.outputs?.length || 0),
          }),
    };
  }

  getNotebookSnapshot = async (options = {}) => {
    validateArguments(options, ["notebookId", "offset", "limit", "sourceLimit"]);
    let { notebookId, offset, limit, sourceLimit } = options;
    const { record, document } = await this.ready(notebookId);
    offset = boundedInteger(offset, 0, Number.MAX_SAFE_INTEGER);
    limit = boundedInteger(limit, 50, 100);
    sourceLimit = boundedInteger(sourceLimit, 1000, 1000);
    return {
      ...this.summary(record),
      offset,
      cells: document.cells
        .slice(offset, offset + limit)
        .map((cell) => this.cellSnapshot(document, cell, { sourceLimit, includeOutputs: false })),
      truncated: offset + limit < document.cells.length,
    };
  };

  getCellSnapshot = async (options = {}) => {
    validateArguments(options, [
      "notebookId",
      "cellId",
      "sourceOffset",
      "sourceLimit",
      "outputOffset",
      "outputLimit",
      "includeOutputs",
    ]);
    booleanOption(options.includeOutputs, "includeOutputs");
    const { record, document } = await this.ready(options.notebookId);
    const cell = document.cells.find((cell) => cell.id === options.cellId);
    if (!cell) throw new Error("Unknown cellId in this notebook.");
    return { ...this.summary(record), ...this.cellSnapshot(document, cell, options) };
  };

  getExecutionAdapter = (notebookId) => {
    const record = this.record(notebookId);
    if (this.registry.isDocumentLoading(notebookId))
      throw new Error("The notebook is still loading.");
    const editor = this.flush(record.document);
    if (!editor || editor._destroyed) throw new Error("The notebook has no live editor.");
    return this.host.provideJupyterAdapter().getAdapterForItem(editor);
  };

  getExecutionSnapshot = async ({
    notebookId,
    maxCells = 1000,
    maxSourceChars = 1048576,
    cellIds,
    codeOnly = false,
  } = {}) => {
    const { record, document } = await this.ready(notebookId);
    maxCells = boundedInteger(maxCells, 1000, 1000);
    maxSourceChars = boundedInteger(maxSourceChars, 1048576, 1048576);
    if (typeof codeOnly !== "boolean") throw new Error("codeOnly must be a boolean.");
    if (
      cellIds !== undefined &&
      (!Array.isArray(cellIds) ||
        cellIds.length > 1000 ||
        cellIds.some((id) => typeof id !== "string" || !id) ||
        new Set(cellIds).size !== cellIds.length)
    )
      throw new Error("cellIds must contain at most 1,000 unique stable cell IDs.");
    const selectedIds = cellIds === undefined ? null : new Set(cellIds);
    const cells = document.cells.filter(
      (cell) => (!selectedIds || selectedIds.has(cell.id)) && (!codeOnly || cell.type === "code"),
    );
    if (
      cells.length > maxCells ||
      cells.reduce((total, cell) => total + cell.source.length, 0) > maxSourceChars
    )
      throw new Error(
        "The notebook exceeds the execution snapshot limit. Select fewer cells instead.",
      );
    return {
      notebookId,
      revision: this.revision(record),
      cells: cells.map((cell) => ({
        cellId: cell.id,
        index: document.getCellIndexById(cell.id),
        type: cell.type,
        source: cell.source,
        sourceRevision: cell.sourceRevision,
      })),
    };
  };

  assertRevision(record, expectedRevision, required = true) {
    if (!required && expectedRevision === undefined) return;
    if (typeof expectedRevision !== "string" || expectedRevision !== this.revision(record))
      throw new Error(
        "The notebook source revision changed or belongs to an old generation. Read it again before editing or running.",
      );
  }

  operation(cache, request, execute) {
    if (this.disposed) return Promise.reject(new Error("The notebook provider was unloaded."));
    if (
      typeof request.operationId !== "string" ||
      !request.operationId ||
      request.operationId.length > 128
    )
      return Promise.reject(
        new Error("operationId must be a non-empty string of at most 128 characters."),
      );
    // Receipts must retain retry protection without retaining every previous
    // source replacement, which can be a megabyte for one cell.
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(canonical(request)))
      .digest("hex");
    const previous = cache.get(request.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        return Promise.reject(new Error("operationId was already used with different arguments."));
      return previous.promise.then((result) => ({ ...result, replayed: true }));
    }
    if (cache.size >= MAX_OPERATIONS) {
      return Promise.reject(
        new Error(
          "This notebook generation has reached its 128 operation receipts. Existing retries remain available; no new operations can be accepted.",
        ),
      );
    }
    const entry = { fingerprint, settled: false };
    entry.promise = Promise.resolve()
      .then(() => {
        if (this.disposed) throw new Error("The notebook provider was unloaded.");
        return execute();
      })
      .then(
        (result) => {
          entry.settled = true;
          return result;
        },
        (error) => {
          entry.settled = true;
          throw error;
        },
      );
    cache.set(request.operationId, entry);
    return entry.promise;
  }

  enqueue(record, execute) {
    const operation = record.tail.catch(() => {}).then(execute);
    record.tail = operation;
    return operation;
  }

  editCell = (request = {}) => {
    validateArguments(request, [
      "notebookId",
      "cellId",
      "operationId",
      "expectedRevision",
      "operation",
      "source",
      "type",
      "beforeCellId",
      "afterCellId",
    ]);
    for (const key of ["cellId", "beforeCellId", "afterCellId"]) {
      if (
        request[key] !== undefined &&
        (typeof request[key] !== "string" || !request[key] || request[key].length > 256)
      )
        throw new Error(`${key} must be a non-empty string of at most 256 characters.`);
    }
    const record = this.record(request.notebookId);
    return this.operation(record.operations, { ...request, action: "edit" }, () =>
      this.enqueue(record, async () => {
        const { document, editor } = await this.ready(request.notebookId, true);
        this.assertRevision(record, request.expectedRevision);
        if (!["insert", "replace", "move", "delete"].includes(request.operation))
          throw new Error("Unknown cell operation.");
        if (
          request.source !== undefined &&
          (typeof request.source !== "string" || request.source.length > 1000000)
        )
          throw new Error("source must be a string of at most 1,000,000 characters.");
        if (request.type !== undefined && !["code", "markdown", "raw"].includes(request.type))
          throw new Error("Unknown cell type.");
        if (request.beforeCellId && request.afterCellId)
          throw new Error("Choose beforeCellId or afterCellId, not both.");
        let index = document.cells.findIndex((cell) => cell.id === request.cellId);
        if (request.operation !== "insert" && index < 0)
          throw new Error("Unknown cellId in this notebook.");
        const anchorId = request.beforeCellId || request.afterCellId;
        const anchorIndex = anchorId
          ? document.cells.findIndex((cell) => cell.id === anchorId)
          : document.cells.length;
        if (anchorId && anchorIndex < 0) throw new Error("Unknown anchor cellId in this notebook.");
        if (request.operation === "move" && anchorId === request.cellId)
          throw new Error("A cell cannot be its own move anchor.");
        if (
          request.operation === "replace" &&
          request.source === undefined &&
          request.type === undefined
        )
          throw new Error("Replace requires source or type.");
        editor.prepareForNotebookOperation();
        let cellId = request.cellId,
          cleared = false;
        const insertion = anchorIndex + (request.afterCellId ? 1 : 0);
        if (request.operation === "insert") {
          const [cell] = document.insertCellsFromData(
            insertion,
            [{ cell_type: request.type || "code", source: request.source || "", metadata: {} }],
            editor,
          );
          cellId = cell.id;
        } else if (request.operation === "replace") {
          if (request.source !== undefined)
            document.updateCellSource(index, request.source, editor);
          if (request.type !== undefined) document.changeCellType(index, request.type);
        } else if (request.operation === "delete") {
          cleared = document.cells.length === 1;
          document.deleteCell(index);
        } else {
          document.moveCells([index], insertion);
        }
        editor.sourceController.commitSnapshot("mcp-edit-cell", editor);
        return {
          ...this.event(record, "edited", [cellId]),
          operationId: request.operationId,
          operation: request.operation,
          cellId,
          cleared,
          replayed: false,
        };
      }),
    );
  };

  saveNotebook = (request = {}) => {
    validateArguments(request, [
      "notebookId",
      "operationId",
      "expectedRevision",
      "path",
      "overwrite",
    ]);
    booleanOption(request.overwrite, "overwrite");
    if (request.path !== undefined) this.validatePath(request.path);
    const record = this.record(request.notebookId);
    return this.operation(record.operations, { ...request, action: "save" }, () =>
      this.enqueue(record, async () => {
        let { document } = await this.ready(request.notebookId, true);
        let editor;
        this.assertRevision(record, request.expectedRevision, false);
        const filePath = request.path || document.filePath;
        this.validatePath(filePath);
        if (filePath !== document.filePath && !request.overwrite) {
          try {
            await fs.stat(filePath);
            throw new Error("The destination exists. Set overwrite explicitly to replace it.");
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        // File checks may yield while the user edits or closes the notebook.
        ({ document, editor } = await this.ready(request.notebookId, true));
        this.assertRevision(record, request.expectedRevision, false);
        if (["conflicted", "removed"].includes(document.getFileState()) && !request.overwrite)
          throw new Error(
            "The notebook has external file changes. Resolve them or explicitly allow overwrite.",
          );
        editor.prepareForNotebookOperation();
        const previousPath = document.filePath;
        const previousFileState = document.getFileState();
        if (filePath !== document.filePath) document.setPath(filePath);
        const attemptedFile = document.file;
        try {
          if (!(await document.save())) throw new Error("The notebook could not be saved.");
        } catch (error) {
          // Restore only our own failed Save As. A user rename (even away and
          // back to the same name) replaces the File identity and wins.
          if (
            previousPath !== filePath &&
            !document.isDestroyed() &&
            document.filePath === filePath &&
            document.file === attemptedFile
          ) {
            document.setPath(previousPath);
            document.setFileState(previousFileState);
            document.updateModifiedState();
          }
          throw error;
        }
        return {
          notebookId: request.notebookId,
          path: filePath,
          saved: true,
          operationId: request.operationId,
          revision: this.revision(record),
          changeRevision: this.changeRevision(record),
          replayed: false,
        };
      }),
    );
  };

  validatePath(filePath) {
    if (
      typeof filePath !== "string" ||
      !path.isAbsolute(filePath) ||
      path.extname(filePath).toLowerCase() !== ".ipynb"
    )
      throw new Error("An absolute .ipynb path is required.");
  }

  openNotebook = (request = {}) => {
    validateArguments(request, ["path", "expectedGeneration", "operationId"]);
    if (request.expectedGeneration !== this.generation)
      return Promise.reject(
        new Error(
          "The notebook provider generation changed. List notebooks again before opening one.",
        ),
      );
    const filePath = request.path;
    return this.operation(this.operations, { ...request, action: "open" }, async () => {
      this.validatePath(filePath);
      if (!(await fs.stat(filePath)).isFile())
        throw new Error("The notebook path must name a file.");
      if (this.disposed) throw new Error("The notebook provider was unloaded.");
      const existing = this.registry.getDocument(filePath);
      let editor = existing && this.host.getNotebookEditors(existing)[0];
      if (!editor) editor = await this.host.openNotebook(filePath);
      await lumine.workspace.open(editor, { activatePane: false });
      return {
        ...(await this.getNotebookSnapshot({ notebookId: editor.document.id })),
        operationId: request.operationId,
        replayed: false,
      };
    }).then((result) => {
      this.record(result.notebookId);
      return result;
    });
  };

  createNotebook = (request = {}) => {
    validateArguments(request, ["expectedGeneration", "operationId", "language"]);
    if (request.expectedGeneration !== this.generation)
      return Promise.reject(
        new Error(
          "The notebook provider generation changed. List notebooks again before creating one.",
        ),
      );
    if (
      request.language !== undefined &&
      (typeof request.language !== "string" || !request.language || request.language.length > 80)
    )
      return Promise.reject(new Error("Invalid notebook language."));
    return this.operation(this.operations, { ...request, action: "create" }, async () => {
      const editor = await this.host.newNotebook();
      const { document } = await this.ready(editor.document.id, true);
      if (request.language && request.language !== "python") {
        document.updateMetadata(
          {
            ...document.metadata,
            kernelspec: undefined,
            language_info: { name: request.language },
          },
          editor,
        );
        editor.sourceController.commitSnapshot("mcp-create-notebook", editor);
      }
      return {
        ...(await this.getNotebookSnapshot({ notebookId: document.id })),
        operationId: request.operationId,
        replayed: false,
      };
    }).then((result) => {
      this.record(result.notebookId);
      return result;
    });
  };

  onDidChangeNotebook = (callback) => this.emitter.on("did-change-notebook", callback);

  waitForNotebookChange = (request = {}, { signal } = {}) => {
    validateArguments(request, ["notebookId", "afterRevision", "timeoutMs"]);
    const record = this.record(request.notebookId);
    if (
      typeof request.afterRevision !== "string" ||
      !request.afterRevision.startsWith(`${record.epoch}:change:`)
    )
      return Promise.reject(
        new Error("afterRevision must be the current notebook's changeRevision token."),
      );
    const timeoutMs = boundedInteger(request.timeoutMs, 20000, 25000);
    if (signal?.aborted) return Promise.reject(aborted());
    if (request.afterRevision !== this.changeRevision(record))
      return Promise.resolve({ ...this.event(record, "snapshot"), changed: true });
    if (this.waits.size >= MAX_WAITS)
      return Promise.reject(new Error("At most eight notebook waits may be pending."));
    return new Promise((resolve, reject) => {
      let subscription,
        timer,
        settled = false;
      const finish = (error, event) => {
        if (settled) return;
        settled = true;
        subscription?.dispose();
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.waits.delete(dispose);
        if (error) reject(error);
        else resolve(event);
      };
      const cancel = () => finish(aborted());
      const dispose = () => finish(aborted("The notebook provider was unloaded."));
      subscription = this.onDidChangeNotebook((event) => {
        if (event.notebookId === request.notebookId) finish(null, { ...event, changed: true });
      });
      this.waits.add(dispose);
      signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(
        () => finish(null, { ...this.event(record, "timeout"), changed: false }),
        timeoutMs,
      );
    });
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const cancel of [...this.waits]) cancel();
    this.subscriptions.dispose();
    for (const record of this.records.values()) record.subscriptions.dispose();
    this.records.clear();
    this.operations.clear();
    this.emitter.dispose();
  }
}

module.exports = { NotebookControl, outputSnapshot };
