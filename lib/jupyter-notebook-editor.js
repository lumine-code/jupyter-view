/**
 * JupyterNotebookEditor - the pane item for a Jupyter notebook.
 */

const { Emitter, CompositeDisposable, Disposable, TextBuffer } = require("lumine");
const path = require("path");
const { showChrome } = require("./notebook-chrome");

const HISTORY_METADATA_KEY = "jupyter_view";
const HISTORY_STATE_KEY = "history_state";

// Lazy load components
let NotebookView = null;
let NotebookDocument = null;

function getNotebookView() {
  if (!NotebookView) {
    NotebookView = require("./notebook-view");
  }
  return NotebookView;
}

function getNotebookDocument() {
  if (!NotebookDocument) {
    NotebookDocument = require("./notebook-document");
  }
  return NotebookDocument;
}

/**
 * JupyterNotebookEditor is a view/editor for a NotebookDocument.
 * Multiple editors can share the same document (like Lumine's TextEditor/TextBuffer).
 */
class JupyterNotebookEditor {
  static deserialize(state, deserializeServices = null) {
    // Check if there's already an open editor for this file/content
    // This prevents reloading when moving panes between containers
    const searchPath = state.filePath;

    // Search all pane items for an existing editor with same path and loaded view
    for (const paneContainer of [
      lumine.workspace.getCenter(),
      lumine.workspace.getLeftDock(),
      lumine.workspace.getRightDock(),
      lumine.workspace.getBottomDock(),
    ]) {
      if (!paneContainer) continue;
      for (const pane of paneContainer.getPanes()) {
        for (const item of pane.getItems()) {
          if (item instanceof JupyterNotebookEditor && item.view && !item._destroyed) {
            // Match by file path if available
            if (searchPath && item.getPath() === searchPath) {
              return item;
            }
          }
        }
      }
    }

    // Return a synchronous placeholder that loads asynchronously
    // This prevents Lumine from trying to create a view for a Promise
    const editor = new JupyterNotebookEditor(null, state, deserializeServices);
    return editor;
  }

  constructor(notebookDocument, deserializeState = null, deserializeServices = null) {
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();
    this.activeCellIndex = 0;
    this.view = null;
    this.document = null;
    this._loading = false;
    this._loadError = null;
    this._destroyed = false;
    this.sourceEditor = null;
    this.deserializeServices = deserializeServices;
    this._lastAppliedSourceEditorText = null;
    this._sourceEditorChangeSubscription = null;
    this._writingSourceEditorSnapshot = false;
    this._applyingSourceEditorSnapshot = false;
    this._applyingRuntimeCellData = false;
    this._sourceEditorSnapshotGeneration = 0;
    this._sourceEditorSyncScheduled = null;
    this._serializedSourceEditorState = deserializeState?.sourceEditorState || null;

    // Clipboard for cut/copy/paste
    this.cellClipboard = null;

    // Create a stable container element that ViewRegistry will cache.
    // We swap its contents between placeholder and view to work around
    // ViewRegistry's caching behavior (it caches getElement() result once).
    this._containerElement = window.document.createElement("div");
    this._containerElement.className = "jupyter-view jupyter-notebook-container";
    this._containerElement._jupyterNotebookEditor = this;

    if (notebookDocument) {
      // Normal construction with document
      this._initWithDocument(notebookDocument);
    } else if (deserializeState) {
      // Create placeholder and async load from serialized state
      this._createPlaceholder();
      this._loadFromState(deserializeState);
    }
  }

  _createPlaceholder() {
    this._chrome = showChrome(this._containerElement);
  }

  _showLoadError(message) {
    this._chrome = showChrome(this._containerElement, { error: message });
  }

  async _loadFromState(state) {
    // Guard against concurrent calls
    if (this._loadingPromise) {
      return this._loadingPromise;
    }

    this._loading = true;
    this._deserializeState = state;

    this._loadingPromise = (async () => {
      try {
        const { documentRegistry } = this._getDeserializeServices();

        let doc;
        if (state.filePath && state.notebookData && state.wasModified) {
          // Modified saved file - restore from serialized data with file path
          doc = await documentRegistry.getOrCreateDocumentFromData(
            state.filePath,
            state.notebookData,
            {
              modified: true,
            },
          );
          if (state.activeCellIndex !== undefined) {
            this.activeCellIndex = state.activeCellIndex;
          }
        } else if (state.filePath) {
          // Unmodified saved file - load from disk
          doc = await documentRegistry.getOrCreateDocument(state.filePath);
        } else if (state.notebookData) {
          // Unsaved notebook - restore from serialized data
          const NotebookDocumentClass = getNotebookDocument();
          doc = new NotebookDocumentClass(null);
          await doc.initializeFromData(state.notebookData);
          // Mark as modified since it's unsaved
          if (state.wasModified) {
            doc.setModified(true);
          }
          if (state.activeCellIndex !== undefined) {
            this.activeCellIndex = state.activeCellIndex;
          }
        }

        if (doc) {
          this._initWithDocument(doc);
          await this._sourceEditorSetupPromise;
        } else {
          // No document loaded - show error
          this._showLoadError("No document");
        }
      } catch (error) {
        this._loadError = error;
        console.error("[jupyter-view] Failed to load notebook:", error);
        this._showLoadError(error.message);
      } finally {
        this._loading = false;
        this._loadingPromise = null;
        // Notify that title has changed (was "Loading...", now is actual filename)
        this.emitter.emit("did-change-title");
      }
    })();

    return this._loadingPromise;
  }

  _getDeserializeServices() {
    const { documentRegistry } = this.deserializeServices || {};
    if (!documentRegistry) {
      throw new Error("Cannot restore notebook without document services");
    }
    return { documentRegistry };
  }

  _initWithDocument(notebookDocument) {
    this.document = notebookDocument;
    this.document.retain();

    // Create the view
    const NotebookViewClass = getNotebookView();
    this.view = new NotebookViewClass({
      editor: this,
      cells: this.document.cells,
      activeCellIndex: this.activeCellIndex,
    });

    // Replace container contents with the view element
    // This handles both initial load and deserialization (replaces placeholder)
    if (this._chrome) {
      this._chrome.destroy();
      this._chrome = null;
    }
    this._containerElement.innerHTML = "";
    this._containerElement.appendChild(this.view.element);
    lumine.packages.triggerActivationHook?.("jupyter.adapter:item-used");

    // Subscribe to document changes
    this.subscribeToDocument();

    // Register a backing editor so editor services can lint the notebook as .ipynb JSON.
    this._sourceEditorSetupPromise = this.setupSourceEditor();

    // Subscribe to pane item activation to redirect focus appropriately
    this.subscribeToActivation();

    // Emit initial modified status for tabs to pick up
    this.emitter.emit("did-change-modified", this.document.isModified());

    // Notify services (e.g. navigation-panel) that headers are now available
    this.emitter.emit("did-change");
    this.emitter.emit("did-change-navigation");

    // Apply pending state from copy() if any (cursor positions, mode, scroll)
    this._applyPendingStateSoon();
  }

  subscribeToDocument() {
    this.disposables.add(
      this.document.onDidChange(() => {
        this.updateView();
        if (!this._applyingRuntimeCellData) {
          this.updateSourceEditorFromNotebook("document-change");
        }
        this.emitter.emit("did-change");
        this.emitter.emit("did-change-navigation");
      }),

      this.document.onDidSave(() => {
        this.updateSourceEditorFromNotebook("save");
        this.emitter.emit("did-save", { path: this.document.filePath });
        // Re-emit modified=false explicitly so any other editor on the same
        // shared document (e.g. the notebook open in a second pane) updates
        // its tab dirty indicator.  The document's did-change-modified fires
        // before did-save, but a subsequent source-editor sync ripple may
        // run before Lumine's tab paints, and an idempotent emission here is
        // cheap insurance.
        this.emitter.emit("did-change-modified", this.document.isModified());
      }),

      this.document.onDidChangePath(() => {
        this.updateSourceEditorFromNotebook("path-change");
        this.emitter.emit("did-change-path", this.document.filePath);
        this.emitter.emit("did-change-title");
      }),

      this.document.onDidReload(() => {
        this.activeCellIndex = Math.max(
          0,
          Math.min(this.activeCellIndex, this.document.getCellCount() - 1),
        );
        this.updateView();
        this.updateSourceEditorFromNotebook("reload");
        this.emitter.emit("did-change-navigation");
      }),

      this.document.onDidInsertCell(({ index }) => {
        // Adjust active cell index if needed
        if (index <= this.activeCellIndex) {
          this.activeCellIndex++;
        }
        // Adjust selected cell indices in view
        this._adjustSelectionForInsert(index);
        this.updateView();
      }),

      this.document.onDidDeleteCell(({ index }) => {
        // Adjust active cell index if needed
        if (index < this.activeCellIndex) {
          this.activeCellIndex--;
        } else if (
          index === this.activeCellIndex &&
          this.activeCellIndex >= this.document.getCellCount()
        ) {
          this.activeCellIndex = Math.max(0, this.document.getCellCount() - 1);
        }
        // Adjust selected cell indices in view
        this._adjustSelectionForDelete(index);
        this.updateView();
      }),

      this.document.onDidMoveCell(({ fromIndex, toIndex }) => {
        // Adjust active cell index if it was moved
        if (this.activeCellIndex === fromIndex) {
          this.activeCellIndex = toIndex;
        } else if (fromIndex < this.activeCellIndex && toIndex >= this.activeCellIndex) {
          this.activeCellIndex--;
        } else if (fromIndex > this.activeCellIndex && toIndex <= this.activeCellIndex) {
          this.activeCellIndex++;
        }
        // Adjust selected cell indices in view
        this._adjustSelectionForMove(fromIndex, toIndex);
        this.updateView();
      }),

      this.document.onDidDestroy(() => {
        this.destroy();
      }),

      this.document.onDidChangeModified((modified) => {
        this.emitter.emit("did-change-modified", modified);
        // Exit pending state when notebook is modified
        if (modified) {
          this.terminatePendingState();
        }
      }),
    );
  }

