const { Emitter, CompositeDisposable, watchFile } = require("lumine");
const fsp = require("fs").promises;
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Lazy load components
let CellModel = null;

function getCellModel() {
  if (!CellModel) {
    CellModel = require("./cell-model");
  }
  return CellModel;
}

/**
 * NotebookDocument represents the shared data model for a Jupyter notebook.
 * Multiple editors can view/edit the same document (like Lumine's TextBuffer).
 */
class NotebookDocument {
  constructor(filePath) {
    this.id = randomUUID();
    this.filePath = filePath;
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();
    this.refCount = 0;
    this._destroyed = false;

    // Notebook data
    this.cells = [];
    this.cellStructureRevision = 0;
    this.metadata = {};
    this.modified = false;
    this.fileState = filePath ? "unmodified" : "modified";
    this.currentHistoryStateId = randomUUID();
    this.savedHistoryStateId = filePath ? this.currentHistoryStateId : null;
    this.runtimeRevision = 0;
    this.savedRuntimeRevision = 0;
    this.savedDiskFingerprint = null;
    this._suppressCellEvents = false;
    this.lineEndings = new Set(["\n"]);
    this.firstLineEnding = "\n";
    this.lineEndingRevision = 0;

    // Forward each cell's did-change to the document so the view re-renders
    // on cell-model emissions (e.g. the debounced status flip in setRunning,
    // which has no other notify channel).  Keyed by cell.id so we can dispose
    // subscriptions when cells are replaced or removed.
    this._cellSubscriptions = new Map();

    // Notebook format info
    this.nbformat = 4;
    this.nbformat_minor = 5;

    this._isSaving = false;
    this._isSavingResetTimer = null;
    this._fileChangePromise = null;
    this._fileChangeTimeout = null;
    this._fileWatchDisposables = null;
    this._contentGeneration = 0;
    this._fileReloadGeneration = 0;
    this._fileChangeQueued = false;

    this.file = filePath ? watchFile(filePath) : null;
    this._fileOperationDepth = 0;
    this.disposables.add(
      lumine.workspace.registerFileDocument({
        owner: this,
        getPath: () => this.filePath,
        setPath: (nextPath) => this.setPath(nextPath),
        beginFileOperation: () => {
          this._fileOperationDepth++;
          this._fileReloadGeneration++;
          this._clearFileChangeTimeout();
        },
        endFileOperation: () => {
          this._fileOperationDepth--;
          return this._handleFileChange();
        },
      }),
    );
  }

  _subscribeToCell(cell) {
    if (!cell || this._cellSubscriptions.has(cell.id)) return;
    const disposable = cell.onDidChange?.((event = {}) => {
      if (this._suppressCellEvents) return;
      this._emitChange({
        category: event.category || "history",
        reason: event.reason || "cell-change",
        cellIds: [cell.id],
        structural: false,
        affectsSource: (event.category || "history") === "history",
        originEditor: event.originEditor || null,
      });
    });
    if (disposable) this._cellSubscriptions.set(cell.id, disposable);
  }

  _unsubscribeFromCell(cellId) {
    const disposable = this._cellSubscriptions.get(cellId);
    if (disposable) {
      disposable.dispose?.();
      this._cellSubscriptions.delete(cellId);
    }
  }

  _resubscribeCells() {
    for (const disposable of this._cellSubscriptions.values()) {
      disposable.dispose?.();
    }
    this._cellSubscriptions.clear();
    for (const cell of this.cells) this._subscribeToCell(cell);
  }

  retain() {
    this.refCount++;
    return this;
  }

  release() {
    this.refCount--;
    if (this.refCount <= 0) {
      this.destroy();
    }
  }

  async load() {
    if (!this.filePath) {
      await this.initialize();
      return;
    }

    try {
      await this._loadFromFile();
      if (this._destroyed) return;
      this._markCurrentStateSaved();
      this._watchFile();
      this.emitter.emit("did-load");
    } catch (error) {
      if (this._destroyed) return;
      if (error.code === "ENOENT") {
        await this.initialize();
        this.savedHistoryStateId = null;
        this.updateModifiedState();
        this._watchFile();
        return;
      }
      lumine.notifications.addError("Failed to load notebook", {
        detail: error.message,
        dismissable: true,
      });
      throw error;
    }
  }

  async initialize() {
    const CellModelClass = getCellModel();

    this.metadata = {
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3",
      },
      language_info: {
        name: "python",
        version: "3.x",
      },
    };

    this.cells = [
      new CellModelClass({
        id: randomUUID(),
        type: "code",
        source: "",
        outputs: [],
        executionCount: null,
        metadata: {},
      }),
    ];
    this._resubscribeCells();
    this._setLineEndingState(new Set(["\n"]), "\n");

