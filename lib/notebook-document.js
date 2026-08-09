const { Emitter, CompositeDisposable, watchFile } = require("lumine");
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
    this.filePath = filePath;
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();
    this.refCount = 0;

    // Notebook data
    this.cells = [];
    this.metadata = {};
    this.modified = false;
    this._applyingSourceEditorSnapshot = false;

    // Forward each cell's did-change to the document so the view re-renders
    // on cell-model emissions (e.g. the debounced status flip in setRunning,
    // which has no other notify channel).  Keyed by cell.id so we can dispose
    // subscriptions when cells are replaced or removed.
    this._cellSubscriptions = new Map();

    // Notebook format info
    this.nbformat = 4;
    this.nbformat_minor = 5;

    // Saved content hash for detecting when undo returns to saved state
    this._savedContentHash = null;
    this._isSaving = false;
    this._isSavingResetTimer = null;
    this._fileChangePromise = null;
    this._fileChangeTimeout = null;
    this._fileWatchDisposables = null;

    // File watcher (Lumine's async watchFile replaces the removed lumine File API;
    // reads/writes go through fs, watching through this handle).
    this.file = filePath ? watchFile(filePath) : null;
  }

  _subscribeToCell(cell) {
    if (!cell || this._cellSubscriptions.has(cell.id)) return;
    const disposable = cell.onDidChange?.(() => this.emitter.emit("did-change"));
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
      this.setModified(false);
      this._updateSavedContentHash();
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
    this.setModified(!this.filePath);
    this._updateSavedContentHash();
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

    // Mark as modified since it's unsaved
    this.setModified(true);
    this.emitter.emit("did-load");
  }

  // Save functionality
  async save() {
    if (!this.filePath || !this.file) {
      return false;
    }

    this._isSaving = true;
    try {
      const content = this.toJSON();
      await fsp.writeFile(this.filePath, JSON.stringify(content, null, 2));
      this.setModified(false);
      this._updateSavedContentHash();
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
      this.setModified(true);
      this.emitter.emit("did-change");
    }
  }

  clearAllOutputs() {
    this.cells.forEach((cell) => cell.clearOutputs());
    this.setModified(true);
    this.emitter.emit("did-change");
  }

  clearAllCellTimers() {
    let changed = false;
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
    if (changed) this.emitter.emit("did-change");
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
    this.setModified(true);
    this.emitter.emit("did-change");
    this.emitter.emit("did-insert-cell", { index, cell: newCell });

    return newCell;
  }

  deleteCell(index) {
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

    this.setModified(true);
    this.emitter.emit("did-change");
    this.emitter.emit("did-delete-cell", { index });
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

    this.setModified(true);
    this.emitter.emit("did-change");
    this.emitter.emit("did-delete-cells", { indices: sortedIndices });
  }

  moveCell(fromIndex, toIndex) {
    if (fromIndex < 0 || fromIndex >= this.cells.length) return;
    if (toIndex < 0 || toIndex >= this.cells.length) return;
    if (fromIndex === toIndex) return;

    const cell = this.cells.splice(fromIndex, 1)[0];
    this.cells.splice(toIndex, 0, cell);

    this.setModified(true);
    this.emitter.emit("did-change");
    this.emitter.emit("did-move-cell", { fromIndex, toIndex });
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

    this.setModified(true);
    this.emitter.emit("did-change");
    this.emitter.emit("did-move-cells", {
      indices: sortedIndices,
      targetIndex: adjustedTarget,
    });
  }

  updateCellSource(index, source) {
    if (index >= 0 && index < this.cells.length) {
      const cell = this.cells[index];
      // Only process if the source actually changed
      if (cell.source !== source) {
        cell.source = source;
        cell.sourceRevision++;
        // Check if content matches saved state (handles undo back to original)
        this.updateModifiedState();
        this.emitter.emit("did-change");
      }
    }
  }

  changeCellType(index, type) {
    const cell = this.cells[index];
    if (cell) {
      cell.setType(type);
      this.setModified(true);
      this.emitter.emit("did-change");
    }
  }

  toggleCellOutput(index) {
    const cell = this.cells[index];
    if (cell) {
      cell.toggleOutputVisibility();
      this.emitter.emit("did-change");
    }
  }

  toggleCellInput(index) {
    const cell = this.cells[index];
    if (cell) {
      cell.toggleInputVisibility();
      this.emitter.emit("did-change");
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

  onDidDeleteCell(callback) {
    return this.emitter.on("did-delete-cell", callback);
  }

  onDidDeleteCells(callback) {
    return this.emitter.on("did-delete-cells", callback);
  }

  onDidMoveCell(callback) {
    return this.emitter.on("did-move-cell", callback);
  }

  isModified() {
    return this.modified;
  }

  setModified(modified) {
    if (this.modified !== modified) {
      this.modified = modified;
      this.emitter.emit("did-change-modified", modified);
    }
  }

  /**
   * Compute a hash of the current notebook content for comparison.
   * Used to detect when undo returns to saved state.
   */
  _computeContentHash() {
    // Create a simple hash based on cell content
    const content = this.cells
      .map((cell) => {
        return `${cell.type}:${cell.source}:${JSON.stringify(cell.outputs)}`;
      })
      .join("|");
    // Simple string hash
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }

  /**
   * Store the current content hash as the saved state.
   * Called after save or load.
   */
  _updateSavedContentHash() {
    this._savedContentHash = this._computeContentHash();
  }

  /**
   * Check if current content matches saved content.
   * Returns true if content is same as last saved state.
   */
  matchesSavedContent() {
    if (this._savedContentHash === null) return false;
    return this._computeContentHash() === this._savedContentHash;
  }

  /**
   * Update modified state based on content comparison.
   * Call this after undo operations to detect when content returns to saved state.
   */
  updateModifiedState() {
    const shouldBeModified = !this.matchesSavedContent();
    this.setModified(shouldBeModified);
  }

  async _loadFromFile() {
    const content = await fsp.readFile(this.filePath, "utf8");
    const notebook = JSON.parse(content);
    this._applyNotebookData(notebook);
  }

  async _loadFromFileWithRetries(maxAttempts = 5, delayMs = 150) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this._loadFromFile();
        return;
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
      const cell = new CellModelClass({
        id: cellData.id || uuidv4(),
        type: cellData.cell_type || "code",
        source: Array.isArray(cellData.source) ? cellData.source.join("") : cellData.source || "",
        outputs,
        executionCount,
        metadata: cellData.metadata || {},
      });
      const previousCell = previousCellsById.get(cell.id);
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
    if (this._isSaving || this._fileChangePromise || !this.file) return;

    if (this.isModified()) {
      lumine.notifications.addWarning("Notebook changed on disk", {
        detail: "The notebook has unsaved edits, so the disk changes were not applied.",
        dismissable: true,
      });
      return;
    }

    this._fileChangePromise = (async () => {
      try {
        await this._loadFromFileWithRetries();
        this.setModified(false);
        this._updateSavedContentHash();
        this.emitter.emit("did-reload");
        this.emitter.emit("did-change");
      } catch (error) {
        lumine.notifications.addError("Failed to reload notebook after file change", {
          detail: error.message,
          dismissable: true,
        });
      } finally {
        this._fileChangePromise = null;
      }
    })();

    return this._fileChangePromise;
  }

  onDidChangeModified(callback) {
    return this.emitter.on("did-change-modified", callback);
  }

  onDidReload(callback) {
    return this.emitter.on("did-reload", callback);
  }

  getPath() {
    return this.filePath;
  }

  destroy() {
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