  subscribeToActivation() {
    // When this pane item becomes active, restore focus without scrolling.
    // Focusing the notebook container is enough — the user's scroll position
    // is preserved and they can click or press Enter to resume editing.
    this.disposables.add(
      lumine.workspace.onDidChangeActivePaneItem((item) => {
        if (item === this && this.view) {
          requestAnimationFrame(() => {
            if (this.sourceEditor) {
              this.sourceEditor.jupyterNotebookEditor = this;
            }
            if (this.view._mouseButtonDown || this.view.element.contains(document.activeElement)) {
              return;
            }
            if (this.view.getMode?.() === "edit") {
              this.focusActiveCellEditor();
              return;
            }
            this.view.element.focus();
          });
        }
      }),
    );
  }

  updateView() {
    if (this.view) {
      this.view.update({
        editor: this,
        cells: this.document.cells,
        activeCellIndex: this.activeCellIndex,
      });
    }
  }

  async setupSourceEditor() {
    if (!this.document) return;
    if (this._sourceEditorSetupPromise) return this._sourceEditorSetupPromise;

    this._sourceEditorSetupPromise = this._setupSourceEditor();
    return this._sourceEditorSetupPromise;
  }

  async _setupSourceEditor() {
    if (!this.document._sourceEditor) {
      const { editor, restored } = await this.createSourceEditor(this._serializedSourceEditorState);
      editor.isJupyterNotebookSourceEditor = true;
      editor.jupyterNotebookEditor = this;
      this.document._sourceEditor = editor;
      this.document._sourceEditorRestoredFromSerializedState = restored;
      this.document._sourceEditorDisposable = new CompositeDisposable(
        new Disposable(() => editor.destroy()),
      );
      this.document.disposables.add(this.document._sourceEditorDisposable);
    }

    this.sourceEditor = this.document._sourceEditor;
    this.sourceEditor.jupyterNotebookEditor = this;
    if (this.document._sourceEditorRestoredFromSerializedState) {
      this.initializeRestoredSourceEditorSnapshot();
    } else {
      this.initializeSourceEditorSnapshot();
    }
    this.observeSourceEditorChanges();
    this.ensureSourceEditorGrammar();
    this.registerSourceEditorForServices();
    this.requestSourceEditorLint();
  }

  async createSourceEditor(serializedState = null) {
    const fallbackText = serializedState?.text;
    const fallbackPath = serializedState?.path;
    let restoredBuffer = null;
    let editor = null;
    let restored = false;

    if (serializedState?.bufferState && typeof TextBuffer?.deserialize === "function") {
      try {
        restoredBuffer = await TextBuffer.deserialize(serializedState.bufferState);
        restored = !!restoredBuffer;
      } catch (error) {
        console.warn("[jupyter-view] Could not deserialize source buffer:", error.message);
      }
    }

    if (restoredBuffer && serializedState?.editorState) {
      editor = lumine.workspace.buildTextEditor({
        ...serializedState.editorState,
        buffer: restoredBuffer,
        mini: false,
        lineNumberGutterVisible: false,
      });
    }

    if (!editor) {
      editor = lumine.workspace.buildTextEditor({
        mini: false,
        lineNumberGutterVisible: false,
      });
    }

    if (fallbackText != null && editor.getText?.() !== fallbackText) {
      editor.setText(fallbackText);
      restored = true;
    }

    const buffer = editor.getBuffer?.();
    if (fallbackPath && buffer?.getPath?.() !== fallbackPath) {
      buffer?.setPath?.(fallbackPath);
    }

    const grammar = serializedState?.grammarScopeName
      ? lumine.grammars.grammarForScopeName(serializedState.grammarScopeName)
      : null;
    if (grammar && editor.getGrammar?.()?.scopeName !== grammar.scopeName) {
      editor.setGrammar(grammar);
    }

    return { editor, restored };
  }

  triggerSourceEditorActivationHooks() {
    lumine.packages.triggerActivationHook?.("source.jupyter:root-scope-used");
    lumine.packages.triggerActivationHook?.("jupyter-view:grammar-used");
  }

  ensureSourceEditorGrammar() {
    if (!this.sourceEditor) return false;

    this.triggerSourceEditorActivationHooks();

    const grammar = lumine.grammars.grammarForScopeName("source.jupyter");
    if (grammar) {
      if (this.sourceEditor.getGrammar?.()?.scopeName !== grammar.scopeName) {
        this.sourceEditor.setGrammar(grammar);
      }
      this.clearSourceEditorGrammarRetry();
      return true;
    }

    this.scheduleSourceEditorGrammarRetry();
    return false;
  }

  scheduleSourceEditorGrammarRetry() {
    if (this._sourceEditorGrammarRetryDisposable) return;

    const retry = () => {
      if (!this.sourceEditor || this._destroyed) return;
      if (this.ensureSourceEditorGrammar()) {
        this.registerSourceEditorForServices();
        this.requestSourceEditorLint();
      }
    };

    const grammarDisposable = lumine.grammars.onDidAddGrammar(retry);
    const timeoutId = setTimeout(retry, 1000);
    this._sourceEditorGrammarRetryDisposable = new Disposable(() => {
      grammarDisposable.dispose();
      clearTimeout(timeoutId);
      this._sourceEditorGrammarRetryDisposable = null;
    });
    this.disposables.add(this._sourceEditorGrammarRetryDisposable);
  }

  clearSourceEditorGrammarRetry() {
    if (!this._sourceEditorGrammarRetryDisposable) return;
    const disposable = this._sourceEditorGrammarRetryDisposable;
    this._sourceEditorGrammarRetryDisposable = null;
    disposable.dispose();
  }

  registerSourceEditorForServices() {
    if (!this.document?._sourceEditor || this.document._sourceEditorRegistration) return;
    if (this.sourceEditor.getGrammar?.()?.scopeName !== "source.jupyter") return;

    // "background": the hidden JSON source backing the notebook — registered
    // so linting and config apply, but excluded from cross-editor features
    // like completion sourcing (its buffer holds metadata and base64 outputs).
    const registration = lumine.textEditors.add(this.sourceEditor, { role: "background" });
    this.document._sourceEditorRegistration = registration;
    this.document._sourceEditorDisposable.add(registration);
  }

  requestSourceEditorLint() {
    if (this._sourceEditorLintRequested) return;
    this._sourceEditorLintRequested = true;
    requestAnimationFrame(() => {
      this._sourceEditorLintRequested = false;
      if (this._destroyed || lumine.workspace.getCenter().getActivePaneItem() !== this) return;
      lumine.commands.dispatch(lumine.views.getView(lumine.workspace), "linter:lint");
    });
  }

  scheduleSourceEditorSync() {
    return this.scheduleSourceEditorSnapshot("legacy-sync");
  }

  scheduleSourceEditorSnapshot(reason = "sync") {
    if (this._sourceEditorSyncScheduled) return;
    const token = {};
    this._sourceEditorSyncScheduled = token;
    const generation = this._sourceEditorSnapshotGeneration;
    requestAnimationFrame(() => {
      if (this._sourceEditorSyncScheduled !== token) return;
      this._sourceEditorSyncScheduled = null;
      if (generation !== this._sourceEditorSnapshotGeneration) return;
      this.commitSourceEditorSnapshot(reason);
    });
  }

  syncSourceEditor() {
    return this.commitSourceEditorSnapshot("sync");
  }

  updateSourceEditorFromNotebook(reason = "document-change") {
    if (this._applyingSourceEditorSnapshot) return;
    if (this.document?._applyingSourceEditorSnapshot) return;
    this.scheduleSourceEditorSnapshot(reason);
  }

  initializeSourceEditorSnapshot() {
    if (!this.sourceEditor || !this.document) return;

    if (this.document._sourceEditorInitializedForHistory) {
      this._lastAppliedSourceEditorText = this.sourceEditor.getText();
      return;
    }

    this.commitSourceEditorSnapshot("initial", { force: true, preserveUndo: false });
    this.clearSourceEditorUndoStack();
    this.document._sourceEditorInitializedForHistory = true;
  }

  initializeRestoredSourceEditorSnapshot() {
    if (!this.sourceEditor || !this.document) return;

    this.document._sourceEditorInitializedForHistory = true;
    this.applySourceEditorSnapshot("deserialize-source-editor");
    this._lastAppliedSourceEditorText = this.sourceEditor.getText();
    this._serializedSourceEditorState = null;
  }

  clearSourceEditorUndoStack() {
    const buffer = this.sourceEditor?.getBuffer?.();
    this.sourceEditor?.clearUndoStack?.();
    buffer?.clearUndoStack?.();
  }

  observeSourceEditorChanges() {
    if (!this.sourceEditor || this._sourceEditorChangeSubscription) return;

    this._sourceEditorChangeSubscription = this.sourceEditor.onDidChange(() => {
      if (this._writingSourceEditorSnapshot) return;
      // When the source editor changes because of an undo/redo operation
      // (_historyDirection is set by performSourceEditorHistory), use the
      // matching reason so that applySourceEditorSnapshot restores UI state
      // (active cell, cursor positions).  Without this, the onDidChange fires
      // with reason "source-editor-change" (shouldRestoreUIState = false) and
      // the subsequent explicit applySourceEditorSnapshot call is a no-op
      // because _lastAppliedSourceEditorText already matches — meaning UI
      // state is never restored after undo/redo.
      const reason = this._historyDirection
        ? `source-editor-${this._historyDirection}`
        : "source-editor-change";
      this.applySourceEditorSnapshot(reason);
    });
    this.disposables.add(this._sourceEditorChangeSubscription);
  }