    // New untitled notebooks are modified (need saving)
    // Loaded notebooks from files start as unmodified
    this.currentHistoryStateId = randomUUID();
    this.savedHistoryStateId = this.filePath ? this.currentHistoryStateId : null;
    this.runtimeRevision = 0;
    this.savedRuntimeRevision = 0;
    this.updateModifiedState();
    this.emitter.emit("did-load");
  }

  /**
   * Initialize from serialized notebook data (for restoring unsaved notebooks)
   */
  async initializeFromData(notebookData) {
    const CellModelClass = getCellModel();

    this.nbformat = notebookData.nbformat || 4;
    this.nbformat_minor = notebookData.nbformat_minor ?? 5;
    this.metadata = notebookData.metadata || {};

    // Load cells from serialized data
    this.cells = (notebookData.cells || []).map((cellData) => {
      return new CellModelClass({
        id: cellData.id || randomUUID(),
        type: cellData.cell_type || "code",
        source: Array.isArray(cellData.source) ? cellData.source.join("") : cellData.source || "",
        outputs: cellData.outputs || [],
        executionCount: cellData.execution_count,
        metadata: cellData.metadata || {},
        attachments: cellData.attachments,
      });
    });

    // Ensure at least one cell
    if (this.cells.length === 0) {
      this.cells.push(
        new CellModelClass({
          id: randomUUID(),
          type: "code",
          source: "",
          outputs: [],
          executionCount: null,
          metadata: {},
        }),
      );
    }
    this._resubscribeCells();

    this.currentHistoryStateId = randomUUID();
    this.savedHistoryStateId = null;
    this.runtimeRevision = 0;
    this.savedRuntimeRevision = 0;
    this.updateModifiedState();
    this.emitter.emit("did-load");
  }

  // Save functionality
  save() {
    if (!this.filePath || !this.file) {
      return Promise.resolve(false);
    }
    try {
      // Capture at invocation; queued saves retain their own path and content.
      const content = this.toJSON();
      const snapshot = {
        filePath: this.filePath,
        file: this.file,
        historyStateId: this.currentHistoryStateId,
        runtimeRevision: this.runtimeRevision,
        lineEndingRevision: this.lineEndingRevision,
        lineEnding: this.getPreferredLineEnding(),
        normalizesLineEndings:
          this.lineEndings.size !== 1 || !this.lineEndings.has(this.getPreferredLineEnding()),
        fingerprint: fingerprintNotebook(content),
        text: formatLineEndings(JSON.stringify(content, null, 2), this.getPreferredLineEnding()),
      };
      const previous = this._savePromise || Promise.resolve();
      const saving = previous.catch(() => {}).then(() => this._saveSnapshot(snapshot));
      this._savePromise = saving;
      return saving;
    } catch (error) {
      lumine.notifications.addError("Failed to save notebook", {
        detail: error.message,
        dismissable: true,
      });
      return Promise.resolve(false);
    }
  }

  async _saveSnapshot(snapshot) {
    clearTimeout(this._isSavingResetTimer);
    this._isSavingResetTimer = null;
    this._fileReloadGeneration++;
    this._fileChangeQueued = false;
    this._isSaving = true;
    try {
      await writeNotebookAtomically(snapshot.filePath, snapshot.text);
      // A Save As or close during the write cannot mark another file's state
      // saved or revive disposed document resources.
      if (this._destroyed || this.file !== snapshot.file || this.filePath !== snapshot.filePath)
        return true;
      let savedHistoryStateId = snapshot.historyStateId;
      if (
        snapshot.normalizesLineEndings &&
        this.lineEndingRevision === snapshot.lineEndingRevision
      ) {
        this._setLineEndingState(new Set([snapshot.lineEnding]), snapshot.lineEnding);
        if (this.currentHistoryStateId === snapshot.historyStateId) {
          this.currentHistoryStateId = randomUUID();
          this._contentGeneration++;
          savedHistoryStateId = this.currentHistoryStateId;
        }
      }
      this.savedDiskFingerprint = snapshot.fingerprint;
      this._markRevisionSaved(savedHistoryStateId, snapshot.runtimeRevision);
      this.emitter.emit("did-save");
      return true;
    } catch (error) {
      lumine.notifications.addError("Failed to save notebook", {
        detail: error.message,
        dismissable: true,
      });
      return false;
    } finally {
      // Delay clearing _isSaving so the file watcher event triggered by our own
      // write is still suppressed when it fires asynchronously on the next turn.
      // 500ms covers the 200ms debounce plus watcher notification latency.
      clearTimeout(this._isSavingResetTimer);
      if (this._destroyed) {
        this._isSaving = false;
        this._isSavingResetTimer = null;
      } else {
        this._isSavingResetTimer = setTimeout(() => {
          this._isSaving = false;
          this._isSavingResetTimer = null;
          if (this._fileChangeQueued) {
            this._fileChangeQueued = false;
            this._scheduleFileChangeHandling();
          }
        }, 500);
      }
    }
  }

  setPath(newPath) {
    if (this.filePath === newPath) return;
    this._fileReloadGeneration++;
    this.filePath = newPath;
    if (this.file) this.file.dispose();
    this.file = newPath ? watchFile(newPath) : null;
    this._watchFile();
    this.emitter.emit("did-change-path", newPath);
  }

  toJSON() {
    return {
      nbformat: this.nbformat,
      nbformat_minor: this.nbformat_minor,
      metadata: this.metadata,
      cells: this.cells.map((cell) => cell.toJSON()),
    };
  }

  // Cell operations
  getCell(index) {
    return this.cells[index];
  }

  getCellIndexById(cellId) {
    if (
      this._indexedCells !== this.cells ||
      this._indexedCellStructureRevision !== this.cellStructureRevision
    ) {
      this._cellIndexesById = new Map(this.cells.map((cell, index) => [cell.id, index]));
      this._indexedCells = this.cells;
      this._indexedCellStructureRevision = this.cellStructureRevision;
    }
    return this._cellIndexesById.get(cellId) ?? -1;
  }

  getCellCount() {
    return this.cells.length;
  }

  getLineEndings() {
    return new Set(this.lineEndings);
  }

  getPreferredLineEnding() {
    if (this.lineEndings.size === 1) return this.lineEndings.values().next().value;
    return this.firstLineEnding || "\n";
  }

  setLineEnding(lineEnding, originEditor = null) {
    if (lineEnding !== "\n" && lineEnding !== "\r\n") return false;
    if (this.lineEndings.size === 1 && this.lineEndings.has(lineEnding)) return false;
    this._setLineEndingState(new Set([lineEnding]), lineEnding);
    this._emitChange({
      category: "history",
      reason: "line-endings",
      cellIds: [],
      structural: false,
      affectsSource: true,
      originEditor,
    });
    return true;
  }

  _setLineEndingState(lineEndings, firstLineEnding = null) {
    const next = normalizeLineEndingSet(lineEndings);
    const first = next.has(firstLineEnding) ? firstLineEnding : next.values().next().value || "\n";
    if (setsEqual(this.lineEndings, next) && this.firstLineEnding === first) return false;
    this.lineEndings = next;
    this.firstLineEnding = first;
    this.lineEndingRevision++;
    this.emitter.emit("did-change-line-endings", this.getLineEndings());
    return true;
  }

  clearCellOutput(index, options = {}) {
    const cell = this.cells[index];
    if (cell) {
      cell.clearOutputs(options);
    }
  }

  clearAllOutputs() {
    this._suppressCellEvents = true;
    try {
      this.cells.forEach((cell) => cell.clearOutputs());
    } finally {
      this._suppressCellEvents = false;
    }
    this._emitChange({
      category: "runtime",
      reason: "clear-all-outputs",
      cellIds: this.cells.map((cell) => cell.id),
      structural: false,
      affectsSource: false,
    });
  }

  clearAllCellTimers() {
    let changed = false;
    this._suppressCellEvents = true;
    try {
      for (const cell of this.cells) {
        if (
          cell.status !== null ||
          cell.startTime !== null ||
          cell.lastRunTime !== null ||
          cell.lastRunTimeText !== null
        ) {
          cell.resetTimer?.();
          changed = true;
        }
      }
    } finally {
      this._suppressCellEvents = false;
    }
    if (changed) {
      this._emitChange({
        category: "transient",
        reason: "runtime-timer",
        cellIds: this.cells.map((cell) => cell.id),
        structural: false,
        affectsSource: false,
      });
    }
  }

  insertCell(index, type = "code") {
    this._indexedCells = null;
    const CellModelClass = getCellModel();
    const newCell = new CellModelClass({
      id: randomUUID(),
      type: type,
      source: "",
      outputs: [],
      executionCount: null,
      metadata: {},
    });

    this.cells.splice(index, 0, newCell);
    this._subscribeToCell(newCell);
    this.emitter.emit("did-insert-cell", { index, cell: newCell });
    this._emitChange({
      category: "history",
      reason: "insert-cell",
      cellIds: [newCell.id],
      structural: true,
      affectsSource: true,
    });

    return newCell;
  }

  insertCellsFromData(index, cellsData, originEditor = null) {
    const CellModelClass = getCellModel();
    const cells = (cellsData || []).map((original) => {
      // Copies and duplicates own their nested metadata, attachments and
      // outputs. A later execution must not mutate the source cell as well.
      const cellData = structuredClone(original);
      return new CellModelClass({
        id: randomUUID(),
        type: cellData.cell_type || "code",
        source: Array.isArray(cellData.source) ? cellData.source.join("") : cellData.source || "",
        outputs: cellData.outputs || [],
        executionCount: null,
        metadata: cellData.metadata || {},
        attachments: cellData.attachments,
      });
    });
    if (cells.length === 0) return [];
    this._indexedCells = null;
    this.cells.splice(index, 0, ...cells);
    for (const cell of cells) this._subscribeToCell(cell);
    this.emitter.emit("did-insert-cells", { index, cells });
    this._emitChange({
      category: "history",
      reason: "insert-cells",
      cellIds: cells.map((cell) => cell.id),
      structural: true,
      affectsSource: true,
      originEditor,
    });
    return cells;
  }

  deleteCell(index) {
    this._indexedCells = null;
    this._suppressCellEvents = true;
    let affectedCellId = this.cells[index]?.id || null;
    try {
      if (this.cells.length <= 1) {
        // Don't delete the last cell, just clear it
        const cell = this.cells[0];
        cell.source = "";
        cell.sourceRevision++;
        cell.clearOutputs();
      } else {
        const [removed] = this.cells.splice(index, 1);
        if (removed) {
          this._unsubscribeFromCell(removed.id);
          removed.destroy?.();
          this.emitter.emit("did-delete-cell", { index });
        }
      }
    } finally {
      this._suppressCellEvents = false;
    }
    this._emitChange({
      category: "history",
      reason: "delete-cell",
      cellIds: affectedCellId ? [affectedCellId] : [],
      structural: true,
      affectsSource: true,
    });
  }

  /**
   * Delete multiple cells at specified indices
   * @param {number[]} indices - Array of cell indices to delete
   */
  deleteCells(indices) {
    if (!indices || indices.length === 0) return;

    // Sort indices in descending order to delete from end first
    // This preserves correct indices as we delete
    const sortedIndices = [...indices].sort((a, b) => b - a);

    // Validate indices
    for (const i of sortedIndices) {
      if (i < 0 || i >= this.cells.length) return;
    }
    this._indexedCells = null;

    // If trying to delete all cells, clear the first one instead
    const affectedCellIds = sortedIndices.map((index) => this.cells[index]?.id).filter(Boolean);
    this._suppressCellEvents = true;
    try {
      if (sortedIndices.length >= this.cells.length) {
        const cell = this.cells[0];
        cell.source = "";
        cell.sourceRevision++;
        cell.clearOutputs();
        // Remove all cells except the first
        const removed = this.cells.splice(1);
        for (const c of removed) {
          this._unsubscribeFromCell(c.id);
          c.destroy?.();
        }
      } else {
        // Delete cells from highest index to lowest
        for (const index of sortedIndices) {
          const [removed] = this.cells.splice(index, 1);
          if (removed) {
            this._unsubscribeFromCell(removed.id);
            removed.destroy?.();
          }
        }
      }
    } finally {
      this._suppressCellEvents = false;
    }
    this.emitter.emit("did-delete-cells", { indices: sortedIndices });
    this._emitChange({
      category: "history",
      reason: "delete-cells",
      cellIds: affectedCellIds,
      structural: true,
      affectsSource: true,
    });
  }

  moveCell(fromIndex, toIndex) {
    if (fromIndex < 0 || fromIndex >= this.cells.length) return;
    if (toIndex < 0 || toIndex >= this.cells.length) return;
    if (fromIndex === toIndex) return;
    this._indexedCells = null;

    const cell = this.cells.splice(fromIndex, 1)[0];
    this.cells.splice(toIndex, 0, cell);

    this.emitter.emit("did-move-cell", { fromIndex, toIndex });
    this._emitChange({
      category: "history",
      reason: "move-cell",
      cellIds: [cell.id],
      structural: true,
      affectsSource: true,
    });
  }

  /**
   * Move multiple cells to a target position
   * @param {number[]} indices - Array of cell indices to move (should be sorted)
   * @param {number} targetIndex - Target position to move cells to
   */
  moveCells(indices, targetIndex) {
    if (!indices || indices.length === 0) return;

    // Sort indices to process correctly
    const sortedIndices = [...indices].sort((a, b) => a - b);

    // Validate indices
    for (const i of sortedIndices) {
      if (i < 0 || i >= this.cells.length) return;
    }
    this._indexedCells = null;

    // Extract cells to move (in order)
    const cellsToMove = sortedIndices.map((i) => this.cells[i]);

    // Calculate how many cells before target will be removed
    const cellsBeforeTarget = sortedIndices.filter((i) => i < targetIndex).length;

    // Remove cells from highest index to lowest to preserve indices
    for (let i = sortedIndices.length - 1; i >= 0; i--) {
      this.cells.splice(sortedIndices[i], 1);
    }

    // Adjust target index based on removed cells
    const adjustedTarget = targetIndex - cellsBeforeTarget;

    // Insert cells at target position
    this.cells.splice(adjustedTarget, 0, ...cellsToMove);

    this.emitter.emit("did-move-cells", {
      indices: sortedIndices,
      targetIndex: adjustedTarget,
    });
    this._emitChange({
      category: "history",
      reason: "move-cells",
      cellIds: cellsToMove.map((cell) => cell.id),
      structural: true,
      affectsSource: true,
    });
  }

  updateCellSource(index, source, originEditor = null) {
    if (index >= 0 && index < this.cells.length) {
      const cell = this.cells[index];
      // Only process if the source actually changed
      if (cell.source !== source) {
        cell.source = source;
        cell.sourceRevision++;
        this._emitChange({
          category: "history",
          reason: "cell-source",
          cellIds: [cell.id],
          structural: false,
          affectsSource: true,
          originEditor,
        });
      }
    }
  }

  changeCellType(index, type) {
    const cell = this.cells[index];
    if (cell) {
      cell.setType(type);
    }
  }

  setCellLanguage(index, languageId) {
    const cell = this.cells[index];
    if (cell) {
      cell.setLanguage(languageId);
    }
  }

  toggleCellOutput(index) {
    const cell = this.cells[index];
    if (cell) {
      cell.toggleOutputVisibility();
    }
  }

  toggleCellInput(index) {
    const cell = this.cells[index];
    if (cell) {
      cell.toggleInputVisibility();
    }
  }

  // Event handlers
  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  onDidLoad(callback) {
    return this.emitter.on("did-load", callback);
  }

  onDidSave(callback) {
    return this.emitter.on("did-save", callback);
  }

  onDidChangePath(callback) {
    return this.emitter.on("did-change-path", callback);
  }

  onDidInsertCell(callback) {
    return this.emitter.on("did-insert-cell", callback);
  }

  onDidInsertCells(callback) {
    return this.emitter.on("did-insert-cells", callback);
  }

  onDidDeleteCell(callback) {
    return this.emitter.on("did-delete-cell", callback);
  }

  onDidDeleteCells(callback) {
    return this.emitter.on("did-delete-cells", callback);
  }

  onDidMoveCell(callback) {
    return this.emitter.on("did-move-cell", callback);
  }

  onDidMoveCells(callback) {
    return this.emitter.on("did-move-cells", callback);
  }

  isModified() {
    return this.modified;
  }

  setModified(modified) {
    this.modified = Boolean(modified);
  }

  getFileState() {
    return this.fileState;
  }

  setFileState(fileState) {
    if (fileState === this.fileState) return false;
    this.fileState = fileState;
    this.emitter.emit("did-change-file-state", fileState);
    return true;
  }

  _emitChange(event = {}) {
    if (event.structural) this.cellStructureRevision++;
    const change = {
      category: event.category || "history",
      reason: event.reason || "document-change",
      cellIds: event.cellIds || [],
      structural: event.structural === true,
      affectsSource: event.affectsSource ?? event.category === "history",
      originEditor: event.originEditor || null,
    };

    if (change.category === "history") {
      this.currentHistoryStateId = event.historyStateId || randomUUID();
      this._contentGeneration++;
    } else if (change.category === "runtime") {
      this.runtimeRevision++;
      this._contentGeneration++;
    }
    this.updateModifiedState();
    this.emitter.emit("did-change", change);
    return change;
  }

  applySourceSnapshot(notebook, options = {}) {
    if (options.lineEndings) {
      this._setLineEndingState(options.lineEndings, options.firstLineEnding);
    }
    this._applyNotebookData(notebook, { preserveRuntimeOutputs: true });
    return this._emitChange({
      category: "history",
      reason: options.reason || "source-history",
      cellIds: options.cellIds || [],
      structural: options.structural === true,
      affectsSource: false,
      originEditor: options.originEditor || null,
      historyStateId: options.historyStateId,
    });
  }

  updateMetadata(metadata, originEditor = null) {
    this.metadata = metadata || {};
    this._emitChange({
      category: "history",
      reason: "notebook-metadata",
      cellIds: [],
      structural: false,
      affectsSource: true,
      originEditor,
    });
  }

  matchesSavedContent() {
    return (
      this.savedHistoryStateId !== null &&
      this.currentHistoryStateId === this.savedHistoryStateId &&
      this.runtimeRevision === this.savedRuntimeRevision
    );
  }

  /**
   * Update modified state based on content comparison.
   * Call this after undo operations to detect when content returns to saved state.
   */
  updateModifiedState() {
    const modified = !this.matchesSavedContent();
    this.setModified(modified);
    if (this.fileState !== "conflicted" && this.fileState !== "removed") {
      this.setFileState(modified ? "modified" : "unmodified");
    }
  }

  _markCurrentStateSaved() {
    this._markRevisionSaved(this.currentHistoryStateId, this.runtimeRevision);
  }

  _markRevisionSaved(historyStateId, runtimeRevision) {
    this.savedHistoryStateId = historyStateId;
    this.savedRuntimeRevision = runtimeRevision;
    const modified = !this.matchesSavedContent();
    this.setModified(modified);
    this.setFileState(modified ? "modified" : "unmodified");
  }

  restoreRevisionState(state = {}) {
    this.id = state.documentId || this.id;
    this.currentHistoryStateId = state.currentHistoryStateId || this.currentHistoryStateId;
    this.savedHistoryStateId = state.savedHistoryStateId ?? null;
    this.runtimeRevision = state.runtimeRevision || 0;
    this.savedRuntimeRevision = state.savedRuntimeRevision || 0;
    this.updateModifiedState();
  }

  getSourceController(serializedState = null) {
    if (!this._sourceController) {
      const NotebookSourceController = require("./notebook-source-controller");
      this._sourceController = new NotebookSourceController(
        this,
        serializedState || this._serializedSourceControllerState || null,
      );
      this._serializedSourceControllerState = null;
    }
    return this._sourceController;
  }

  serializeState() {
    return {
      filePath: this.filePath,
      notebookData: !this.filePath || this.getFileState() !== "unmodified" ? this.toJSON() : null,
      fileState: this.getFileState(),
      sourceControllerState: this._sourceController?.serialize?.() || null,
      currentHistoryStateId: this.currentHistoryStateId,
      savedHistoryStateId: this.savedHistoryStateId,
      runtimeRevision: this.runtimeRevision,
      savedRuntimeRevision: this.savedRuntimeRevision,
      savedDiskFingerprint: this.savedDiskFingerprint,
      lineEndings: Array.from(this.lineEndings),
      firstLineEnding: this.firstLineEnding,
    };
  }

  restoreState(state = {}, { preserveLoadedRevision = false } = {}) {
    this.id = state.documentId || this.id;
    if (preserveLoadedRevision) {
      // A clean file-backed document was just loaded from disk. Its contents
      // and physical format are newer than the workspace snapshot, which may
      // have been serialized before an external edit while Lumine was closed.
      // Rebuild the source projection from that loaded revision instead of
      // replaying stale source text, undo history, or line-ending UI state.
      this._serializedSourceControllerState = null;
      const loadedDiskFingerprint = this.savedDiskFingerprint;
      this.restoreRevisionState(state);
      this.savedDiskFingerprint = loadedDiskFingerprint;
      this.setFileState("unmodified");
      return;
    }
    this._serializedSourceControllerState = state.sourceControllerState || null;
    this.savedDiskFingerprint = state.savedDiskFingerprint || null;
    if (state.lineEndings) {
      this._setLineEndingState(state.lineEndings, state.firstLineEnding);
    }
    this.restoreRevisionState(state);
    if (["unmodified", "modified", "conflicted", "removed"].includes(state.fileState)) {
      this.setFileState(state.fileState);
    }
  }

  async reconcileRestoredFileState() {
    if (!this.filePath) return this.getFileState();

    let revision;
    try {
      revision = await this._readFileWithRetries();
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.setFileState("removed");
        return this.getFileState();
      }
      throw error;
    }

    if (this.savedDiskFingerprint && revision.fingerprint === this.savedDiskFingerprint) {
      const lineEndingsChanged = this._setLineEndingState(
        revision.lineEndings,
        revision.firstLineEnding,
      );
      this.setFileState(this.isModified() ? "modified" : "unmodified");
      if (lineEndingsChanged) this.emitter.emit("did-reload");
      return this.getFileState();
    }

    if (this.isModified()) {
      this.setFileState("conflicted");
      return this.getFileState();
    }

    this._applyNotebookData(revision.notebook);
    this._setLineEndingState(revision.lineEndings, revision.firstLineEnding);
    this.savedDiskFingerprint = revision.fingerprint;
    this.currentHistoryStateId = randomUUID();
    this.runtimeRevision = 0;
    this._markCurrentStateSaved();
    this.emitter.emit("did-reload");
    this.emitter.emit("did-change", {
      category: "history",
      reason: "restore-reload",
      cellIds: this.cells.map((cell) => cell.id),
      structural: true,
      affectsSource: true,
      originEditor: null,
    });
    return this.getFileState();
  }

  async _loadFromFile() {
    const revision = await this._readFile();
    if (this._destroyed) return;
    this._applyNotebookData(revision.notebook);
    this._setLineEndingState(revision.lineEndings, revision.firstLineEnding);
    this.savedDiskFingerprint = revision.fingerprint;
  }

  async _readFile() {
    const content = await fsp.readFile(this.filePath, "utf8");
    const notebook = JSON.parse(content);
    if (
      !notebook ||
      notebook.nbformat !== 4 ||
      !Number.isInteger(notebook.nbformat_minor) ||
      notebook.nbformat_minor < 0 ||
      !Array.isArray(notebook.cells)
    ) {
      throw new TypeError("Notebook is not a valid v4 notebook.");
    }
    const { lineEndings, firstLineEnding } = detectLineEndings(content);
    return { notebook, fingerprint: fingerprintNotebook(notebook), lineEndings, firstLineEnding };
  }

  async _loadFromFileWithRetries(maxAttempts = 5, delayMs = 150) {
    const revision = await this._readFileWithRetries(maxAttempts, delayMs);
    this._applyNotebookData(revision.notebook);
    this._setLineEndingState(revision.lineEndings, revision.firstLineEnding);
    this.savedDiskFingerprint = revision.fingerprint;
  }

  async _readFileWithRetries(maxAttempts = 5, delayMs = 150) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this._readFile();
      } catch (error) {
        lastError = error;

        if (!this._isTransientFileReadError(error) || attempt === maxAttempts) {
          throw error;
        }

        await this._sleep(delayMs);
      }
    }

    throw lastError;
  }

  _isTransientFileReadError(error) {
    return error instanceof SyntaxError;
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _applyNotebookData(notebook, options = {}) {
    this.nbformat = notebook.nbformat || 4;
    this.nbformat_minor = notebook.nbformat_minor ?? 5;
    this.metadata = notebook.metadata || {};

    const CellModelClass = getCellModel();
    const preserveRuntimeOutputs = options.preserveRuntimeOutputs === true;
    const previousCells = this.cells;
    const previousCellsById = new Map(previousCells.map((cell) => [cell.id, cell]));
    const runtimeStateById = new Map(
      previousCells.map((cell) => [
        cell.id,
        {
          outputVisible: cell.outputVisible,
          inputVisible: cell.inputVisible,
          status: cell.status,
          startTime: cell.startTime,
          lastRunTime: cell.lastRunTime,
          lastRunTimeText: cell.lastRunTimeText,
        },
      ]),
    );

    // When applying from a source-editor sync, outputs and executionCount are
    // stripped from the snapshot (see getSourceEditorJSON).  Carry them over
    // from the previous cell models so live images/stdout aren't wiped on
    // every source edit.  Match by id first; fall back to the cell at the
    // same index when an id wasn't present before (e.g. manual JSON id edit),
    // but only if that previous id isn't claimed by another new cell.
    let runtimeOutputsByPrevId = null;
    let claimedPrevIds = null;
    if (preserveRuntimeOutputs) {
      runtimeOutputsByPrevId = new Map(
        previousCells.map((cell) => [
          cell.id,
          { outputs: cell.outputs || [], executionCount: cell.executionCount },
        ]),
      );
      claimedPrevIds = new Set(
        (notebook.cells || [])
          .map((c) => c.id)
          .filter((id) => id && runtimeOutputsByPrevId.has(id)),
      );
    }

    this.cells = (notebook.cells || []).map((cellData, index) => {
      const cellId = cellData.id || randomUUID();
      const cellType = cellData.cell_type || "code";
      const source = Array.isArray(cellData.source)
        ? cellData.source.join("")
        : cellData.source || "";
      let outputs = cellData.outputs || [];
      let executionCount = cellData.execution_count;
      if (preserveRuntimeOutputs) {
        let runtime = cellData.id ? runtimeOutputsByPrevId.get(cellData.id) : null;
        if (!runtime) {
          const fallback = previousCells[index];
          if (fallback && !claimedPrevIds.has(fallback.id)) {
            runtime = { outputs: fallback.outputs || [], executionCount: fallback.executionCount };
          }
        }
        if (runtime) {
          outputs = runtime.outputs;
          executionCount = runtime.executionCount;
        }
      }
      const previousCell = previousCellsById.get(cellId);
      if (previousCell && previousCell.type === cellType) {
        if (previousCell.source !== source) previousCell.sourceRevision++;
        previousCell.source = source;
        previousCell.outputs = outputs;
        previousCell.executionCount = executionCount;
        previousCell.metadata = cellData.metadata || {};
        previousCell.attachments = cellData.attachments;
        return previousCell;
      }

      const cell = new CellModelClass({
        id: cellId,
        type: cellType,
        source,
        outputs,
        executionCount,
        metadata: cellData.metadata || {},
        attachments: cellData.attachments,
      });
      if (previousCell) {
        cell.sourceRevision =
          previousCell.source === cell.source
            ? previousCell.sourceRevision || 0
            : (previousCell.sourceRevision || 0) + 1;
      }
      const runtimeState = runtimeStateById.get(cell.id);
      if (runtimeState) {
        cell.outputVisible = runtimeState.outputVisible;
        cell.inputVisible = runtimeState.inputVisible;
        cell.status = runtimeState.status;
        cell.startTime = runtimeState.startTime;
        cell.lastRunTime = runtimeState.lastRunTime;
        cell.lastRunTimeText = runtimeState.lastRunTimeText;
      }
      return cell;
    });

    // Ensure at least one cell
    if (this.cells.length === 0) {
      this.cells.push(
        new CellModelClass({
          id: randomUUID(),
          type: "code",
          source: "",
          outputs: [],
          executionCount: null,
          metadata: {},
        }),
      );
    }
    this._resubscribeCells();
    const retainedCells = new Set(this.cells);
    for (const previousCell of previousCells) {
      if (!retainedCells.has(previousCell)) previousCell.destroy?.();
    }
  }

  _watchFile() {
    this._clearFileChangeTimeout();

    if (this._fileWatchDisposables) {
      this._fileWatchDisposables.dispose();
      this._fileWatchDisposables = null;
    }

    if (!this.file) return;

    this._fileWatchDisposables = new CompositeDisposable();
    const file = this.file;
    const reconcile = () => {
      if (this.file === file) this._scheduleFileChangeHandling();
    };
    this._fileWatchDisposables.add(
      file.onDidChange(reconcile),
      file.onDidInvalidate(reconcile),
      file.onDidError((error) => console.error("Unable to watch notebook", error)),
    );
    this.disposables.add(this._fileWatchDisposables);
    file.ready.then(reconcile, () => {});
  }

  _scheduleFileChangeHandling() {
    if (this.disposables.disposed) return;
    if (this._isSaving || this._fileOperationDepth) {
      this._fileChangeQueued = true;
      return;
    }

    this._clearFileChangeTimeout();
    this._fileChangeTimeout = setTimeout(() => {
      this._fileChangeTimeout = null;
      this._handleFileChange();
    }, 200);
  }

  _clearFileChangeTimeout() {
    if (this._fileChangeTimeout) {
      clearTimeout(this._fileChangeTimeout);
      this._fileChangeTimeout = null;
    }
  }

  async _handleFileChange() {
    if (this.disposables.disposed || !this.file) return;
    if (this._isSaving || this._fileOperationDepth) {
      this._fileChangeQueued = true;
      return;
    }
    if (this._fileChangePromise) {
      this._fileChangeQueued = true;
      return this._fileChangePromise;
    }

    const contentGeneration = this._contentGeneration;
    const reloadGeneration = ++this._fileReloadGeneration;

    this._fileChangePromise = (async () => {
      try {
        const revision = await this._readFileWithRetries();
        if (reloadGeneration !== this._fileReloadGeneration) return;
        if (revision.fingerprint === this.savedDiskFingerprint) {
          const lineEndingsChanged = this._setLineEndingState(
            revision.lineEndings,
            revision.firstLineEnding,
          );
          this.setFileState(this.isModified() ? "modified" : "unmodified");
          if (lineEndingsChanged) this.emitter.emit("did-reload");
          return;
        }
        if (contentGeneration !== this._contentGeneration || this.isModified()) {
          this.setFileState("conflicted");
          lumine.notifications.addWarning("Notebook changed on disk", {
            detail: "The notebook has unsaved edits, so the disk changes were not applied.",
            dismissable: true,
          });
          return;
        }
        this._applyNotebookData(revision.notebook);
        this._setLineEndingState(revision.lineEndings, revision.firstLineEnding);
        this.savedDiskFingerprint = revision.fingerprint;
        this.currentHistoryStateId = randomUUID();
        this.runtimeRevision = 0;
        this._markCurrentStateSaved();
        this.emitter.emit("did-reload");
        this.emitter.emit("did-change", {
          category: "history",
          reason: "reload",
          cellIds: this.cells.map((cell) => cell.id),
          structural: true,
          affectsSource: true,
          originEditor: null,
        });
      } catch (error) {
        if (reloadGeneration !== this._fileReloadGeneration || this.disposables.disposed) return;
        if (error?.code === "ENOENT") {
          this.setFileState("removed");
        } else {
          lumine.notifications.addError("Failed to reload notebook after file change", {
            detail: error.message,
            dismissable: true,
          });
        }
      } finally {
        this._fileChangePromise = null;
        if (this._fileChangeQueued) {
          this._fileChangeQueued = false;
          this._scheduleFileChangeHandling();
        }
      }
    })();

    return this._fileChangePromise;
  }

  onDidChangeFileState(callback) {
    return this.emitter.on("did-change-file-state", callback);
  }

  onDidReload(callback) {
    return this.emitter.on("did-reload", callback);
  }

  onDidChangeLineEndings(callback) {
    return this.emitter.on("did-change-line-endings", callback);
  }

  getPath() {
    return this.filePath;
  }

  isDestroyed() {
    return this._destroyed;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._fileWatchDisposables) {
      this._fileWatchDisposables.dispose();
      this._fileWatchDisposables = null;
    }
    if (this.file) {
      this.file.dispose();
      this.file = null;
    }
    this._clearFileChangeTimeout();
    clearTimeout(this._isSavingResetTimer);
    this._isSavingResetTimer = null;
    for (const disposable of this._cellSubscriptions.values()) {
      disposable.dispose?.();
    }
    this._cellSubscriptions.clear();
    for (const cell of this.cells) cell.destroy?.();
    this.disposables.dispose();
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }
}

