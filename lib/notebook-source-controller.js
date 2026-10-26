const { CompositeDisposable, Disposable, TextBuffer } = require("lumine");
const cellSource = require("./cell-source");
const notebookJSON = require("./notebook-json");

const HISTORY_METADATA_KEY = "jupyter_view";
const HISTORY_STATE_KEY = "history_state";

function nextFrame(callback) {
  if (lumine.views?.updateDocument) return lumine.views.updateDocument(callback);
  return setTimeout(callback, 0);
}

class NotebookSourceController {
  constructor(document, serializedState = null) {
    this.document = document;
    this.serializedState = serializedState;
    this.editors = new Set();
    this.sourceEditor = null;
    this.disposables = new CompositeDisposable();
    this.lastAppliedSource = null;
    this.pendingWrites = [];
    this.projectedStates = [];
    this.jsonSourceCache = new WeakMap();
    this.parseGeneration = 0;
    this.lastCommittedHistoryStateId = null;
    this.lastCommittedLineEndingRevision = null;
    this.writing = false;
    this.applying = false;
    this.scheduled = null;
    this.pendingOrigin = null;
    this.historyDirection = null;
    this.historyEditor = null;
    this.initialized = false;
  }

  async attach(editor, serializedState = null) {
    if (this.document.isDestroyed() || editor._destroyed) return null;
    this.editors.add(editor);
    if (!this.serializedState && serializedState) this.serializedState = serializedState;
    if (!this.setupPromise) this.setupPromise = this.setup(editor);
    await this.setupPromise;
    if (this.document.isDestroyed() || editor._destroyed || !this.editors.has(editor)) return null;
    editor.sourceEditor = this.sourceEditor;
    return this.sourceEditor;
  }

  detach(editor) {
    this.editors.delete(editor);
    if (this.pendingOrigin === editor) this.pendingOrigin = null;
    if (this.historyEditor === editor) this.historyEditor = null;
  }

  async setup(hostEditor) {
    const serializedBufferState = this.serializedState?.bufferState || null;
    // A short-lived older state format removed the backing file fields from a
    // file-backed TextBuffer without adding its projected text. Such a state
    // can restore history metadata but only into an empty buffer. Treat it as
    // unusable and rebuild the projection from the already-restored notebook.
    const bufferState =
      typeof serializedBufferState?.text === "string" ||
      serializedBufferState?.textSnapshot ||
      serializedBufferState?.filePath
        ? serializedBufferState
        : null;
    let buffer = null;
    if (bufferState && typeof TextBuffer?.deserialize === "function") {
      try {
        buffer = await TextBuffer.deserialize(bufferState);
      } catch (error) {
        console.warn("[jupyter-view] Could not deserialize source history:", error.message);
      }
    }

    if (this.document.isDestroyed() || this.document.disposables.disposed) {
      buffer?.destroy();
      return null;
    }
    hostEditor = this.editors.has(hostEditor) ? hostEditor : this.getActiveEditor();
    if (!hostEditor) {
      buffer?.destroy();
      return null;
    }

    this.sourceEditor = lumine.workspace.buildTextEditor({
      ...(buffer ? { buffer } : {}),
      mini: false,
      lineNumberGutterVisible: false,
    });
    this.sourceEditor.isJupyterNotebookSourceEditor = true;
    this.sourceEditor.getJupyterNotebookEditors = () => Array.from(this.editors);
    const setSourceEncoding = this.sourceEditor.setEncoding.bind(this.sourceEditor);
    setSourceEncoding("utf8");
    this.sourceEditor.getEncoding = () => "utf8";
    this.sourceEditor.setEncoding = (encoding = "utf8") => {
      const normalized = String(encoding)
        .toLowerCase()
        .replace(/[^0-9a-z]/g, "");
      if (normalized !== "utf8") return false;
      setSourceEncoding("utf8");
      return true;
    };
    this.sourceEditor.isEncodingReadOnly = () => true;
    this.sourceEditor.getLineEndings = () => this.document.getLineEndings();
    this.sourceEditor.setLineEnding = (lineEnding) => this.setLineEnding(lineEnding);
    this.sourceEditor.onDidChangeLineEndings = (callback) =>
      this.document.onDidChangeLineEndings(callback);
    this.sourceEditor
      .getBuffer?.()
      .setPreferredLineEnding?.(this.document.getPreferredLineEnding());

    this.disposables.add(
      new Disposable(() => this.sourceEditor?.destroy()),
      this.sourceEditor.onDidChange(() => {
        if (this.writing) return;
        this.document.setPendingCellSourceChange(this, true);
        if (this.pendingWrites.length) {
          // Read-only protects interactive edits. A provider may bypass that
          // boundary, so retain both revisions rather than publishing over it.
          this.projectionInvalidated = true;
          this.parseGeneration++;
          return;
        }
        const reason = this.historyDirection
          ? `source-editor-${this.historyDirection}`
          : "source-editor-change";
        this.applySnapshot(reason, this.historyEditor || this.getActiveEditor());
      }),
      this.document.onDidChange((event) => {
        if (this.applying || event?.affectsSource !== true) return;
        this.scheduleSnapshot(event.reason, event.originEditor);
      }),
      this.document.onDidChangePath(() => this.updatePath()),
      this.document.onDidChangeLineEndings(() => {
        this.sourceEditor
          ?.getBuffer?.()
          ?.setPreferredLineEnding?.(this.document.getPreferredLineEnding());
      }),
    );
    this.document.disposables.add(this.disposables);

    this.updatePath();
    this.ensureGrammar();

    if (bufferState && this.serializedState?.pendingWrites?.length) {
      this.lastAppliedSource = this.sourceEditor.getBuffer().getTextSnapshot();
      this.pendingWrites = this.serializedState.pendingWrites.map((record) => ({
        ...record,
        notebook: {
          ...record.notebook,
          cells: record.notebook.cells.map((cell) => ({
            ...cell,
            source: cellSource.fromNotebook(cell),
          })),
        },
      }));
      await this.drainWrites();
    } else if (bufferState) {
      this.lastCommittedHistoryStateId = this.document.currentHistoryStateId;
      this.lastCommittedLineEndingRevision = this.document.lineEndingRevision;
      await this.applySnapshot("deserialize-source-editor", hostEditor, { force: true });
    } else {
      await this.commitSnapshot("initial", hostEditor, { force: true, preserveUndo: false });
    }
    this.serializedState = null;
    this.initialized = true;
  }