  commitSourceEditorSnapshot(reason = "sync", options = {}) {
    if (!this.sourceEditor || !this.document) return;
    if (this._applyingSourceEditorSnapshot) return;

    const buffer = this.sourceEditor.getBuffer();
    if (this.document.filePath && buffer.getPath() !== this.document.filePath) {
      buffer.setPath(this.document.filePath);
    }

    const text = JSON.stringify(this.getSourceEditorJSON({ includeHistoryState: true }), null, 2);
    if (options.skipIfNotebookUnchanged && !this.hasSourceEditorNotebookContentChanged()) {
      return;
    }
    if (!options.force && this.sourceEditor.getText() === text) {
      this._lastAppliedSourceEditorText = text;
      return;
    }

    this._writingSourceEditorSnapshot = true;
    const write = () => {
      if (typeof buffer.setTextViaDiff === "function") {
        buffer.setTextViaDiff(text);
      } else {
        this.sourceEditor.setText(text);
      }
      this._lastAppliedSourceEditorText = text;
    };
    try {
      if (options.preserveUndo === false) {
        write();
      } else if (typeof this.sourceEditor.transact === "function") {
        this.sourceEditor.transact(write);
      } else {
        write();
      }
    } finally {
      this._writingSourceEditorSnapshot = false;
    }

    this._sourceEditorSnapshotGeneration++;
    this._sourceEditorSyncScheduled = null;
    this.requestSourceEditorLint();
    return reason;
  }

  applySourceEditorSnapshot(reason = "source-editor-change") {
    if (!this.sourceEditor || !this.document || this._writingSourceEditorSnapshot) return;

    const text = this.sourceEditor.getText();
    if (this._lastAppliedSourceEditorText === text) return;

    const parsed = this.parseSourceEditorSnapshot(text);
    if (!parsed) return;

    const isSourceHistory = reason === "source-editor-undo" || reason === "source-editor-redo";
    const shouldRestoreUIState = isSourceHistory || reason === "deserialize-source-editor";
    const historyChange = isSourceHistory ? this.classifyHistoryChange(parsed.notebook) : null;
    const sourceCursorPlan = historyChange?.sourceOnly
      ? this.captureSourceHistoryCursorPlan(historyChange)
      : null;
    const shouldRestoreFullUIState =
      reason === "source-editor-undo" ||
      reason === "source-editor-redo" ||
      reason === "deserialize-source-editor";
    const shouldRestoreNotebookUIState =
      shouldRestoreFullUIState && (!historyChange || historyChange.structural);

    this._applyingSourceEditorSnapshot = true;
    this.document._applyingSourceEditorSnapshot = true;
    try {
      this.document._applyNotebookData(parsed.notebook, { preserveRuntimeOutputs: true });
      this.document.updateModifiedState();
      this.document.emitter.emit("did-change");
      this._lastAppliedSourceEditorText = text;
      this._sourceEditorSnapshotGeneration++;
      this._sourceEditorSyncScheduled = null;
      if (shouldRestoreNotebookUIState) {
        this.activeCellIndex = this.resolveHistoryActiveCellIndex(parsed.uiState);
      } else if (historyChange?.sourceOnly && historyChange.changedCellIds.length === 1) {
        const index = this._findCellIndex(historyChange.changedCellIds[0]);
        if (index !== -1) {
          this.activeCellIndex = index;
        }
      }
      this.updateView();
      if (shouldRestoreNotebookUIState) {
        this.restoreHistoryUIState(parsed.uiState, {
          restoreSelection: reason === "deserialize-source-editor",
        });
      } else if (shouldRestoreUIState) {
        const mode = this.restoreHistoryMode(parsed.uiState);
        this.view?.clearSelection?.();
        if (sourceCursorPlan) {
          this.restoreSourceHistoryCursors(sourceCursorPlan, mode);
        } else {
          this.focusHistoryMode(mode);
        }
      }
      this.emitter.emit("did-change");
      this.emitter.emit("did-change-navigation");
      this.emitter.emit("did-change-modified", this.document.isModified());
      this.requestSourceEditorLint();
    } finally {
      this.document._applyingSourceEditorSnapshot = false;
      this._applyingSourceEditorSnapshot = false;
    }
    return reason;
  }

  parseSourceEditorSnapshot(text) {
    try {
      const notebook = JSON.parse(text);
      const uiState = notebook.metadata?.[HISTORY_METADATA_KEY]?.[HISTORY_STATE_KEY] || null;
      notebook.metadata = this.stripHistoryMetadata(notebook.metadata || {});
      return { notebook, uiState };
    } catch (error) {
      console.warn("[jupyter-view] Could not apply source editor snapshot:", error.message);
      return null;
    }
  }

  classifyHistoryChange(notebook) {
    const beforeCells = this.getHistoryCellsFromDocument();
    const afterCells = this.getHistoryCellsFromNotebook(notebook);
    let structural = beforeCells.length !== afterCells.length;
    const changedCellIds = [];

    const length = Math.min(beforeCells.length, afterCells.length);
    for (let i = 0; i < length; i++) {
      const before = beforeCells[i];
      const after = afterCells[i];
      if (before.id !== after.id || before.type !== after.type) {
        structural = true;
        continue;
      }
      if (before.source !== after.source) {
        changedCellIds.push(after.id);
      }
    }

    return {
      beforeCells,
      afterCells,
      structural,
      changedCellIds,
      sourceOnly: !structural && changedCellIds.length > 0,
    };
  }

  getHistoryCellsFromDocument() {
    return (this.document?.cells || []).map((cell) => ({
      id: cell.id,
      type: cell.type,
      source: cell.source || "",
    }));
  }

  getHistoryCellsFromNotebook(notebook) {
    return (notebook?.cells || []).map((cell) => ({
      id: cell.id,
      type: cell.cell_type,
      source: this.getNotebookCellSource(cell),
    }));
  }

  getNotebookCellSource(cell) {
    if (Array.isArray(cell?.source)) return cell.source.join("");
    if (typeof cell?.source === "string") return cell.source;
    return "";
  }

  captureSourceHistoryCursorPlan(historyChange) {
    const cursors = [];

    for (let i = 0; i < historyChange.afterCells.length; i++) {
      const before = historyChange.beforeCells[i];
      const after = historyChange.afterCells[i];
      if (!historyChange.changedCellIds.includes(after.id)) continue;

      const cellView = this.view?.cellViews?.get(after.id);
      const editor = cellView?.editor;
      if (!editor) continue;

      const ranges = editor.getSelectedBufferRanges?.() || [];
      cursors.push({
        cellId: after.id,
        beforeSource: before.source,
        afterSource: after.source,
        ranges: ranges.map((range) => [
          [range.start.row, range.start.column],
          [range.end.row, range.end.column],
        ]),
      });
    }

    return cursors.length > 0 ? cursors : null;
  }

  restoreSourceHistoryCursors(cursorPlan, mode = this.view?.getMode?.()) {
    requestAnimationFrame(() => {
      for (const entry of cursorPlan) {
        const cellView = this.view?.cellViews?.get(entry.cellId);
        const editor = cellView?.editor;
        if (!editor) continue;

        const ranges = entry.ranges.map((range) => [
          this.transformHistoryPoint(entry.beforeSource, entry.afterSource, range[0]),
          this.transformHistoryPoint(entry.beforeSource, entry.afterSource, range[1]),
        ]);

        try {
          if (ranges.length > 0) {
            editor.setSelectedBufferRanges(ranges);
          }
        } catch (error) {
          console.warn("[jupyter-view] Could not restore source history cursor:", error.message);
        }
      }

      this.focusHistoryMode(mode);
    });
  }

  restoreHistoryMode(uiState) {
    const mode = uiState?.mode === "edit" ? "edit" : "command";
    this.view?.setMode?.(mode);
    return mode;
  }

  focusHistoryMode(mode) {
    requestAnimationFrame(() => {
      if (mode === "edit") {
        this.focusActiveCellEditor();
      } else {
        this.view?.element?.focus?.();
      }
    });
  }

  transformHistoryPoint(beforeSource, afterSource, point) {
    const offset = this.pointToOffset(beforeSource, point);
    const transformed = this.transformHistoryOffset(beforeSource, afterSource, offset);
    return this.offsetToPoint(afterSource, transformed);
  }

  transformHistoryOffset(beforeSource, afterSource, offset) {
    let start = 0;
    const beforeLength = beforeSource.length;
    const afterLength = afterSource.length;

    while (
      start < beforeLength &&
      start < afterLength &&
      beforeSource[start] === afterSource[start]
    ) {
      start++;
    }

    let beforeEnd = beforeLength;
    let afterEnd = afterLength;
    while (
      beforeEnd > start &&
      afterEnd > start &&
      beforeSource[beforeEnd - 1] === afterSource[afterEnd - 1]
    ) {
      beforeEnd--;
      afterEnd--;
    }

    if (offset < start) return offset;
    if (offset <= beforeEnd) return afterEnd;
    return Math.max(0, Math.min(afterLength, offset + afterEnd - beforeEnd));
  }

  pointToOffset(text, point) {
    const row = Array.isArray(point) ? point[0] : point?.row || 0;
    const column = Array.isArray(point) ? point[1] : point?.column || 0;
    const lines = text.split("\n");
    let offset = 0;
    for (let i = 0; i < Math.min(row, lines.length - 1); i++) {
      offset += lines[i].length + 1;
    }
    return Math.min(text.length, offset + column);
  }

  offsetToPoint(text, offset) {
    const safeOffset = Math.max(0, Math.min(text.length, offset));
    const before = text.slice(0, safeOffset);
    const lines = before.split("\n");
    return [lines.length - 1, lines[lines.length - 1].length];
  }

