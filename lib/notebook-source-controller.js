const { CompositeDisposable, Disposable, TextBuffer } = require("lumine");

const HISTORY_METADATA_KEY = "jupyter_view";
const HISTORY_STATE_KEY = "history_state";

function nextFrame(callback) {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(callback, 0);
}

class NotebookSourceController {
  constructor(document, serializedState = null) {
    this.document = document;
    this.serializedState = serializedState;
    this.editors = new Set();
    this.sourceEditor = null;
    this.disposables = new CompositeDisposable();
    this.lastAppliedText = null;
    this.lastCommittedHistoryStateId = null;
    this.writing = false;
    this.applying = false;
    this.scheduled = null;
    this.pendingOrigin = null;
    this.historyDirection = null;
    this.historyEditor = null;
    this.initialized = false;
  }

  async attach(editor, serializedState = null) {
    this.editors.add(editor);
    if (!this.serializedState && serializedState) this.serializedState = serializedState;
    if (!this.setupPromise) this.setupPromise = this.setup(editor);
    await this.setupPromise;
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
      typeof serializedBufferState?.text === "string" || serializedBufferState?.filePath
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

    this.sourceEditor = lumine.workspace.buildTextEditor({
      ...(buffer ? { buffer } : {}),
      mini: false,
      lineNumberGutterVisible: false,
    });
    this.sourceEditor.isJupyterNotebookSourceEditor = true;
    this.sourceEditor.getJupyterNotebookEditors = () => Array.from(this.editors);

    this.disposables.add(
      new Disposable(() => this.sourceEditor?.destroy()),
      this.sourceEditor.onDidChange(() => {
        if (this.writing) return;
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
    );
    this.document.disposables.add(this.disposables);

    this.updatePath();
    this.ensureGrammar();

    if (bufferState) {
      this.lastAppliedText = this.sourceEditor.getText();
      this.applySnapshot("deserialize-source-editor", hostEditor, { force: true });
    } else {
      this.commitSnapshot("initial", hostEditor, { force: true, preserveUndo: false });
      this.clearUndoStack();
    }
    this.initialized = true;
  }

  getActiveEditor() {
    const active = lumine.workspace.getCenter?.().getActivePaneItem?.();
    if (this.editors.has(active)) return active;
    return this.editors.values().next().value || null;
  }

  updatePath() {
    const buffer = this.sourceEditor?.getBuffer?.();
    if (this.document.filePath && buffer?.getPath?.() !== this.document.filePath) {
      buffer?.setPath?.(this.document.filePath);
    }
  }

  ensureGrammar() {
    if (!this.sourceEditor) return;
    lumine.packages.triggerActivationHook?.("source.jupyter:root-scope-used");
    lumine.packages.triggerActivationHook?.("jupyter-view:grammar-used");
    const applyGrammar = () => {
      const grammar = lumine.grammars.grammarForScopeName("source.jupyter");
      if (!grammar) return false;
      if (this.sourceEditor.getGrammar?.()?.scopeName !== grammar.scopeName) {
        this.sourceEditor.setGrammar(grammar);
      }
      if (!this.registration) {
        this.registration = lumine.textEditors.add(this.sourceEditor, { role: "background" });
        this.disposables.add(this.registration);
        // Only pane items are linted on their own, so the source editor is
        // handed to the linter explicitly; its diagnostics reach the cells
        // through the `linter.adapter` this package provides.
        this.disposables.add(require("./linter-editors").addLinterEditor(this.sourceEditor));
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
    if (
      !options.force &&
      this.lastCommittedHistoryStateId === this.document.currentHistoryStateId
    ) {
      this.scheduled = null;
      this.pendingOrigin = null;
      return;
    }
    this.updatePath();

    const notebook = host.getSourceEditorJSON({ includeHistoryState: true });
    const historyState = notebook.metadata?.[HISTORY_METADATA_KEY]?.[HISTORY_STATE_KEY] || {};
    historyState.historyStateId = this.document.currentHistoryStateId;
    const text = JSON.stringify(notebook, null, 2);
    if (!options.force && this.sourceEditor.getText() === text) {
      this.lastAppliedText = text;
      this.lastCommittedHistoryStateId = this.document.currentHistoryStateId;
      this.scheduled = null;
      return;
    }

    const buffer = this.sourceEditor.getBuffer();
    const write = () => {
      if (typeof buffer.setTextViaDiff === "function") buffer.setTextViaDiff(text);
      else this.sourceEditor.setText(text);
      this.lastAppliedText = text;
      this.lastCommittedHistoryStateId = this.document.currentHistoryStateId;
    };
    this.writing = true;
    try {
      if (options.preserveUndo === false) write();
      else if (typeof buffer.transact === "function") buffer.transact(write);
      else write();
    } finally {
      this.writing = false;
      this.scheduled = null;
      this.pendingOrigin = null;
    }
    return reason;
  }

  applySnapshot(reason = "source-editor-change", invokingEditor = null, options = {}) {
    const host = invokingEditor || this.getActiveEditor();
    if (!host || !this.sourceEditor || this.writing || this.applying) return;
    const text = this.sourceEditor.getText();
    if (!options.force && this.lastAppliedText === text) return;
    const parsed = host.parseSourceEditorSnapshot(text);
    if (!parsed) return;

    const historyChange = host.classifyHistoryChange(parsed.notebook);
    const isHistory = reason === "source-editor-undo" || reason === "source-editor-redo";
    const cursorPlan =
      isHistory && historyChange.sourceOnly
        ? host.captureSourceHistoryCursorPlan(historyChange)
        : null;
    this.applying = true;
    try {
      this.document.applySourceSnapshot(parsed.notebook, {
        reason,
        cellIds: historyChange.changedCellIds,
        structural: historyChange.structural,
        originEditor: host,
        historyStateId: parsed.uiState?.historyStateId,
      });
      this.lastAppliedText = text;
      this.lastCommittedHistoryStateId = this.document.currentHistoryStateId;
      this.scheduled = null;
      this.pendingOrigin = null;

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

  performHistory(direction, invokingEditor) {
    if (!this.sourceEditor || !["undo", "redo"].includes(direction)) return;
    this.flushPendingChanges(invokingEditor);
    this.commitSnapshot(`before-${direction}`, invokingEditor);
    const before = this.sourceEditor.getText();
    this.historyDirection = direction;
    this.historyEditor = invokingEditor;
    try {
      const buffer = this.sourceEditor.getBuffer?.();
      if (typeof buffer?.[direction] === "function") buffer[direction]();
      else this.sourceEditor[direction]?.();
    } finally {
      this.historyDirection = null;
      this.historyEditor = null;
    }
    if (
      this.sourceEditor.getText() !== before &&
      this.lastAppliedText !== this.sourceEditor.getText()
    ) {
      this.applySnapshot(`source-editor-${direction}`, invokingEditor);
    }
  }

  clearUndoStack() {
    this.sourceEditor?.clearUndoStack?.();
    this.sourceEditor?.getBuffer?.()?.clearUndoStack?.();
  }

  serialize() {
    this.flushPendingChanges(this.getActiveEditor());
    const buffer = this.sourceEditor?.getBuffer?.();
    if (!buffer?.serialize) return null;
    try {
      const bufferState = buffer.serialize({ history: true, markerLayers: false });
      // The backing buffer deliberately must not reopen the .ipynb file: its
      // text is the lightweight source projection (without outputs), not the
      // notebook JSON stored on disk. A file-backed TextBuffer omits `text`
      // from its serialized state, though, so preserve the projection before
      // removing the file restoration fields.
      bufferState.text = buffer.getText();
      delete bufferState.filePath;
      delete bufferState.digestWhenLastPersisted;
      delete bufferState.outstandingChanges;
      return { bufferState };
    } catch (error) {
      console.warn("[jupyter-view] Could not serialize source history:", error.message);
      return null;
    }
  }
}

module.exports = NotebookSourceController;