  getActiveEditor() {
    const active = lumine.workspace.getCenter?.().getActivePaneItem?.();
    if (this.editors.has(active)) return active;
    return this.editors.values().next().value || null;
  }

  updatePath() {
    const buffer = this.sourceEditor?.getBuffer?.();
    const filePath = this.document.filePath || undefined;
    if (buffer?.getPath?.() !== filePath) {
      buffer?.setPath?.(filePath);
    }
  }

  ensureGrammar() {
    if (!this.sourceEditor) return;
    lumine.hooks.trigger?.("source.jupyter:root-scope-used");
    const applyGrammar = () => {
      if (this.document.isDestroyed() || this.sourceEditor.isDestroyed()) return false;
      const grammar = lumine.grammars.grammarForScopeName("source.jupyter");
      if (!grammar) return false;
      if (this.sourceEditor.getGrammar?.()?.scopeName !== grammar.scopeName) {
        this.sourceEditor.setGrammar(grammar);
      }
      if (!this.linterRegistration) {
        // Only pane items are linted on their own, so the source editor is
        // handed to the linter explicitly; its diagnostics reach the cells
        // through the `linter.adapter` this package provides.
        this.linterRegistration = require("./linter-editors").addLinterEditor(this.sourceEditor);
        this.disposables.add(this.linterRegistration);
      }
      return true;
    };
    if (applyGrammar()) return;

    const grammarDisposable = lumine.grammars.onDidAddGrammar(() => {
      if (applyGrammar()) retryDisposable.dispose();
    });
    const timeoutId = setTimeout(() => {
      if (applyGrammar()) retryDisposable.dispose();
    }, 1000);
    const retryDisposable = new Disposable(() => {
      grammarDisposable.dispose();
      clearTimeout(timeoutId);
    });
    this.disposables.add(retryDisposable);
  }