  hasSourceEditorNotebookContentChanged() {
    if (!this.sourceEditor || !this.document) return false;

    const parsed = this.parseSourceEditorSnapshot(this.sourceEditor.getText());
    if (!parsed) return true;

    const currentNotebook = this.getSourceEditorJSON({ includeHistoryState: false });

    const parsedComparable = {
      nbformat: parsed.notebook.nbformat,
      nbformat_minor: parsed.notebook.nbformat_minor,
      metadata: this.stripHistoryMetadata(parsed.notebook.metadata || {}),
      cells: parsed.notebook.cells || [],
    };
    const currentComparable = {
      nbformat: currentNotebook.nbformat,
      nbformat_minor: currentNotebook.nbformat_minor,
      metadata: this.stripHistoryMetadata(currentNotebook.metadata || {}),
      cells: currentNotebook.cells,
    };

    return JSON.stringify(parsedComparable) !== JSON.stringify(currentComparable);
  }

  stripHistoryMetadata(metadata) {
    const clean = { ...(metadata || {}) };
    const pluginMetadata = clean[HISTORY_METADATA_KEY];
    if (!pluginMetadata || typeof pluginMetadata !== "object") {
      return clean;
    }

    const cleanPluginMetadata = { ...pluginMetadata };
    delete cleanPluginMetadata[HISTORY_STATE_KEY];

    if (Object.keys(cleanPluginMetadata).length === 0) {
      delete clean[HISTORY_METADATA_KEY];
    } else {
      clean[HISTORY_METADATA_KEY] = cleanPluginMetadata;
    }

    return clean;
  }

  getSourceEditorJSON(options = {}) {
    const metadata = this.stripHistoryMetadata(this.document.metadata || {});
    if (options.includeHistoryState) {
      metadata[HISTORY_METADATA_KEY] = {
        ...(metadata[HISTORY_METADATA_KEY] || {}),
        [HISTORY_STATE_KEY]: this.captureHistoryUIState(),
      };
    }

    return {
      nbformat: this.document.nbformat,
      nbformat_minor: this.document.nbformat_minor,
      metadata,
      cells: this.document.cells.map((cell) => {
        const source = cell.source || "";
        const data = {
          id: cell.id,
          cell_type: cell.type,
          metadata: cell.metadata || {},
          source: source
            .split("\n")
            .map((line, i, arr) => (i < arr.length - 1 ? line + "\n" : line))
            .filter((line) => line !== ""),
        };

        if (cell.type === "code") {
          // Outputs and execution_count are runtime state and deliberately
          // excluded from the source-editor snapshot.  Keeping them out of the
          // TextBuffer avoids stringifying megabytes of base64 image data on
          // every notebook mutation, keeps the undo stack small, and prevents
          // undo/redo from "restoring" stale outputs.  Live outputs live only
          // on cell models and are preserved across source-editor syncs by
          // _applyNotebookData when called with preserveRuntimeOutputs.
          data.execution_count = null;
          data.outputs = [];
        }

        return data;
      }),
    };
  }

  updateRuntimeCellData(callback) {
    if (!this.document || typeof callback !== "function") return;

    this._applyingRuntimeCellData = true;
    try {
      return callback();
    } finally {
      this._applyingRuntimeCellData = false;
    }
  }

  captureHistoryUIState() {
    const cells = this.document?.cells || [];
    const activeCell = cells[this.activeCellIndex] || null;
    const selectedCellIndexes = this.view?.getSelectedCells?.() || [];
    const cursorByCellId = {};

    for (const cell of cells) {
      const cellView = this.view?.cellViews?.get(cell.id);
      const editor = cellView?.editor;
      if (!editor) continue;

      const position = editor.getCursorBufferPosition?.();
      const selections = editor.getSelectedBufferRanges?.() || [];
      cursorByCellId[cell.id] = {
        position: position ? [position.row, position.column] : [0, 0],
        selections: selections.map((range) => [
          [range.start.row, range.start.column],
          [range.end.row, range.end.column],
        ]),
      };
    }

    return {
      activeCellIndex: this.activeCellIndex,
      activeCellId: activeCell?.id || null,
      selectedCellIndexes,
      selectedCellIds: selectedCellIndexes.map((index) => cells[index]?.id).filter(Boolean),
      mode: this.view?.getMode?.() || "command",
      cursorByCellId,
    };
  }

  resolveHistoryActiveCellIndex(uiState) {
    const cells = this.document?.cells || [];
    if (uiState?.activeCellId) {
      const index = cells.findIndex((cell) => cell.id === uiState.activeCellId);
      if (index !== -1) return index;
    }

    const fallback = uiState?.activeCellIndex ?? this.activeCellIndex;
    return Math.max(0, Math.min(fallback, Math.max(0, cells.length - 1)));
  }

  restoreHistoryUIState(uiState, options = {}) {
    if (!uiState || !this.view) return;

    requestAnimationFrame(() => {
      if (!this.view || !this.document) return;

      if (options.restoreSelection) {
        const cells = this.document.cells || [];
        const selected = new Set();
        for (const cellId of uiState.selectedCellIds || []) {
          const index = cells.findIndex((cell) => cell.id === cellId);
          if (index !== -1) selected.add(index);
        }
        for (const index of uiState.selectedCellIndexes || []) {
          if (index >= 0 && index < cells.length) selected.add(index);
        }

        this.view.selectedCells = selected;
        this.view.updateCellSelectionClasses?.();
      } else {
        this.view.clearSelection?.();
      }

      const mode = uiState.mode === "edit" ? "edit" : "command";
      this.view.setMode?.(mode);

      requestAnimationFrame(() => {
        this.restoreHistoryCursors(uiState);
        if (mode === "edit") {
          this.focusActiveCellEditor();
        } else {
          this.view?.element?.focus?.();
        }
      });
    });
  }

  restoreHistoryCursors(uiState) {
    const cursorByCellId = uiState?.cursorByCellId || {};
    for (const [cellId, cursorState] of Object.entries(cursorByCellId)) {
      const cellView = this.view?.cellViews?.get(cellId);
      const editor = cellView?.editor;
      if (!editor) continue;

      try {
        if (Array.isArray(cursorState.selections) && cursorState.selections.length > 0) {
          editor.setSelectedBufferRanges(cursorState.selections);
        } else if (Array.isArray(cursorState.position)) {
          editor.setCursorBufferPosition(cursorState.position, { autoscroll: false });
        }
      } catch (error) {
        console.warn("[jupyter-view] Could not restore source history cursor:", error.message);
      }
    }
  }

  getCellEditor(cellNumber) {
    const index = cellNumber - 1;
    const cell = this.document?.cells?.[index];
    if (!cell || cell.type !== "code") {
      return null;
    }

    const cellView = this.view?.cellViews?.get(cell.id);
    return cellView?.editor || null;
  }

  getSourceEditor() {
    return this.sourceEditor || null;
  }

  getLinterMessageCellIndexByBuffer(message) {
    const messageBuffer = message?.location?.buffer;
    if (!messageBuffer || !this.document || !this.view) return -1;

    for (let i = 0; i < this.document.cells.length; i++) {
      const cell = this.document.cells[i];
      const cellView = this.view.cellViews.get(cell.id);
      if (cellView?.editor?.getBuffer?.() === messageBuffer) {
        return i;
      }
    }
    return -1;
  }

  getLinterMessageCellIndex(message) {
    if (message?.location?.cell != null) {
      return message.location.cell - 1;
    }

    return this.getLinterMessageCellIndexByBuffer(message);
  }

  ownsLinterMessage(message) {
    const location = message?.location;
    if (!location) return false;

    const sourceBuffer = this.sourceEditor?.getBuffer?.();
    if (sourceBuffer && location.buffer === sourceBuffer) return true;

    if (this.getLinterMessageCellIndexByBuffer(message) >= 0) return true;

    const notebookPath = this.getPath();
    return Boolean(notebookPath && location.file === notebookPath);
  }

  getLinterMessageEditor(message) {
    const index = this.getLinterMessageCellIndex(message);
    if (index < 0) return null;
    return this.getCellEditor(index + 1);
  }

  getLinterMessageSortKey(message) {
    const position = message?.location?.position?.start || { row: 0, column: 0 };
    return {
      cellIndex: this.getLinterMessageCellIndex(message),
      row: position.row || 0,
      column: position.column || 0,
    };
  }

  compareLinterMessages(a, b) {
    const keyA = this.getLinterMessageSortKey(a);
    const keyB = this.getLinterMessageSortKey(b);
    if (keyA.cellIndex !== keyB.cellIndex) return keyA.cellIndex - keyB.cellIndex;
    if (keyA.row !== keyB.row) return keyA.row - keyB.row;
    return keyA.column - keyB.column;
  }

  getCurrentLinterMessage(messages) {
    const editor = this.getCellEditor(this.activeCellIndex + 1);
    if (!editor) return;

    const cursor = editor.getCursorBufferPosition();
    return messages.find((message) => {
      if (this.getLinterMessageCellIndex(message) !== this.activeCellIndex) return false;
      return message.location.position.containsPoint(cursor);
    });
  }

  getNextLinterMessage(messages) {
    if (!messages.length) return;

    const editor = this.getCellEditor(this.activeCellIndex + 1);
    const cursor = editor?.getCursorBufferPosition?.() || { row: 0, column: 0 };
    const sorted = messages.slice().sort((a, b) => this.compareLinterMessages(a, b));

    for (const message of sorted) {
      const key = this.getLinterMessageSortKey(message);
      if (
        key.cellIndex > this.activeCellIndex ||
        (key.cellIndex === this.activeCellIndex &&
          (key.row > cursor.row || (key.row === cursor.row && key.column > cursor.column)))
      ) {
        return message;
      }
    }

    return sorted[0];
  }