module.exports = NotebookDocument;

async function writeNotebookAtomically(filePath, text) {
  let target = await resolveSaveTarget(filePath);
  let mode;
  try {
    // Preserve symlink semantics and the existing file's access permissions.
    mode = (await fsp.stat(target)).mode;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporaryPath = path.join(path.dirname(target), `.jupyter-view-${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temporaryPath, text, { encoding: "utf8", flag: "wx", mode });
    await fsp.rename(temporaryPath, target);
  } finally {
    await fsp.rm(temporaryPath, { force: true });
  }
}

async function resolveSaveTarget(filePath) {
  let target = filePath;
  for (;;) {
    try {
      return await fsp.realpath(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      const link = await fsp.readlink(target);
      target = path.resolve(path.dirname(target), link);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EINVAL") return target;
      throw error;
    }
  }
}

function fingerprintNotebook(notebook) {
  return JSON.stringify(canonicalize(notebook));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function detectLineEndings(text) {
  const lineEndings = new Set();
  let firstLineEnding = null;
  for (const match of String(text || "").matchAll(/\r\n|\n/g)) {
    const lineEnding = match[0];
    if (!firstLineEnding) firstLineEnding = lineEnding;
    lineEndings.add(lineEnding);
  }
  if (lineEndings.size === 0) {
    lineEndings.add("\n");
    firstLineEnding = "\n";
  }
  return { lineEndings, firstLineEnding };
}

function normalizeLineEndingSet(lineEndings) {
  const result = new Set();
  for (const lineEnding of lineEndings || []) {
    if (lineEnding === "\n" || lineEnding === "\r\n") result.add(lineEnding);
  }
  if (result.size === 0) result.add("\n");
  return result;
}

function setsEqual(left, right) {
  return left?.size === right?.size && Array.from(left).every((value) => right.has(value));
}

function formatLineEndings(text, lineEnding) {
  return String(text).replace(/\r\n|\r|\n/g, lineEnding);
}