  scheduleSnapshot(reason = "document-change", originEditor = null) {
    this.parseGeneration++;
    this.pendingOrigin = originEditor || this.pendingOrigin || this.getActiveEditor();
    if (this.scheduled) return;
    const token = {};
    this.scheduled = token;
    nextFrame(() => {
      if (this.scheduled !== token) return;
      this.scheduled = null;
      const origin = this.pendingOrigin;
      this.pendingOrigin = null;
      this.commitSnapshot(reason, origin);
    });
  }

  commitSnapshot(reason = "sync", originEditor = null, options = {}) {
    const host = originEditor || this.getActiveEditor();
    if (!host || !this.sourceEditor || this.applying) return;
    const previous = this.pendingWrites.at(-1);
    const historyStateId = this.document.currentHistoryStateId;
    const lineEndingRevision = this.document.lineEndingRevision;
    if (
      !options.force &&
      (previous?.historyStateId ?? this.lastCommittedHistoryStateId) === historyStateId &&
      (previous?.lineEndingRevision ?? this.lastCommittedLineEndingRevision) === lineEndingRevision
    ) {
      this.scheduled = null;
      this.pendingOrigin = null;
      return this.projectionPromise;
    }
    this.updatePath();
    const notebook = notebookJSON.captureValue(
      host.getSourceEditorJSON({
        includeHistoryState: true,
        sourceObjects: true,
      }),
    );
    const historyState = notebook.metadata?.[HISTORY_METADATA_KEY]?.[HISTORY_STATE_KEY];
    if (historyState) historyState.historyStateId = historyStateId;
    const record = {
      notebook,
      historyStateId,
      lineEndingRevision,
      lineEnding: this.document.getPreferredLineEnding(),
      preserveUndo: options.preserveUndo !== false,
    };
    this.scheduled = null;
    this.pendingOrigin = null;
    this.parseGeneration++;
    const small = this.pendingWrites.length ? null : notebookJSON.stringifySmall(notebook);
    if (small !== null) {
      this.publishSnapshot(
        record,
        cellSource.snapshot(formatLineEndings(small, record.lineEnding)),
      );
      return reason;
    }
    this.pendingWrites.push(record);
    return this.drainWrites();
  }

  publishSnapshot(record, source) {
    const buffer = this.sourceEditor.getBuffer();
    this.writing = true;
    try {
      const write = () => buffer.setTextViaDiff(source);
      if (record.preserveUndo) buffer.transact(write);
      else {
        write();
        this.clearUndoStack();
      }
      this.lastAppliedSource = buffer.getTextSnapshot();
      this.lastCommittedHistoryStateId = record.historyStateId;
      this.lastCommittedLineEndingRevision = record.lineEndingRevision;
      this.document.setPendingCellSourceChange(this, false);
      this.projectedStates.push({ source: this.lastAppliedSource, notebook: record.notebook });
      // This accelerates recent undo without becoming a second unbounded
      // history. Older revisions remain exact in the buffer's source history.
      if (this.projectedStates.length > 32) this.projectedStates.shift();
    } finally {
      this.writing = false;
    }
  }

  drainWrites() {
    if (this.projectionPromise) return this.projectionPromise;
    this.sourceEditor?.setReadOnly(true);
    this.projectionPromise = (async () => {
      while (this.pendingWrites.length) {
        if (this.projectionInvalidated)
          throw new Error(
            "Notebook source was changed by a provider while its projection was pending. Both the source buffer and pending notebook edits remain in session recovery.",
          );
        const record = this.pendingWrites[0];
        const source = await notebookJSON.stringifySource(record.notebook, {
          cache: this.jsonSourceCache,
          lineEnding: record.lineEnding,
          isCurrent: () =>
            !this.projectionInvalidated &&
            !this.document.isDestroyed() &&
            !this.sourceEditor.isDestroyed(),
        });
        this.publishSnapshot(record, source);
        this.pendingWrites.shift();
      }
    })().finally(() => {
      this.projectionPromise = null;
      this.sourceEditor?.setReadOnly(this.pendingWrites.length > 0);
    });
    // Callers which require durability await flush(); background scheduling must
    // report failures without discarding the captured model/history records.
    this.projectionPromise.catch((error) => {
      if (error.name === "AbortError") return;
      lumine.notifications.addError("Could not update notebook source projection", {
        detail: error.message,
        dismissable: true,
      });
    });
    return this.projectionPromise;
  }