  getPreviousLinterMessage(messages) {
    if (!messages.length) return;

    const editor = this.getCellEditor(this.activeCellIndex + 1);
    const cursor = editor?.getCursorBufferPosition?.() || { row: 0, column: 0 };
    const sorted = messages.slice().sort((a, b) => this.compareLinterMessages(a, b));

    for (let i = sorted.length - 1; i >= 0; i--) {
      const message = sorted[i];
      const key = this.getLinterMessageSortKey(message);
      if (
        key.cellIndex < this.activeCellIndex ||
        (key.cellIndex === this.activeCellIndex &&
          (key.row < cursor.row || (key.row === cursor.row && key.column < cursor.column)))
      ) {
        return message;
      }
    }

    return sorted[sorted.length - 1];
  }

  revealLinterMessage(message) {
    const index = this.getLinterMessageCellIndex(message);
    if (index < 0) return;

    const pane =
      lumine.workspace.getCenter().paneForItem(this) || lumine.workspace.paneForItem(this);
    if (pane) {
      pane.activateItem(this);
      pane.activate();
    }

    this.setActiveCell(index);

    requestAnimationFrame(() => {
      if (!this.view) return;
      this.view.scrollToCell(index);
      this.view.enterEditMode();

      requestAnimationFrame(() => {
        const editor = this.getLinterMessageEditor(message);
        if (!editor) return;

        editor.setCursorBufferPosition(message.location.position.start, {
          autoscroll: false,
        });
        this.view.scrollToCursor(index, editor);

        const workspaceElement = lumine.views.getView(lumine.workspace);
        workspaceElement?.focus?.();

        const editorElement = lumine.views.getView(editor);
        editorElement.focus({ preventScroll: true });
      });
    });
  }

