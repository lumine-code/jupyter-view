const { Emitter, CompositeDisposable, FileState, watchFile } = require("lumine");
const fsp = require("fs").promises;
const { v4: uuidv4 } = require("uuid");

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
    this.id = uuidv4();
    this.filePath = filePath;
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();
    this.refCount = 0;

    // Notebook data
    this.cells = [];
    this.metadata = {};
    this.modified = false;
    this.fileState = filePath ? FileState.UNMODIFIED : FileState.MODIFIED;
    this.currentHistoryStateId = uuidv4();
    this.savedHistoryStateId = filePath ? this.currentHistoryStateId : null;
    this.runtimeRevision = 0;
    this.savedRuntimeRevision = 0;
    this.savedDiskFingerprint = null;
    this._suppressCellEvents = false;

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

    // File watcher (Lumine's async watchFile replaces the removed lumine File API;
    // reads/writes go through fs, watching through this handle).
    this.file = filePath ? watchFile(filePath) : null;
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
      this._markCurrentStateSaved();
      this._watchFile();
      this.emitter.emit("did-load");
    } catch (error) {
      lumine.notifications.addError("Failed to load notebook", {
        detail: error.message,
        dismissable: true,
      });
      await this.initialize();
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
        id: uuidv4(),
        type: "code",
        source: "",
        outputs: [],
        executionCount: null,
        metadata: {},
      }),
    ];
    this._resubscribeCells();

    // New untitled notebooks are modified (need saving)
    // Loaded notebooks from files start as unmodified
    this.currentHistoryStateId = uuidv4();
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
    this.nbformat_minor = notebookData.nbformat_minor || 5;
    this.metadata = notebookData.metadata || {};

    // Load cells from serialized data
    this.cells = (notebookData.cells || []).map((cellData) => {
      return new CellModelClass({
        id: cellData.id || uuidv4(),
        type: cellData.cell_type || "code",
        source: Array.isArray(cellData.source) ? cellData.source.join("") : cellData.source || "",
        outputs: cellData.outputs || [],
        executionCount: cellData.execution_count,
        metadata: cellData.metadata || {},
      });
    });

    // Ensure at least one cell
    if (this.cells.length === 0) {
      this.cells.push(
        new CellModelClass({
          id: uuidv4(),
          type: "code",
          source: "",
          outputs: [],
          executionCount: null,
          metadata: {},
        }),
      );
    }
    this._resubscribeCells();

    this.currentHistoryStateId = uuidv4();
    this.savedHistoryStateId = null;
    this.runtimeRevision = 0;
    this.savedRuntimeRevision = 0;
    this.updateModifiedState();
    this.emitter.emit("did-load");
  }

  // Save functionality
  async save() {
    if (!this.filePath || !this.file) {
      return false;
    }

    this._fileReloadGeneration++;
    this._fileChangeQueued = false;
    this._isSaving = true;
    try {
      const content = this.toJSON();
      const savedHistoryStateId = this.currentHistoryStateId;
      const savedRuntimeRevision = this.runtimeRevision;
      await fsp.writeFile(this.filePath, JSON.stringify(content, null, 2));
      this.savedDiskFingerprint = fingerprintNotebook(content);
      this._markRevisionSaved(savedHistoryStateId, savedRuntimeRevision);
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
      this._isSavingResetTimer = setTimeout(() => {
        this._isSaving = false;
        this._isSavingResetTimer = null;
      }, 500);
    }
  }

  setPath(newPath) {
    this.filePath = newPath;
    if (this.file) this.file.dispose();
    this.file = watchFile(newPath);
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

  getCellCount() {
    return this.cells.length;
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
    const CellModelClass = getCellModel();
    const newCell = new CellModelClass({
      id: uuidv4(),
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
    const cells = (cellsData || []).map(
      (cellData) =>
        new CellModelClass({
          id: uuidv4(),
          type: cellData.cell_type || "code",
          source: Array.isArray(cellData.source) ? cellData.source.join("") : cellData.source || "",
          outputs: cellData.outputs || [],
          executionCount: null,
          metadata: cellData.metadata || {},
        }),
    );
    if (cells.length === 0) return [];
    this.cells.splice(index, 0, ...cells);
    for (const cell of cells) this._subscribeToCell(cell);
    this.emitter.emit("did-insert-cells", { index, cells });
    this.emitter.emit("did-delete-cell", { index });
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
        if (removed) this._unsubscribeFromCell(removed.id);
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
        for (const c of removed) this._unsubscribeFromCell(c.id);
      } else {
        // Delete cells from highest index to lowest
        for (const index of sortedIndices) {
          const [removed] = this.cells.splice(index, 1);
          if (removed) this._unsubscribeFromCell(removed.id);
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
    const change = {
      category: event.category || "history",
      reason: event.reason || "document-change",
      cellIds: event.cellIds || [],
      structural: event.structural === true,
      affectsSource: event.affectsSource ?? event.category === "history",
      originEditor: event.originEditor || null,
    };

    if (change.category === "history") {
      this.currentHistoryStateId = event.historyStateId || uuidv4();
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
    if (this.fileState !== FileState.CONFLICTED && this.fileState !== FileState.REMOVED) {
      this.setFileState(modified ? FileState.MODIFIED : FileState.UNMODIFIED);
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
    this.setFileState(modified ? FileState.MODIFIED : FileState.UNMODIFIED);
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
      notebookData:
        !this.filePath || this.getFileState() !== FileState.UNMODIFIED ? this.toJSON() : null,
      fileState: this.getFileState(),
      sourceControllerState: this._sourceController?.serialize?.() || null,
      currentHistoryStateId: this.currentHistoryStateId,
      savedHistoryStateId: this.savedHistoryStateId,
      runtimeRevision: this.runtimeRevision,
      savedRuntimeRevision: this.savedRuntimeRevision,
      savedDiskFingerprint: this.savedDiskFingerprint,
    };
  }

  restoreState(state = {}, { preserveLoadedRevision = false } = {}) {
    this.id = state.documentId || this.id;
    this._serializedSourceControllerState = state.sourceControllerState || null;
    if (preserveLoadedRevision) {
      const loadedDiskFingerprint = this.savedDiskFingerprint;
      this.restoreRevisionState(state);
      this.savedDiskFingerprint = loadedDiskFingerprint;
      this.setFileState(FileState.UNMODIFIED);
      return;
    }
    this.savedDiskFingerprint = state.savedDiskFingerprint || null;
    this.restoreRevisionState(state);
    if (Object.values(FileState).includes(state.fileState)) {
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
        this.setFileState(FileState.REMOVED);
        return this.getFileState();
      }
      throw error;
    }

    if (this.savedDiskFingerprint && revision.fingerprint === this.savedDiskFingerprint) {
      this.setFileState(this.isModified() ? FileState.MODIFIED : FileState.UNMODIFIED);
      return this.getFileState();
    }

    if (this.isModified()) {
      this.setFileState(FileState.CONFLICTED);
      return this.getFileState();
    }

    this._applyNotebookData(revision.notebook);
    this.savedDiskFingerprint = revision.fingerprint;
    this.currentHistoryStateId = uuidv4();
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
    this._applyNotebookData(revision.notebook);
    this.savedDiskFingerprint = revision.fingerprint;
  }

  async _readFile() {
    const content = await fsp.readFile(this.filePath, "utf8");
    const notebook = JSON.parse(content);
    return { notebook, fingerprint: fingerprintNotebook(notebook) };
  }

  async _loadFromFileWithRetries(maxAttempts = 5, delayMs = 150) {
    const revision = await this._readFileWithRetries(maxAttempts, delayMs);
    this._applyNotebookData(revision.notebook);
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
    this.nbformat_minor = notebook.nbformat_minor || 5;
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
      const cellId = cellData.id || uuidv4();
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
        return previousCell;
      }

      const cell = new CellModelClass({
        id: cellId,
        type: cellType,
        source,
        outputs,
        executionCount,
        metadata: cellData.metadata || {},
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
          id: uuidv4(),
          type: "code",
          source: "",
          outputs: [],
          executionCount: null,
          metadata: {},
        }),
      );
    }
    this._resubscribeCells();
  }

  _watchFile() {
    this._clearFileChangeTimeout();

    if (this._fileWatchDisposables) {
      this._fileWatchDisposables.dispose();
      this._fileWatchDisposables = null;
    }

    if (!this.file) return;

    this._fileWatchDisposables = new CompositeDisposable();
    this._fileWatchDisposables.add(
      this.file.onDidChange(() => {
        this._scheduleFileChangeHandling();
      }),
      this.file.onDidRename((newPath) => {
        // watchFile follows the rename itself, so just track the new path.
        this.filePath = newPath;
        this.emitter.emit("did-change-path", newPath);
      }),
      this.file.onDidDelete(() => {
        this._fileReloadGeneration++;
        this._fileChangeQueued = false;
        this.setFileState(FileState.REMOVED);
        lumine.notifications.addWarning("Notebook file was deleted on disk", {
          detail: this.filePath,
          dismissable: true,
        });
      }),
    );
    this.disposables.add(this._fileWatchDisposables);
  }

  _scheduleFileChangeHandling() {
    if (this._isSaving) return;

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
    if (this._isSaving || !this.file) return;
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
          this.setFileState(this.isModified() ? FileState.MODIFIED : FileState.UNMODIFIED);
          return;
        }
        if (contentGeneration !== this._contentGeneration || this.isModified()) {
          this.setFileState(FileState.CONFLICTED);
          lumine.notifications.addWarning("Notebook changed on disk", {
            detail: "The notebook has unsaved edits, so the disk changes were not applied.",
            dismissable: true,
          });
          return;
        }
        this._applyNotebookData(revision.notebook);
        this.savedDiskFingerprint = revision.fingerprint;
        this.currentHistoryStateId = uuidv4();
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
        if (error?.code === "ENOENT") {
          this.setFileState(FileState.REMOVED);
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

  getPath() {
    return this.filePath;
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
    this.disposables.dispose();
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }
}

module.exports = NotebookDocument;

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