  applySnapshot(reason = "source-editor-change", invokingEditor = null, options = {}) {
    const host = invokingEditor || this.getActiveEditor();
    if (!host || !this.sourceEditor || this.writing || this.applying) return;
    const source = this.sourceEditor.getBuffer().getTextSnapshot();
    if (!options.force && this.lastAppliedSource?.equals(source)) {
      this.document.setPendingCellSourceChange(this, false);
      return;
    }
    this.document.setPendingCellSourceChange(this, true);
    const generation = ++this.parseGeneration;
    const isCurrent = () =>
      generation === this.parseGeneration &&
      !this.document.isDestroyed() &&
      !this.sourceEditor.isDestroyed() &&
      this.sourceEditor.getBuffer().getTextSnapshot() === source;
    const cached = this.projectedStates.findLast((entry) => entry.source.equals(source));
    if (cached) {
      const notebook = {
        ...cached.notebook,
        metadata: host.stripHistoryMetadata(cached.notebook.metadata || {}),
      };
      const uiState = cached.notebook.metadata?.[HISTORY_METADATA_KEY]?.[HISTORY_STATE_KEY] || null;
      return this.applyParsedSnapshot({ notebook, uiState }, source, reason, host);
    }
    if (source.length <= 1024 * 1024) {
      const parsed = host.parseSourceEditorSnapshot(source.toString());
      if (parsed) return this.applyParsedSnapshot(parsed, source, reason, host);
      return;
    }
    const parse = notebookJSON
      .parseSource(source, { isCurrent })
      .then((notebook) => {
        if (!isCurrent()) return;
        const uiState = notebook.metadata?.[HISTORY_METADATA_KEY]?.[HISTORY_STATE_KEY] || null;
        notebook.metadata = host.stripHistoryMetadata(notebook.metadata || {});
        return this.applyParsedSnapshot({ notebook, uiState }, source, reason, host);
      })
      .catch((error) => {
        if (error.name !== "AbortError")
          console.warn("[jupyter-view] Could not apply source editor snapshot:", error.message);
      })
      .finally(() => {
        if (this.pendingParse === parse) this.pendingParse = null;
      });
    this.pendingParse = parse;
    return parse;
  }

  applyParsedSnapshot(parsed, source, reason, host) {
    const historyChange = host.classifyHistoryChange(parsed.notebook);
    const changedCellIds = Array.from(
      new Set([...historyChange.changedCellIds, ...historyChange.changedCellMetadataIds]),
    );
    const isHistory = reason === "source-editor-undo" || reason === "source-editor-redo";
    const cursorPlan =
      isHistory && historyChange.sourceOnly
        ? host.captureSourceHistoryCursorPlan(historyChange)
        : null;
    this.applying = true;
    try {
      this.document.applySourceSnapshot(parsed.notebook, {
        reason,
        cellIds: historyChange.metadataChanged ? [] : changedCellIds,
        structural: historyChange.structural,
        originEditor: host,
        historyStateId: parsed.uiState?.historyStateId,
        lineEndings: parsed.uiState?.lineEndings || detectLineEndings(source).lineEndings,
        firstLineEnding:
          parsed.uiState?.firstLineEnding || detectLineEndings(source).firstLineEnding,
      });
      this.lastAppliedSource = source;
      this.lastCommittedHistoryStateId = this.document.currentHistoryStateId;
      this.lastCommittedLineEndingRevision = this.document.lineEndingRevision;
      this.scheduled = null;
      this.pendingOrigin = null;
      this.document.setPendingCellSourceChange(this, false);

      if (isHistory || reason === "deserialize-source-editor") {
        if (historyChange.structural || reason === "deserialize-source-editor") {
          host.activeCellIndex = host.resolveHistoryActiveCellIndex(parsed.uiState);
          host.updateView();
          host.restoreHistoryUIState(parsed.uiState, {
            restoreSelection: reason === "deserialize-source-editor",
          });
        } else {
          if (historyChange.changedCellIds.length === 1) {
            const index = host._findCellIndex(historyChange.changedCellIds[0]);
            if (index !== -1) host.activeCellIndex = index;
          }
          const mode = host.restoreHistoryMode(parsed.uiState);
          host.view?.clearSelection?.();
          if (cursorPlan) host.restoreSourceHistoryCursors(cursorPlan, mode);
          else host.focusHistoryMode(mode);
        }
      }
    } finally {
      this.applying = false;
    }
    return reason;
  }

