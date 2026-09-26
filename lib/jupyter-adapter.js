const VALID_OUTPUT_TYPES = new Set(["execute_result", "display_data", "stream", "error"]);
const INVALID_EXECUTION_TIMES = new Set(["", "No execution", "Running ...", "Not available"]);
const {
  getGrammarForLanguage,
  getNotebookLanguage,
  inferLanguageFromKernelName,
  normalizeLanguage,
} = require("./notebook-language");

function getNotebookEditorClass() {
  return require("./jupyter-notebook-editor");
}

function getPlainTextGrammar() {
  return lumine.grammars.grammarForScopeName("text.plain") || lumine.grammars.nullGrammar;
}

function isNotebookEditor(item) {
  const JupyterNotebookEditor = getNotebookEditorClass();
  return (
    item instanceof JupyterNotebookEditor || item?.constructor?.name === "JupyterNotebookEditor"
  );
}

function getNotebookPath(editor) {
  return editor?.getPath?.() || null;
}

function getCellCount(editor) {
  return editor?.document?.getCellCount?.() || 0;
}

function getCell(editor, index) {
  return editor?.document?.getCell?.(index) || null;
}

function getCellIndex(editor, cellId) {
  if (cellId == null) return -1;
  return editor?.document?.cells?.findIndex((cell) => cell.id === cellId) ?? -1;
}

function getCellEditor(editor, index) {
  if (typeof editor?.getCellEditor !== "function") return null;
  return editor.getCellEditor(index + 1);
}

function nonEmptyString(value) {
  if (value == null) return null;
  return String(value).trim() || null;
}

function updateRuntimeCellData(editor, callback) {
  if (typeof editor?.updateRuntimeCellData === "function") {
    return editor.updateRuntimeCellData(callback);
  }
  return callback();
}

class JupyterAdapter {
  constructor(editor) {
    this.editor = editor;
  }

  getPaneItem() {
    return this.editor;
  }

  getElement() {
    return this.editor?.getElement?.() || null;
  }

  getPath() {
    return getNotebookPath(this.editor);
  }

  getAdapterId() {
    const documentId = this.editor?.document?.id;
    return documentId ? `jupyter-view:${documentId}` : null;
  }

  onDidChangePath(callback) {
    return this.editor?.onDidChangePath?.(callback);
  }

  getTitle() {
    return this.editor?.getTitle?.() || "Untitled.ipynb";
  }

  getMetadata() {
    return this.editor?.document?.metadata || {};
  }

  getKernelOwner() {
    return this.editor?.document || null;
  }

  getActiveTargetId() {
    return getCell(this.editor, this.editor?.activeCellIndex)?.id || null;
  }

  getTargetCount() {
    return getCellCount(this.editor);
  }

  setActiveTargetId(targetId) {
    const index = getCellIndex(this.editor, targetId);
    if (index !== -1) this.editor?.setActiveCell?.(index);
  }

  getSelectedTargetIds() {
    return (this.editor?.view?.getSelectedCells?.() || [])
      .map((index) => getCell(this.editor, index)?.id)
      .filter(Boolean);
  }

  getRunTargetIds(scope = "selected") {
    const count = getCellCount(this.editor);
    const activeIndex = this.editor?.activeCellIndex || 0;
    let indexes;

    if (scope === "active") {
      indexes = [activeIndex];
    } else if (scope === "all") {
      indexes = Array.from({ length: count }, (_, index) => index);
    } else if (scope === "above") {
      indexes = Array.from({ length: activeIndex }, (_, index) => index);
    } else if (scope === "below") {
      indexes = Array.from(
        { length: Math.max(0, count - activeIndex) },
        (_, offset) => activeIndex + offset,
      );
    } else {
      indexes = this.editor?.view?.getSelectedCells?.() || [];
      if (indexes.length === 0) indexes = [activeIndex];
    }

    return indexes.map((index) => getCell(this.editor, index)?.id).filter(Boolean);
  }

  getRunTargets(scope = "selected") {
    return this.getRunTargetIds(scope)
      .map((targetId) => this.getRunTarget(targetId))
      .filter(Boolean);
  }

  getRunTarget(targetId) {
    const index = getCellIndex(this.editor, targetId);
    const cell = getCell(this.editor, index);
    if (!cell) return null;
    const isCode = cell.type === "code";
    const editor = isCode ? getCellEditor(this.editor, index) : this.getKernelEditor(targetId);
    if (!editor) return null;
    const syntaxEditor = this.editor?.getCellEditorById?.(cell.id) || (isCode ? editor : null);

    return {
      id: cell.id,
      index,
      kind: "jupyter-cell",
      type: cell.type,
      executable: isCode,
      source: isCode ? cell.source || "" : "",
      editor,
      // This is the cell's syntax grammar. It may deliberately differ from
      // the one kernel language shared by every executable cell.
      grammar: syntaxEditor?.getGrammar?.() || getPlainTextGrammar(),
      metadata: cell.metadata || {},
      row: Math.max(0, editor.getLastBufferRow?.() || 0),
    };
  }