  getNavigationHeaders() {
    if (!this.document) return [];
    const headings = [];
    const visibleCellIndexes = this.getVisibleNavigationCellIndexes();
    const regex = /^(#{1,6})\s+(.+)$/gm;
    this.document.cells.forEach((cell, index) => {
      if (cell.type !== "markdown") return;
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(cell.source)) !== null) {
        const cellRow = cell.source.slice(0, match.index).split("\n").length - 1;
        headings.push({
          text: match[2].trim(),
          level: match[1].length,
          classList: [],
          cellIndex: index,
          cellRow,
        });
      }
    });
    return buildNavigationTree(headings, this.activeCellIndex, visibleCellIndexes);
  }

  revealNavigationHeader(header) {
    const mode = this.view?.getMode();
    const pane = lumine.workspace.getCenter().paneForItem(this);
    if (pane) {
      pane.activateItem(this);
      pane.activate();
    }
    if (mode !== "edit") {
      this.view?.clearSelection();
    }
    this.setActiveCell(header.cellIndex);
    requestAnimationFrame(() => {
      if (!this.view) return;
      this.updateView();
      this.view.scrollToCell(header.cellIndex);
      if (mode !== "edit") return;

      this.view.enterEditMode();
      const cell = this.document?.cells?.[header.cellIndex];
      if (cell) {
        const cellView = this.view?.cellViews?.get(cell.id);
        if (cellView?.editor) {
          cellView.editor.setCursorBufferPosition([header.cellRow ?? 0, 0]);
          lumine.views.getView(cellView.editor)?.focus();
        }
      }
    });
  }

  onNavigationChange(callback) {
    return this.emitter.on("did-change-navigation", callback);
  }

  observeNavigationHeaders(callback) {
    let disposed = false;
    let frame = null;
    let scrollDispose = null;
    let previousKey = null;
    let pendingInstant = false;

    const emit = (options) => {
      pendingInstant = pendingInstant || Boolean(options?.instant);
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!disposed) {
          const headers = this.getNavigationHeaders();
          const visibleCellIndexes = this.getVisibleNavigationCellIndexes();
          const key = `${this.activeCellIndex}:${visibleCellIndexes.join(",")}`;
          if (pendingInstant || key !== previousKey) {
            previousKey = key;
            callback(headers, pendingInstant ? { instant: true } : options);
          }
        }
        pendingInstant = false;
      });
    };

    const attachScrollListener = () => {
      if (scrollDispose || !this.view?.onDidScroll) return;
      scrollDispose = this.view.onDidScroll(() => emit());
    };

    attachScrollListener();
    emit({ instant: true });

    const changeDispose = this.onNavigationChange(() => {
      attachScrollListener();
      emit({ instant: true });
    });

    return new Disposable(() => {
      disposed = true;
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      scrollDispose?.dispose();
      changeDispose.dispose();
    });
  }

  getVisibleNavigationCellIndexes() {
    const container = this.view?.cellsContainer;
    if (!container || !this.document) return [];

    const containerRect = container.getBoundingClientRect();
    const visibleCellIndexes = new Set();

    this.document.cells.forEach((cell, index) => {
      const cellView = this.view?.cellViews?.get(cell.id);
      const element = cellView?.element;
      if (!element) return;

      const rect = element.getBoundingClientRect();
      if (rect.bottom >= containerRect.top && rect.top <= containerRect.bottom) {
        visibleCellIndexes.add(index);
      }
    });

    return Array.from(visibleCellIndexes).sort((a, b) => a - b);
  }

  // Create a copy of this editor (for split panes)
  // Used by Lumine's pane:split-* and pane:copy-* commands
  copy() {
    const copy = new JupyterNotebookEditor(this.document);

    // Preserve the active cell index
    copy.activeCellIndex = this.activeCellIndex;
    copy.updateView();

    // Preserve cursor positions from each cell's editor
    if (this.view && this.view.cellViews) {
      const cursorPositions = new Map();
      for (const [cellId, cellView] of this.view.cellViews) {
        if (cellView.editor) {
          const position = cellView.editor.getCursorBufferPosition();
          const selections = cellView.editor.getSelectedBufferRanges();
          cursorPositions.set(cellId, { position, selections });
        }
      }

      // Store for restoration after view is created
      copy._pendingCursorPositions = cursorPositions;
    }

    // Preserve the mode (command/edit)
    if (this.view) {
      copy._pendingMode = this.view.getMode();
    }

    // Preserve scroll position
    if (this.view && this.view.cellsContainer) {
      copy._pendingScrollTop = this.view.cellsContainer.scrollTop;
    }

    copy._applyPendingStateSoon();

    return copy;
  }

  _applyPendingStateSoon() {
    if (
      !this._pendingCursorPositions &&
      !this._pendingMode &&
      this._pendingScrollTop === undefined
    ) {
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this._applyPendingState();
      });
    });
  }

  /**
   * Apply pending state from copy() after view is ready
   * Called after the view is created and cells are rendered
   */
  _applyPendingState() {
    if (!this.view) return;

    // First restore scroll position so cell is visible
    if (this._pendingScrollTop !== undefined && this.view.cellsContainer) {
      this.view.cellsContainer.scrollTop = this._pendingScrollTop;
      this._pendingScrollTop = undefined;
    } else {
      // Ensure active cell is visible
      this.view.scrollToCell(this.activeCellIndex);
    }

    // Get the active cell to restore its cursor position
    const cells = this.document.cells;
    if (cells && cells[this.activeCellIndex] && this._pendingCursorPositions) {
      const activeCell = cells[this.activeCellIndex];
      const activeCellView = this.view.cellViews.get(activeCell.id);
      const cursorState = this._pendingCursorPositions.get(activeCell.id);

      if (activeCellView && activeCellView.editor && cursorState) {
        try {
          // Validate position is within buffer range before setting
          const buffer = activeCellView.editor.getBuffer();
          if (buffer && buffer.getLineCount() > 0) {
            const lastRow = buffer.getLastRow();
            const position = cursorState.position;
            // Clamp position to valid range
            const validRow = Math.min(position.row, lastRow);
            const validColumn = Math.min(position.column, buffer.lineLengthForRow(validRow) || 0);
            activeCellView.editor.setCursorBufferPosition([validRow, validColumn]);

            if (cursorState.selections && cursorState.selections.length > 0) {
              // Filter selections to valid ranges
              const validSelections = cursorState.selections.filter((range) => {
                return range.start.row <= lastRow && range.end.row <= lastRow;
              });
              if (validSelections.length > 0) {
                activeCellView.editor.setSelectedBufferRanges(validSelections);
              }
            }
          }
        } catch (e) {
          // Ignore cursor restoration errors - not critical
          console.warn("[jupyter-view] Could not restore cursor position:", e.message);
        }
      }
      this._pendingCursorPositions = null;
    }

    // Restore mode and focus the active cell appropriately
    if (this._pendingMode) {
      if (this._pendingMode === "edit") {
        this.view.setMode("edit");
      } else {
        this.view.enterCommandMode();
      }
      this._pendingMode = null;
    }
  }

  // Lumine pane item interface
  getTitle() {
    if (this.document && this.document.filePath) {
      return path.basename(this.document.filePath);
    }
    return "Untitled.ipynb";
  }

  getLongTitle() {
    return (this.document && this.document.filePath) || "Untitled.ipynb";
  }

  getPath() {
    if (this.document) {
      return this.document.filePath;
    }
    // For loading editors, return path from deserialize state
    if (this._deserializeState) {
      return this._deserializeState.filePath;
    }
    return null;
  }

  getURI() {
    return this.getPath();
  }

  getElement() {
    // Always return the stable container element.
    // ViewRegistry caches this on first call and never asks again.
    // We manage the container's contents internally (placeholder -> view).
    return this._containerElement;
  }

  isModified() {
    return this.document ? this.document.isModified() : false;
  }

  // Called by Lumine to determine if it should prompt to save before closing
  // Options may contain windowCloseRequested: true when closing the whole window
  shouldPromptToSave(options = {}) {
    // Don't prompt when closing Lumine - content is serialized and restored
    if (options.windowCloseRequested) {
      return false;
    }
    // Don't prompt if not modified
    if (!this.isModified()) {
      return false;
    }
    // Don't prompt if other views of this notebook exist in the workspace
    // (the document will remain open in those views)
    if (this.document && this.document.refCount > 1) {
      return false;
    }
    return true;
  }

  // Exit pending state when the notebook is modified
  terminatePendingState() {
    // This is called by Lumine's pane when we want to make the tab permanent
    // (e.g., when user makes changes to a pending/preview tab)
    this.emitter.emit("did-terminate-pending-state");
  }

  onDidTerminatePendingState(callback) {
    return this.emitter.on("did-terminate-pending-state", callback);
  }

  isPermanentDockItem() {
    return false;
  }

  getDefaultLocation() {
    return "center";
  }

  getAllowedLocations() {
    return ["center"];
  }

  serialize() {
    // Don't serialize if still loading or no document
    if (!this.document) {
      return null;
    }
    this.flushPendingCellSourceChanges();
    this.commitSourceEditorSnapshot("serialize", { skipIfNotebookUnchanged: true });
    const sourceEditorState = this.serializeSourceEditorState();

    if (this.document.filePath) {
      // Saved notebook - store path and modified state
      // If modified, also store the current content so changes aren't lost
      if (this.document.isModified()) {
        return this.withSerializedSourceEditor(
          {
            deserializer: "JupyterNotebookEditor",
            filePath: this.document.filePath,
            notebookData: this.document.toJSON(),
            activeCellIndex: this.activeCellIndex,
            wasModified: true,
          },
          sourceEditorState,
        );
      } else {
        return this.withSerializedSourceEditor(
          {
            deserializer: "JupyterNotebookEditor",
            filePath: this.document.filePath,
          },
          sourceEditorState,
        );
      }
    } else {
      // Unsaved notebook - store full content (always modified)
      return this.withSerializedSourceEditor(
        {
          deserializer: "JupyterNotebookEditor",
          notebookData: this.document.toJSON(),
          activeCellIndex: this.activeCellIndex,
          wasModified: true,
        },
        sourceEditorState,
      );
    }
  }

  withSerializedSourceEditor(state, sourceEditorState) {
    if (sourceEditorState) {
      state.sourceEditorState = sourceEditorState;
    }
    return state;
  }

  serializeSourceEditorState() {
    if (!this.sourceEditor) return null;

    const buffer = this.sourceEditor.getBuffer?.();
    const state = {
      text: this.sourceEditor.getText?.() || "",
      path: buffer?.getPath?.() || this.document?.filePath || null,
    };

    const grammarScopeName = this.sourceEditor.getGrammar?.()?.scopeName;
    if (grammarScopeName) {
      state.grammarScopeName = grammarScopeName;
    }

    if (typeof buffer?.serialize === "function") {
      try {
        state.bufferState = buffer.serialize({ history: true, markerLayers: true });
        state.bufferState.text = state.text;
        delete state.bufferState.filePath;
        delete state.bufferState.digestWhenLastPersisted;
        delete state.bufferState.outstandingChanges;
      } catch (error) {
        console.warn("[jupyter-view] Could not serialize source buffer:", error.message);
      }
    }

    if (typeof this.sourceEditor.serialize === "function") {
      try {
        state.editorState = this.sourceEditor.serialize();
      } catch (error) {
        console.warn("[jupyter-view] Could not serialize source editor:", error.message);
      }
    }

    return state;
  }

  // Delegate save to document
  async save() {
    if (!this.document) return false;
    this.flushPendingCellSourceChanges();
    this.commitSourceEditorSnapshot("before-save", { skipIfNotebookUnchanged: true });
    if (!this.document.filePath) {
      // Use Lumine's pane to show save dialog properly
      const pane = lumine.workspace.paneForItem(this);
      if (pane) {
        return pane.saveItemAs(this);
      }
      return false;
    }
    return this.document.save();
  }

  // Called by Lumine's Pane with the selected path from save dialog
  async saveAs(newPath) {
    if (!this.document) return false;
    this.flushPendingCellSourceChanges();
    this.commitSourceEditorSnapshot("before-save-as", { skipIfNotebookUnchanged: true });
    // Handle both string path and object { canceled, filePath } from Electron dialog
    const filePath = typeof newPath === "string" ? newPath : newPath?.filePath;
    if (filePath) {
      this.document.setPath(filePath);
      return this.document.save();
    }
    return false;
  }

  // Lumine pane item interface - provides options for save dialog
  getSaveDialogOptions() {
    let defaultPath = this.document?.filePath;
    if (!defaultPath) {
      const projectPath = lumine.project.getPaths()[0];
      defaultPath = projectPath ? path.join(projectPath, "Untitled.ipynb") : "Untitled.ipynb";
    }
    return {
      defaultPath,
      filters: [{ name: "Jupyter Notebook", extensions: ["ipynb"] }],
    };
  }

  // Cell operations
  getActiveCell() {
    if (!this.document) return null;
    return this.document.getCell(this.activeCellIndex);
  }

  setActiveCell(index) {
    if (!this.document) return;
    if (index >= 0 && index < this.document.getCellCount()) {
      this.activeCellIndex = index;
      this.updateView();
      this.emitter.emit("did-change-navigation");
    }
  }

  focusActiveCell() {
    if (this.view) {
      this.view.enterEditMode();
    }
  }

  focusActiveCellEditor() {
    if (this.view) {
      this.view.focusActiveCellEditor();
    }
  }

  prepareForNotebookOperation() {
    if (this._applyingSourceEditorSnapshot) return;
    this.flushPendingCellSourceChanges();
    this.commitSourceEditorSnapshot("before-notebook-operation");
  }

  deleteCellAt(index) {
    if (!this.document) return;
    this.prepareForNotebookOperation();
    const cell = this.document.getCell(index);
    if (!cell) return;

    // Adjust active index so the same active cell stays active after deletion
    if (index < this.activeCellIndex) {
      this.activeCellIndex -= 1;
    } else if (index === this.activeCellIndex) {
      const newCount = this.document.getCellCount() - 1;
      this.activeCellIndex = Math.max(0, Math.min(this.activeCellIndex, newCount - 1));
    }

    this.document.deleteCell(index);
  }

  clearOutput() {
    if (!this.document) return;
    this.prepareForNotebookOperation();
    this.document.clearCellOutput(this.activeCellIndex);
  }

  clearOutputAt(index) {
    if (!this.document) return;
    this.prepareForNotebookOperation();
    this.document.clearCellOutput(index);
  }

  clearAllOutputs() {
    if (!this.document) return;
    this.prepareForNotebookOperation();
    this.document.clearAllOutputs();
  }

  /**
   * Insert a new cell at the specified position
   * @param {string} position - 'above' or 'below'
   * @param {boolean} extendSelection - Whether to extend selection to include the new cell
   */
  _insertCell(position = "below", extendSelection = false) {
    if (!this.document) return;
    this.prepareForNotebookOperation();

    const isAbove = position === "above";
    const previousIndex = this.activeCellIndex;
    const insertIndex = isAbove ? this.activeCellIndex : this.activeCellIndex + 1;

    // Clear selection unless extending
    if (this.view && !extendSelection) {
      this.view.clearSelection();
    }

    this.document.insertCell(insertIndex, "code");

    // Update active cell index
    if (isAbove) {
      // Stay on the newly inserted cell
      this.activeCellIndex = insertIndex;
    } else {
      // Move to the newly inserted cell below
      this.activeCellIndex++;
    }

    this.updateView();

    // Extend selection if requested
    if (extendSelection && this.view) {
      if (isAbove) {
        this.view.extendSelection(insertIndex);
        this.view.extendSelection(previousIndex + 1);
      } else {
        this.view.extendSelection(previousIndex);
        this.view.extendSelection(insertIndex);
      }
    }
  }

  insertCellAbove() {
    this._insertCell("above", false);
  }
  insertCellBelow() {
    this._insertCell("below", false);
  }
  insertCellBelowAndEdit() {
    this._insertCell("below", false);
    if (this.view) {
      this.view.enterEditMode();
      this.focusActiveCellEditor();
    }
  }
  insertCellAboveAndExtendSelection() {
    this._insertCell("above", true);
  }
  insertCellBelowAndExtendSelection() {
    this._insertCell("below", true);
  }

  deleteCell() {
    if (!this.document) return;
    this.prepareForNotebookOperation();

    // Check if there are selected cells in the view
    const selectedIndices = this.view ? this.view.getSelectedCells() : [];

    // Clear selection before any delete operation
    if (this.view) {
      this.view.clearSelection();
    }

    if (selectedIndices.length > 1) {
      this.document.deleteCells(selectedIndices);
      // Adjust active cell index
      const minDeleted = Math.min(...selectedIndices);
      this.activeCellIndex = Math.min(minDeleted, this.document.getCellCount() - 1);
      this.activeCellIndex = Math.max(0, this.activeCellIndex);
      this.updateView();
    } else {
      this.document.deleteCell(this.activeCellIndex);
    }
  }

  moveCellUp() {
    if (!this.document) return;
    this.prepareForNotebookOperation();

    const selectedIndices = this.view ? this.view.getSelectedCells() : [];

    if (selectedIndices.length > 1) {
      // Move multiple selected cells up
      const sortedIndices = [...selectedIndices].sort((a, b) => a - b);
      const minIndex = sortedIndices[0];

      // Can't move up if first selected cell is already at top
      if (minIndex === 0) return;

      const targetIndex = minIndex - 1;

      this.document.moveCells(sortedIndices, targetIndex);

      // Update selection to new positions
      const newIndices = sortedIndices.map((i) => i - 1);
      this.view.clearSelection();
      newIndices.forEach((i) => this.view.extendSelection(i));
      this.activeCellIndex = this.activeCellIndex - 1;
      this.updateView();
    } else {
      // Move single active cell up
      if (this.activeCellIndex > 0) {
        this.document.moveCell(this.activeCellIndex, this.activeCellIndex - 1);
      }
    }
  }

  moveCellDown() {
    if (!this.document) return;
    this.prepareForNotebookOperation();

    const selectedIndices = this.view ? this.view.getSelectedCells() : [];

    if (selectedIndices.length > 1) {
      // Move multiple selected cells down
      const sortedIndices = [...selectedIndices].sort((a, b) => a - b);
      const maxIndex = sortedIndices[sortedIndices.length - 1];

      // Can't move down if last selected cell is already at bottom
      if (maxIndex >= this.document.getCellCount() - 1) return;

      // Target is after the last selected cell + 1 (the cell below)
      const targetIndex = maxIndex + 2;

      this.document.moveCells(sortedIndices, targetIndex);

      // Update selection to new positions
      const newIndices = sortedIndices.map((i) => i + 1);
      this.view.clearSelection();
      newIndices.forEach((i) => this.view.extendSelection(i));
      this.activeCellIndex = this.activeCellIndex + 1;
      this.updateView();
    } else {
      // Move single active cell down
      if (this.activeCellIndex < this.document.getCellCount() - 1) {
        this.document.moveCell(this.activeCellIndex, this.activeCellIndex + 1);
      }
    }
  }

  moveCell(fromIndex, toIndex) {
    if (!this.document) return;
    this.prepareForNotebookOperation();
    this.document.moveCell(fromIndex, toIndex);
  }

  /**
   * Move multiple cells to a target position
   * @param {number[]} indices - Array of cell indices to move (must be sorted)
   * @param {number} targetIndex - Target position to move cells to
   */
  moveCells(indices, targetIndex) {
    if (!this.document) return;
    this.prepareForNotebookOperation();
    this.document.moveCells(indices, targetIndex);
  }

  /**
   * Delete multiple cells at specified indices
   * @param {number[]} indices - Array of cell indices to delete
   */
  deleteCells(indices) {
    if (!this.document) return;
    this.prepareForNotebookOperation();
    this.document.deleteCells(indices);
  }

  changeCellType(type) {
    if (!this.document) return;
    this.prepareForNotebookOperation();
    const cell = this.document.getCell(this.activeCellIndex);
    if (!cell) return;

    const previousType = cell.type;
    if (previousType === type) return;

    this.document.changeCellType(this.activeCellIndex, type);
  }

  // Cut/Copy/Paste cell operations
  cutCell() {
    if (!this.document) return;
    this.prepareForNotebookOperation();

    const selectedIndices = this.view ? this.view.getSelectedCells() : [];
    const indicesToCut = selectedIndices.length > 0 ? selectedIndices : [this.activeCellIndex];

    // Copy cells to clipboard
    this.cellClipboard = indicesToCut.map((i) => this.document.getCell(i).toJSON());

    // Clear selection before delete
    if (this.view) {
      this.view.clearSelection();
    }

    // Delete the cells
    if (indicesToCut.length > 1) {
      this.document.deleteCells(indicesToCut);
      const minDeleted = Math.min(...indicesToCut);
      this.activeCellIndex = Math.min(minDeleted, this.document.getCellCount() - 1);
      this.activeCellIndex = Math.max(0, this.activeCellIndex);
      this.updateView();
    } else {
      this.document.deleteCell(this.activeCellIndex);
    }
  }

  copyCell() {
    if (!this.document) return;

    const selectedIndices = this.view ? this.view.getSelectedCells() : [];
    const indicesToCopy = selectedIndices.length > 0 ? selectedIndices : [this.activeCellIndex];

    // Copy cells to clipboard
    this.cellClipboard = indicesToCopy.map((i) => this.document.getCell(i).toJSON());
  }

  pasteCellBelow() {
    if (!this.document || !this.cellClipboard || this.cellClipboard.length === 0) return;
    this.prepareForNotebookOperation();

    // Clear selection before pasting
    if (this.view) {
      this.view.clearSelection();
    }

    const insertIndex = this.activeCellIndex + 1;

    // Insert cells from clipboard and activate the first pasted cell
    this._insertCellsFromData(insertIndex, this.cellClipboard);
    this.activeCellIndex = insertIndex;
    this.updateView();
  }

  pasteCellAbove() {
    if (!this.document || !this.cellClipboard || this.cellClipboard.length === 0) return;
    this.prepareForNotebookOperation();

    // Clear selection before pasting
    if (this.view) {
      this.view.clearSelection();
    }

    const insertIndex = this.activeCellIndex;

    // Insert cells from clipboard and activate the first pasted cell
    this._insertCellsFromData(insertIndex, this.cellClipboard);
    this.activeCellIndex = insertIndex;
    this.updateView();
  }

  /**
   * Duplicate the active cell (or selected cells) below
   */
  duplicateCell() {
    if (!this.document) return;
    this.prepareForNotebookOperation();

    // Get selected indices BEFORE clearing selection
    const selectedIndices = this.view ? this.view.getSelectedCells() : [];
    const indicesToDuplicate =
      selectedIndices.length > 0 ? selectedIndices : [this.activeCellIndex];

    // Now clear selection
    if (this.view) {
      this.view.clearSelection();
    }

    // Get cell data to duplicate
    const cellsData = indicesToDuplicate.map((i) => this.document.getCell(i).toJSON());

    // Insert after the last selected cell
    const insertIndex = Math.max(...indicesToDuplicate) + 1;

    // Insert duplicated cells and activate the first duplicated cell
    this._insertCellsFromData(insertIndex, cellsData);
    this.activeCellIndex = insertIndex;
    this.updateView();
  }

  /**
   * Insert cells from JSON data at specified index
   * @private
   */
  _insertCellsFromData(startIndex, cellsData) {
    const { v4: uuidv4 } = require("uuid");
    const CellModel = require("./cell-model");

    for (let i = 0; i < cellsData.length; i++) {
      const cellData = cellsData[i];
      const newCell = new CellModel({
        id: uuidv4(),
        type: cellData.cell_type || "code",
        source: Array.isArray(cellData.source) ? cellData.source.join("") : cellData.source || "",
        outputs: cellData.outputs || [],
        executionCount: null, // Reset execution count for pasted cells
        metadata: cellData.metadata || {},
      });

      this.document.cells.splice(startIndex + i, 0, newCell);
    }

    this.activeCellIndex = startIndex;
    this.document.setModified(true);
    this.document.emitter.emit("did-change");
    this.updateView();
  }

  // Undo/Redo operations
  undoCellOperation() {
    this.performSourceEditorHistory("undo");
  }

  redoCellOperation() {
    this.performSourceEditorHistory("redo");
  }

  performSourceEditorHistory(direction) {
    if (!this.document || !this.sourceEditor) return;

    this.flushPendingCellSourceChanges();
    this.commitSourceEditorSnapshot(`before-${direction}`, { skipIfNotebookUnchanged: true });

    const before = this.sourceEditor.getText();
    // Set _historyDirection so the onDidChange observer can pass the correct
    // reason to applySourceEditorSnapshot when undo/redo fires synchronously.
    this._historyDirection = direction;
    try {
      if (typeof this.sourceEditor[direction] === "function") {
        this.sourceEditor[direction]();
      } else {
        const command = direction === "undo" ? "core:undo" : "core:redo";
        const editorElement = lumine.views.getView(this.sourceEditor);
        lumine.commands.dispatch(editorElement, command);
      }
    } finally {
      this._historyDirection = null;
    }

    if (this.sourceEditor.getText() !== before) {
      this.applySourceEditorSnapshot(`source-editor-${direction}`);
    }
  }

  _findCellIndex(cellId, fallbackIndex = -1) {
    if (!this.document) return -1;

    if (cellId) {
      const idIndex = this.document.cells.findIndex((cell) => cell.id === cellId);
      if (idIndex !== -1) return idIndex;
    }

    if (fallbackIndex >= 0 && fallbackIndex < this.document.getCellCount()) {
      return fallbackIndex;
    }

    return -1;
  }

  /**
   * Merge the active cell with the cell below
   */
  mergeCellBelow() {
    if (!this.document) return;
    if (this.activeCellIndex >= this.document.getCellCount() - 1) return;
    this.prepareForNotebookOperation();

    const firstCell = this.document.getCell(this.activeCellIndex);
    const secondCell = this.document.getCell(this.activeCellIndex + 1);

    if (!firstCell || !secondCell) return;

    // Merge sources with newline
    const mergedSource = firstCell.source + "\n" + secondCell.source;

    // Update first cell
    this.document.updateCellSource(this.activeCellIndex, mergedSource);

    // Delete second cell
    this.document.deleteCell(this.activeCellIndex + 1);
  }

  toggleCellOutput() {
    if (!this.document) return;
    this.prepareForNotebookOperation();
    this.document.toggleCellOutput(this.activeCellIndex);
  }

  toggleCellInput() {
    if (!this.document) return;
    this.prepareForNotebookOperation();

    // Get the cell and toggle its visibility
    const cell = this.document.getCell(this.activeCellIndex);
    if (!cell) return;

    // Toggle the model state
    cell.inputVisible = !cell.inputVisible;

    // Immediately update the DOM for instant feedback
    if (this.view) {
      const cellView = this.view.cellViews.get(cell.id);
      if (cellView && cellView.element) {
        const inputArea = cellView.element.querySelector(".cell-input");
        if (inputArea) {
          inputArea.style.display = cell.inputVisible ? "" : "none";
        }
      }
    }

    // Mark document as modified
    this.document.setModified(true);
    this.updateSourceEditorFromNotebook("toggle-cell-input");
    this.emitter.emit("did-change");
  }

  updateCellSource(index, source) {
    if (!this.document) return;
    const cell = this.document.getCell(index);
    if (!cell) return;

    const previousSource = cell.source;
    if (previousSource === source) {
      return;
    }

    this.document.updateCellSource(index, source);
  }

  flushPendingCellSourceChanges() {
    if (this._applyingSourceEditorSnapshot) return;

    if (!this.document || !this.view || !this.view.cellViews) {
      return;
    }

    for (const [cellId, cellView] of this.view.cellViews) {
      if (!cellView || !cellView.editor) continue;

      const index = this._findCellIndex(cellId);
      if (index === -1) continue;

      const cell = this.document.getCell(index);
      if (!cell) continue;

      const source = cellView.editor.getText();
      if (source !== cell.source) {
        this.updateCellSource(index, source);
        // Keep the cell view's dirty tracking aligned with the flushed model text.
        cellView._lastKnownSource = source;
      }
    }
  }

  // Export functions

  // Prompt for an export destination; resolves undefined when cancelled.
  async promptExportPath(options) {
    const { filePath } = await lumine.window.showSaveDialog(options);
    return filePath;
  }

  async exportToPython() {
    if (!this.document) return;
    const lines = [];

    lines.push("#!/usr/bin/env python");
    lines.push("# -*- coding: utf-8 -*-");
    lines.push("");
    lines.push(`# Exported from: ${this.getTitle()}`);
    lines.push("");

    for (let i = 0; i < this.document.getCellCount(); i++) {
      const cell = this.document.getCell(i);
      if (cell.type === "code") {
        lines.push(`# In[${cell.executionCount || i + 1}]:`);
        lines.push(cell.source);
        lines.push("");
      } else if (cell.type === "markdown") {
        lines.push("# " + cell.source.split("\n").join("\n# "));
        lines.push("");
      }
    }

    const content = lines.join("\n");
    const defaultPath = this.document.filePath
      ? this.document.filePath.replace(".ipynb", ".py")
      : "Untitled.py";

    const newPath = await this.promptExportPath({
      defaultPath,
      filters: [{ name: "Python", extensions: ["py"] }],
    });

    if (newPath) {
      await require("fs").promises.writeFile(newPath, content);
      lumine.notifications.addSuccess(`Exported to ${path.basename(newPath)}`);
    }
  }

  async exportToHtml() {
    if (!this.document) return;
    const lines = [];

    lines.push("<!DOCTYPE html>");
    lines.push("<html><head>");
    lines.push('<meta charset="utf-8">');
    lines.push(`<title>${this.getTitle()}</title>`);
    lines.push("<style>");
    lines.push(
      "body { font-family: sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; }",
    );
    lines.push(".cell { margin: 10px 0; border: 1px solid #ddd; border-radius: 4px; }");
    lines.push(
      ".cell-code { background: #f5f5f5; padding: 10px; font-family: monospace; white-space: pre-wrap; }",
    );
    lines.push(".cell-markdown { padding: 10px; }");
    lines.push(".cell-output { padding: 10px; border-top: 1px solid #ddd; background: #fff; }");
    lines.push(".execution-count { color: #888; font-size: 12px; padding: 5px 10px; }");
    lines.push("</style>");
    lines.push("</head><body>");
    lines.push(`<h1>${this.getTitle()}</h1>`);

    for (let i = 0; i < this.document.getCellCount(); i++) {
      const cell = this.document.getCell(i);
      lines.push('<div class="cell">');

      if (cell.type === "code") {
        if (cell.executionCount) {
          lines.push(`<div class="execution-count">In [${cell.executionCount}]:</div>`);
        }
        lines.push(`<div class="cell-code">${this.escapeHtml(cell.source)}</div>`);

        if (cell.outputs && cell.outputs.length > 0) {
          lines.push('<div class="cell-output">');
          cell.outputs.forEach((output) => {
            if (output.text) {
              lines.push(
                `<pre>${this.escapeHtml(
                  Array.isArray(output.text) ? output.text.join("") : output.text,
                )}</pre>`,
              );
            } else if (output.data) {
              if (output.data["text/html"]) {
                lines.push(
                  Array.isArray(output.data["text/html"])
                    ? output.data["text/html"].join("")
                    : output.data["text/html"],
                );
              } else if (output.data["text/plain"]) {
                lines.push(
                  `<pre>${this.escapeHtml(
                    Array.isArray(output.data["text/plain"])
                      ? output.data["text/plain"].join("")
                      : output.data["text/plain"],
                  )}</pre>`,
                );
              }
            }
          });
          lines.push("</div>");
        }
      } else if (cell.type === "markdown") {
        lines.push(`<div class="cell-markdown">${cell.source}</div>`);
      }

      lines.push("</div>");
    }

    lines.push("</body></html>");

    const content = lines.join("\n");
    const defaultPath = this.document.filePath
      ? this.document.filePath.replace(".ipynb", ".html")
      : "Untitled.html";

    const newPath = await this.promptExportPath({
      defaultPath,
      filters: [{ name: "HTML", extensions: ["html"] }],
    });

    if (newPath) {
      await require("fs").promises.writeFile(newPath, content);
      lumine.notifications.addSuccess(`Exported to ${path.basename(newPath)}`);
    }
  }

  escapeHtml(text) {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  // Selection adjustment helpers
  // These adjust the view's selectedCells Set when cells are inserted/deleted/moved

  /**
   * Adjust selection indices when a cell is inserted
   * @private
   */
  _adjustSelectionForInsert(insertIndex) {
    if (!this.view || this.view.selectedCells.size === 0) return;

    const newSelection = new Set();
    for (const selectedIndex of this.view.selectedCells) {
      if (insertIndex <= selectedIndex) {
        newSelection.add(selectedIndex + 1);
      } else {
        newSelection.add(selectedIndex);
      }
    }
    this.view.selectedCells = newSelection;
  }

  /**
   * Adjust selection indices when a cell is deleted
   * @private
   */
  _adjustSelectionForDelete(deletedIndex) {
    if (!this.view || this.view.selectedCells.size === 0) return;

    const newSelection = new Set();
    for (const selectedIndex of this.view.selectedCells) {
      if (selectedIndex < deletedIndex) {
        newSelection.add(selectedIndex);
      } else if (selectedIndex > deletedIndex) {
        newSelection.add(selectedIndex - 1);
      }
      // Deleted index is simply not added to newSelection
    }
    this.view.selectedCells = newSelection;
  }

  /**
   * Adjust selection indices when a cell is moved
   * @private
   */
  _adjustSelectionForMove(fromIndex, toIndex) {
    if (!this.view || this.view.selectedCells.size === 0) return;

    const newSelection = new Set();
    for (const selectedIndex of this.view.selectedCells) {
      if (selectedIndex === fromIndex) {
        // The moved cell
        newSelection.add(toIndex);
      } else if (fromIndex < toIndex) {
        // Moving down: indices between fromIndex and toIndex shift up by 1
        if (selectedIndex > fromIndex && selectedIndex <= toIndex) {
          newSelection.add(selectedIndex - 1);
        } else {
          newSelection.add(selectedIndex);
        }
      } else {
        // Moving up: indices between toIndex and fromIndex shift down by 1
        if (selectedIndex >= toIndex && selectedIndex < fromIndex) {
          newSelection.add(selectedIndex + 1);
        } else {
          newSelection.add(selectedIndex);
        }
      }
    }
    this.view.selectedCells = newSelection;
  }

  // Event handlers
  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  onDidSave(callback) {
    return this.emitter.on("did-save", callback);
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  onDidChangeTitle(callback) {
    return this.emitter.on("did-change-title", callback);
  }

  onDidChangePath(callback) {
    return this.emitter.on("did-change-path", callback);
  }

  // Lumine pane item interface - required for tabs to show modified indicator
  onDidChangeModified(callback) {
    return this.emitter.on("did-change-modified", callback);
  }

  destroy() {
    this._destroyed = true;

    if (this._searchAdapter) {
      this._searchAdapter.destroy();
      this._searchAdapter = null;
    }

    if (this.disposables) {
      this.disposables.dispose();
    }

    if (this.emitter) {
      this.emitter.emit("did-destroy");
      this.emitter.dispose();
    }

    if (this.view) {
      this.view.destroy();
    }

    if (this._chrome) {
      this._chrome.destroy();
      this._chrome = null;
    }

    // Clean up container element
    if (this._containerElement) {
      this._containerElement.innerHTML = "";
      if (this._containerElement.parentNode) {
        this._containerElement.parentNode.removeChild(this._containerElement);
      }
    }
    this._containerElement = null;

    // Release reference to document
    if (this.document) {
      this.document.release();
    }
  }
}

function buildNavigationTree(headings, activeCellIndex, visibleCellIndexes) {
  const headers = [];
  const stack = [];
  let lastItem = null;
  const visibleCells = new Set(visibleCellIndexes);

  headings.forEach((heading, index) => {
    const current = heading.cellIndex === activeCellIndex;
    const item = {
      ...heading,
      children: [],
      startPoint: { row: index, column: 0 },
      endPoint: { row: index, column: 0 },
      lastRow: headings.length,
      currentCount: current ? 1 : 0,
      stackCount: current ? 1 : 0,
      visibility: visibleCells.has(heading.cellIndex) ? 1 : 0,
    };

    while (stack.length && stack[stack.length - 1].level >= item.level) {
      stack.pop();
    }

    if (stack.length) {
      stack[stack.length - 1].children.push(item);
    } else {
      headers.push(item);
    }

    stack.push(item);
    if (lastItem) lastItem.lastRow = item.startPoint.row - 1;
    lastItem = item;
  });

  markCurrentAncestors(headers);
  return headers;
}

function markCurrentAncestors(items) {
  let hasCurrent = false;
  for (const item of items) {
    const childCurrent = markCurrentAncestors(item.children);
    if (item.currentCount || childCurrent) {
      item.stackCount = 1;
      hasCurrent = true;
    }
  }
  return hasCurrent;
}

module.exports = JupyterNotebookEditor;