  flushPendingChanges(invokingEditor = null) {
    const editors = Array.from(this.editors);
    const workspaceActiveEditor = lumine.workspace.getCenter?.().getActivePaneItem?.();
    const winner = this.editors.has(workspaceActiveEditor)
      ? workspaceActiveEditor
      : invokingEditor || editors[0];
    for (const editor of editors) {
      if (editor !== winner) editor.flushPendingCellSourceChanges?.();
    }
    winner?.flushPendingCellSourceChanges?.();
    if (this.scheduled) this.commitSnapshot("flush", winner || this.pendingOrigin);
  }

  setLineEnding(lineEnding, invokingEditor = null) {
    if (lineEnding !== "\n" && lineEnding !== "\r\n") return false;
    const editor = invokingEditor || this.getActiveEditor();
    this.flushPendingChanges(editor);
    this.commitSnapshot("before-line-endings", editor);
    const changed = this.document.setLineEnding(lineEnding, editor);
    if (changed) this.commitSnapshot("line-endings", editor);
    return changed;
  }

  performHistory(direction, invokingEditor) {
    if (!this.sourceEditor || !["undo", "redo"].includes(direction)) return;
    this.flushPendingChanges(invokingEditor);
    this.commitSnapshot(`before-${direction}`, invokingEditor);
    const perform = () => {
      const buffer = this.sourceEditor.getBuffer();
      const before = buffer.getTextSnapshot();
      this.historyDirection = direction;
      this.historyEditor = invokingEditor;
      try {
        buffer[direction]();
      } finally {
        this.historyDirection = null;
        this.historyEditor = null;
      }
      const after = buffer.getTextSnapshot();
      if (!before.equals(after) && !this.lastAppliedSource?.equals(after) && !this.pendingParse) {
        return this.applySnapshot(`source-editor-${direction}`, invokingEditor);
      }
      return this.pendingParse;
    };
    return this.projectionPromise ? this.projectionPromise.then(perform) : perform();
  }

  async flush(invokingEditor = null) {
    this.flushPendingChanges(invokingEditor);
    while (this.projectionPromise || this.pendingParse || this.pendingWrites.length) {
      if (this.pendingWrites.length && !this.projectionPromise) this.drainWrites();
      await (this.projectionPromise || this.pendingParse);
    }
  }

  canSaveModel() {
    if (this.pendingParse || this.projectionInvalidated) return false;
    return Boolean(
      this.pendingWrites.length > 0 ||
      !this.sourceEditor ||
      this.lastAppliedSource?.equals(this.sourceEditor.getBuffer().getTextSnapshot()),
    );
  }

  clearUndoStack() {
    this.sourceEditor?.clearUndoStack?.();
    this.sourceEditor?.getBuffer?.()?.clearUndoStack?.();
  }

  serialize() {
    this.flushPendingChanges(this.getActiveEditor());
    const buffer = this.sourceEditor?.getBuffer?.();
    if (!buffer?.serialize) return null;
    const bufferState = buffer.serialize({
      history: true,
      markerLayers: false,
      textSnapshots: true,
    });
    // The source projection intentionally excludes runtime outputs. Restore its
    // immutable roots and undo history, never the different notebook disk file.
    bufferState.textSnapshot = buffer.getTextSnapshot();
    delete bufferState.text;
    delete bufferState.filePath;
    delete bufferState.digestWhenLastPersisted;
    delete bufferState.outstandingChanges;
    return { bufferState, pendingWrites: this.pendingWrites.slice() };
  }
}

module.exports = NotebookSourceController;

function formatLineEndings(text, lineEnding) {
  return String(text).replace(/\r\n|\r|\n/g, lineEnding);
}

function detectLineEndings(source) {
  const lineEndings = source.getLineEndings();
  const nextLineStart = source.lineCount > 1 ? source.lineStart(1) : 0;
  const firstLineEnding =
    nextLineStart >= 2 && source.charCodeAt(nextLineStart - 2) === 13 ? "\r\n" : "\n";
  if (!lineEndings.size) lineEndings.add("\n");
  return { lineEndings, firstLineEnding };
}