  getKernelEditor(targetId = this.getActiveTargetId()) {
    const targetIndex = getCellIndex(this.editor, targetId);
    if (targetIndex === -1) return this.editor?.getSourceEditor?.() || null;
    const activeEditor = getCellEditor(this.editor, targetIndex);
    if (activeEditor) return activeEditor;

    for (let index = targetIndex + 1; index < this.getTargetCount(); index++) {
      const cell = getCell(this.editor, index);
      if (cell?.type !== "code") continue;
      const editor = getCellEditor(this.editor, index);
      if (editor) return editor;
    }

    for (let index = targetIndex - 1; index >= 0; index--) {
      const cell = getCell(this.editor, index);
      if (cell?.type !== "code") continue;
      const editor = getCellEditor(this.editor, index);
      if (editor) return editor;
    }

    return this.editor?.getSourceEditor?.() || null;
  }

  getKernelLanguage(kernelSpec = null) {
    if (kernelSpec) {
      return (
        normalizeLanguage(kernelSpec.language) ||
        inferLanguageFromKernelName(kernelSpec) ||
        getNotebookLanguage(this.getMetadata())
      );
    }
    return getNotebookLanguage(this.getMetadata());
  }

  getKernelGrammar(kernelSpec = null) {
    return getGrammarForLanguage(this.getKernelLanguage(kernelSpec)) || getPlainTextGrammar();
  }

  getKernelTarget(targetId = this.getActiveTargetId()) {
    return this.getRunTarget(targetId);
  }

  setKernelSpec(kernelSpec, languageInfo = null) {
    const document = this.editor?.document;
    if (!document || !kernelSpec?.name) return false;
    const language =
      nonEmptyString(languageInfo?.name) ||
      nonEmptyString(kernelSpec.language) ||
      inferLanguageFromKernelName(kernelSpec) ||
      "python";
    const metadata = { ...(document.metadata || {}) };
    metadata.kernelspec = {
      display_name: kernelSpec.display_name || kernelSpec.name,
      language,
      name: kernelSpec.name,
    };
    metadata.language_info = { ...(languageInfo || {}), name: language };
    document.updateMetadata(metadata, this.editor);
    return true;
  }

  getNextRunTarget(target) {
    const targetIndex = getCellIndex(this.editor, target?.id);
    if (targetIndex === -1) return null;

    const shouldFocusEditor = this.editor?.view?.getMode?.() === "edit";
    let nextTarget = null;
    for (let index = targetIndex + 1; index < this.getTargetCount(); index++) {
      const candidateId = getCell(this.editor, index)?.id;
      const candidate = this.getRunTarget(candidateId);
      if (candidate) {
        nextTarget = candidate;
        break;
      }
    }

    if (
      !nextTarget &&
      targetIndex === this.getTargetCount() - 1 &&
      typeof this.editor?.insertCellBelow === "function"
    ) {
      this.editor.setActiveCell?.(targetIndex);
      this.editor.insertCellBelow();
      nextTarget = this.getRunTarget(getCell(this.editor, targetIndex + 1)?.id);
    }

    if (nextTarget) {
      // Move to the next cell immediately when the run command fires — classic
      // Jupyter behaviour: focus shifts at execution start, not after the
      // kernel reply arrives.  Store the id so focusTarget / focusTargetEditor
      // can suppress the redundant post-execution call when the user is still
      // on that cell.
      this._preFocusedTargetId = nextTarget.id;
      this.setActiveTargetId(nextTarget.id);
      this.editor?.view?.clearSelection?.();
      this.editor?.view?.scrollToCell?.(nextTarget.index);
      if (shouldFocusEditor) {
        this.editor?.focusActiveCellEditor?.();
      } else {
        this.editor?.view?.element?.focus?.();
      }
    }

    return nextTarget;
  }

  getTarget(targetId) {
    return getCell(this.editor, getCellIndex(this.editor, targetId));
  }

  getTargetType(targetId) {
    return this.getTarget(targetId)?.type || null;
  }

