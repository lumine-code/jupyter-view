const VALID_OUTPUT_TYPES = new Set(["execute_result", "display_data", "stream", "error"]);
const INVALID_EXECUTION_TIMES = new Set(["", "No execution", "Running ...", "Not available"]);
const { getGrammarForLanguage, getNotebookLanguage } = require("./notebook-language");

function getNotebookEditorClass() {
  return require("./jupyter-notebook-editor");
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

function getCellEditor(editor, index) {
  if (typeof editor?.getCellEditor !== "function") return null;
  return editor.getCellEditor(index + 1);
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
    if (!this.editor) return null;
    if (!this.editor._jupyterAdapterId) {
      this.editor._jupyterAdapterId = `jupyter-view:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    }
    return this.editor._jupyterAdapterId;
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

  getActiveTargetId() {
    return this.editor?.activeCellIndex || 0;
  }

  getTargetCount() {
    return getCellCount(this.editor);
  }

  setActiveTargetId(targetId) {
    this.editor?.setActiveCell?.(targetId);
  }

  getSelectedTargetIds() {
    return this.editor?.view?.getSelectedCells?.() || [];
  }

  getRunTargetIds(scope = "selected") {
    const count = getCellCount(this.editor);
    const activeIndex = this.getActiveTargetId();
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
      indexes = this.getSelectedTargetIds();
      if (indexes.length === 0) indexes = [activeIndex];
    }

    return indexes.filter((index) => !!getCell(this.editor, index));
  }

  getRunTargets(scope = "selected") {
    return this.getRunTargetIds(scope)
      .map((targetId) => this.getRunTarget(targetId))
      .filter(Boolean);
  }

  getRunTarget(targetId) {
    const cell = getCell(this.editor, targetId);
    if (!cell) return null;
    const isCode = cell.type === "code";
    const editor = isCode ? getCellEditor(this.editor, targetId) : this.getKernelEditor(targetId);
    if (!editor) return null;

    return {
      id: targetId,
      index: targetId,
      kind: "jupyter-cell",
      type: cell.type,
      executable: isCode,
      source: isCode ? cell.source || "" : "",
      editor,
      grammar: isCode ? editor.getGrammar?.() || this.getKernelGrammar() : this.getKernelGrammar(),
      metadata: cell.metadata || {},
      row: Math.max(0, editor.getLastBufferRow?.() || 0),
    };
  }

  getKernelEditor(targetId = this.getActiveTargetId()) {
    const activeEditor = getCellEditor(this.editor, targetId);
    if (activeEditor) return activeEditor;

    for (let index = targetId + 1; index < this.getTargetCount(); index++) {
      const cell = getCell(this.editor, index);
      if (cell?.type !== "code") continue;
      const editor = getCellEditor(this.editor, index);
      if (editor) return editor;
    }

    for (let index = targetId - 1; index >= 0; index--) {
      const cell = getCell(this.editor, index);
      if (cell?.type !== "code") continue;
      const editor = getCellEditor(this.editor, index);
      if (editor) return editor;
    }

    return this.editor?.getSourceEditor?.() || null;
  }

  getKernelGrammar() {
    for (let index = 0; index < this.getTargetCount(); index++) {
      const cell = getCell(this.editor, index);
      if (cell?.type !== "code") continue;
      const editor = getCellEditor(this.editor, index);
      const grammar = editor?.getGrammar?.();
      if (grammar) return grammar;
    }

    return getGrammarForLanguage(getNotebookLanguage(this.getMetadata()));
  }

  getKernelTarget(targetId = this.getActiveTargetId()) {
    return this.getRunTarget(targetId);
  }

  setKernelSpec(kernelSpec) {
    const document = this.editor?.document;
    if (!document || !kernelSpec?.name) return;
    const metadata = { ...(document.metadata || {}) };
    metadata.kernelspec = {
      display_name: kernelSpec.display_name || kernelSpec.name,
      language: kernelSpec.language || metadata.kernelspec?.language || "",
      name: kernelSpec.name,
    };
    if (kernelSpec.language) {
      metadata.language_info = {
        ...(metadata.language_info || {}),
        name: kernelSpec.language,
      };
    }
    document.updateMetadata(metadata, this.editor);
  }

  getNextRunTarget(target) {
    if (typeof target?.id !== "number") return null;

    const shouldFocusEditor = this.editor?.view?.getMode?.() === "edit";
    let nextTarget = null;
    for (let index = target.id + 1; index < this.getTargetCount(); index++) {
      const candidate = this.getRunTarget(index);
      if (candidate) {
        nextTarget = candidate;
        break;
      }
    }

    if (
      !nextTarget &&
      target.id === this.getTargetCount() - 1 &&
      typeof this.editor?.insertCellBelow === "function"
    ) {
      this.editor.setActiveCell?.(target.id);
      this.editor.insertCellBelow();
      nextTarget = this.getRunTarget(target.id + 1);
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
      this.editor?.view?.scrollToCell?.(nextTarget.id);
      if (shouldFocusEditor) {
        this.editor?.focusActiveCellEditor?.();
      } else {
        this.editor?.view?.element?.focus?.();
      }
    }

    return nextTarget;
  }

  getTarget(targetId) {
    return getCell(this.editor, targetId);
  }

  getTargetType(targetId) {
    return getCell(this.editor, targetId)?.type || null;
  }

  clearTargetOutputs(target) {
    if (this.getTargetType(target.id) !== "code") return;
    // Record wall-clock start time on the adapter as a fallback for kernels
    // that cannot report message timestamps.
    if (!this._executionStartTimes) this._executionStartTimes = new Map();
    this._executionStartTimes.set(target.id, performance.now());
    updateRuntimeCellData(this.editor, () => {
      // Defer the output clear: keep previous outputs visible until either
      // (a) the first new output arrives (addOutput flushes the pending clear
      // synchronously), or (b) 50ms passes with nothing — same threshold as
      // the running-state debounce in CellModel.setRunning.  Avoids the flash
      // of an empty output area on instant cells.
      const cell = getCell(this.editor, target.id);
      cell?.setRunning?.();
      cell?.scheduleClearOutputs?.({ preserveRuntime: true });
    });
  }

  beginTargetExecution(target) {
    if (this.getTargetType(target.id) !== "code") return;
    const cell = getCell(this.editor, target.id);
    cell?.setRunning?.();
  }

  cancelTargetExecution(target) {
    if (this.getTargetType(target.id) !== "code") return;
    updateRuntimeCellData(this.editor, () => {
      const cell = getCell(this.editor, target.id);
      if (!cell) return;
      cell.clearRunning?.();
    });
  }

  failTargetExecution(target) {
    if (this.getTargetType(target.id) !== "code") return;
    updateRuntimeCellData(this.editor, () => {
      const cell = getCell(this.editor, target.id);
      if (!cell) return;
      cell.clearRunning?.();
    });
  }

  skipTargetExecution() {}

  appendTargetOutput(target, output) {
    if (this.getTargetType(target.id) !== "code") return;
    if (output?.output_type === "clear_output") {
      updateRuntimeCellData(this.editor, () => {
        const cell = getCell(this.editor, target.id);
        if (!cell) return;
        cell.applyClearOutput?.(output.wait);
      });
      return;
    }
    if (!VALID_OUTPUT_TYPES.has(output?.output_type)) return;
    updateRuntimeCellData(this.editor, () => {
      const cell = getCell(this.editor, target.id);
      if (!cell) return;
      cell.addOutput(output);
    });
  }

  setTargetExecutionCount(target, count) {
    if (this.getTargetType(target.id) !== "code") return;
    updateRuntimeCellData(this.editor, () => {
      const cell = getCell(this.editor, target.id);
      if (!cell) return;
      cell.setExecutionCount(count);
    });
  }

  finishTargetExecution(target, { lastExecutionTime } = {}) {
    if (this.getTargetType(target.id) !== "code") return;
    const endTime = performance.now();
    const startTime = this._executionStartTimes?.get(target.id) ?? null;
    this._executionStartTimes?.delete(target.id);
    updateRuntimeCellData(this.editor, () => {
      const cell = getCell(this.editor, target.id);
      if (!cell) return;
      cell.clearRunning?.();
      cell.setLastRunTime?.(
        startTime !== null ? endTime - startTime : cell.lastRunTime,
        lastExecutionTime && !INVALID_EXECUTION_TIMES.has(lastExecutionTime)
          ? lastExecutionTime
          : cell.lastRunTimeText,
      );
    });
  }

  focusTarget(target) {
    // Suppress the post-execution refocus when getNextRunTarget already moved
    // here at execution start and the user hasn't navigated away since.
    if (this._preFocusedTargetId === target.id) {
      this._preFocusedTargetId = null;
      if (this.getActiveTargetId() === target.id) return;
    }
    this.setActiveTargetId(target.id);
    this.editor?.view?.clearSelection?.();
    this.editor?.view?.scrollToCell?.(target.id);
    if (this.editor?.view?.getMode?.() === "edit") {
      this.editor?.focusActiveCellEditor?.();
    }
  }

  focusTargetEditor(target) {
    // Same suppression as focusTarget (inlined so focusActiveCellEditor is
    // also skipped when the cell was already focused immediately).
    if (this._preFocusedTargetId === target.id) {
      this._preFocusedTargetId = null;
      if (this.getActiveTargetId() === target.id) return;
    }
    this.setActiveTargetId(target.id);
    this.editor?.view?.clearSelection?.();
    this.editor?.view?.scrollToCell?.(target.id);
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