  clearTargetOutputs(target) {
    const cell = this.getTarget(target?.id);
    if (cell?.type !== "code") return;
    updateRuntimeCellData(this.editor, () => {
      // Defer the output clear: keep previous outputs visible until either
      // (a) the first new output arrives (addOutput flushes the pending clear
      // synchronously), or (b) 50ms passes with nothing — same threshold as
      // the running-state debounce in CellModel.setRunning.  Avoids the flash
      // of an empty output area on instant cells.
      const currentCell = this.getTarget(target.id);
      if (currentCell?.type !== "code") return;
      currentCell.scheduleClearOutputs?.({ preserveRuntime: true });
    });
  }

  beginTargetExecution(target) {
    const cell = this.getTarget(target?.id);
    if (cell?.type !== "code") return;
    // A cell can be submitted again before its previous request finishes.
    // Timing therefore belongs to this execution target, not to the cell id.
    if (!this._executionStartTimes) this._executionStartTimes = new WeakMap();
    this._executionStartTimes.set(target, performance.now());
    if (!this._runningTargetCounts) this._runningTargetCounts = new Map();
    const count = this._runningTargetCounts.get(target.id) || 0;
    this._runningTargetCounts.set(target.id, count + 1);
    if (count === 0) cell.setRunning?.();
  }

  cancelTargetExecution() {}

  failTargetExecution() {}

  skipTargetExecution() {}

  appendTargetOutput(target, output) {
    if (this.getTargetType(target?.id) !== "code") return;
    if (output?.output_type === "clear_output") {
      updateRuntimeCellData(this.editor, () => {
        const cell = this.getTarget(target.id);
        if (cell?.type !== "code") return;
        cell.applyClearOutput?.(output.wait);
      });
      return;
    }
    if (!VALID_OUTPUT_TYPES.has(output?.output_type)) return;
    updateRuntimeCellData(this.editor, () => {
      const cell = this.getTarget(target.id);
      if (cell?.type !== "code") return;
      cell.addOutput(output);
    });
  }

  setTargetExecutionCount(target, count) {
    updateRuntimeCellData(this.editor, () => {
      const cell = this.getTarget(target?.id);
      if (cell?.type !== "code") return;
      cell.setExecutionCount(count);
    });
  }

  finishTargetExecution(target, { lastExecutionTime } = {}) {
    const endTime = performance.now();
    const startTime = this._executionStartTimes?.get(target) ?? null;
    this._executionStartTimes?.delete(target);
    const runningCount = this._runningTargetCounts?.get(target?.id) || 0;
    if (runningCount > 1) {
      this._runningTargetCounts.set(target.id, runningCount - 1);
    } else if (runningCount === 1) {
      this._runningTargetCounts.delete(target.id);
    }
    updateRuntimeCellData(this.editor, () => {
      const cell = this.getTarget(target?.id);
      if (cell?.type !== "code") return;
      if (runningCount === 1) cell.clearRunning?.();
      cell.setLastRunTime?.(
        startTime !== null ? endTime - startTime : cell.lastRunTime,
        lastExecutionTime && !INVALID_EXECUTION_TIMES.has(lastExecutionTime)
          ? lastExecutionTime
          : cell.lastRunTimeText,
      );
    });
  }

  focusTarget(target) {
    const index = getCellIndex(this.editor, target?.id);
    if (index === -1) return;
    // Suppress the post-execution refocus when getNextRunTarget already moved
    // here at execution start and the user hasn't navigated away since.
    if (this._preFocusedTargetId === target.id) {
      this._preFocusedTargetId = null;
      if (this.getActiveTargetId() === target.id) return;
    }
    this.setActiveTargetId(target.id);
    this.editor?.view?.clearSelection?.();
    this.editor?.view?.scrollToCell?.(index);
    if (this.editor?.view?.getMode?.() === "edit") {
      this.editor?.focusActiveCellEditor?.();
    }
  }

  focusTargetEditor(target) {
    const index = getCellIndex(this.editor, target?.id);
    if (index === -1) return;
    // Same suppression as focusTarget (inlined so focusActiveCellEditor is
    // also skipped when the cell was already focused immediately).
    if (this._preFocusedTargetId === target.id) {
      this._preFocusedTargetId = null;
      if (this.getActiveTargetId() === target.id) return;
    }
    this.setActiveTargetId(target.id);
    this.editor?.view?.clearSelection?.();
    this.editor?.view?.scrollToCell?.(index);
    this.editor?.focusActiveCellEditor?.();
  }
}

class JupyterAdapterService {
  handlesItem(item) {
    return isNotebookEditor(item);
  }

  getAdapterForItem(item) {
    if (!this.handlesItem(item)) return null;
    return new JupyterAdapter(item);
  }

  getActiveAdapter() {
    const item = lumine.workspace.getCenter().getActivePaneItem();
    return this.getAdapterForItem(item);
  }
}

module.exports = JupyterAdapterService;
