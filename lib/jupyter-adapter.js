const VALID_OUTPUT_TYPES = new Set(["execute_result", "display_data", "stream", "error"]);
const INVALID_EXECUTION_TIMES = new Set(["", "No execution", "Running ...", "Not available"]);
const documentExecutions = new WeakMap();
const { Disposable } = require("lumine");
const tracebackNavigation = require("./traceback-navigation");
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
  if (editor?.document?.getCellIndexById) return editor.document.getCellIndexById(cellId);
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

function retireExecution(job, result = null) {
  if (!job.active) return;
  job.active = false;
  const { state, target, owner, cell } = job;
  state.activeJobs.delete(job);
  if (state.jobs.get(target) === job) {
    state.jobs.delete(target);
    state.startTimes.delete(target);
  }
  const count = state.runningCounts.get(cell) || 0;
  if (count > 1) state.runningCounts.set(cell, count - 1);
  else state.runningCounts.delete(cell);
  job.provenance?.dispose();
  if (owner.isDestroyed?.() || !owner.cells?.includes(cell)) return;
  if (count === 1) cell.clearRunning?.();
  if (
    !result ||
    owner.isDestroyed?.() ||
    !owner.cells?.includes(cell) ||
    (state.runningCounts.get(cell) || 0) !== Math.max(0, count - 1)
  )
    return;
  cell.setLastRunTime?.(
    performance.now() - job.startTime,
    result.lastExecutionTime && !INVALID_EXECUTION_TIMES.has(result.lastExecutionTime)
      ? result.lastExecutionTime
      : cell.lastRunTimeText,
  );
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

  beginTargetExecution(target, { kernel } = {}) {
    const cell = this.getTarget(target?.id);
    const owner = this.getKernelOwner();
    if (
      cell?.type !== "code" ||
      !owner ||
      owner.isDestroyed?.() ||
      kernel?.isDestroyed?.() ||
      kernel?.destroyed
    )
      return new Disposable();
    const state = this._getExecutionState();
    const job = {
      owner,
      cell,
      target,
      state,
      session: kernel,
      active: false,
      startTime: performance.now(),
      provenance: null,
    };
    let rollbackObservation;
    try {
      rollbackObservation = this._observeSession(kernel, state);
      job.provenance = tracebackNavigation.beginExecution(owner, target, kernel);
      if (owner.isDestroyed?.() || !owner.cells?.includes(cell)) {
        job.provenance?.dispose();
        rollbackObservation?.();
        return new Disposable();
      }
      job.active = true;
      state.jobs.set(target, job);
      state.activeJobs.add(job);
      state.startTimes.set(target, job.startTime);
      const count = state.runningCounts.get(cell) || 0;
      state.runningCounts.set(cell, count + 1);
      if (count === 0) cell.setRunning?.();
      return new Disposable(() => retireExecution(job));
    } catch (error) {
      try {
        retireExecution(job);
      } catch {
        /* Preserve the original registration failure. */
      }
      job.provenance?.dispose();
      rollbackObservation?.();
      throw error;
    }
  }

  resolveSourceFrame(frame, kernel) {
    return tracebackNavigation.resolveSourceFrame(this.editor, kernel, frame);
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
    tracebackNavigation.recordOutput(this.editor.document, target, output);
    updateRuntimeCellData(this.editor, () => {
      const cell = this.getTarget(target.id);
      if (cell?.type !== "code") return;
      cell.addOutput(output);
    });
  }

  setTargetExecutionCount(target, count) {
    tracebackNavigation.recordCount(this.editor.document, target, count);
    updateRuntimeCellData(this.editor, () => {
      const cell = this.getTarget(target?.id);
      if (cell?.type !== "code") return;
      cell.setExecutionCount(count);
    });
  }

  finishTargetExecution(target, result = {}) {
    const state = documentExecutions.get(this.getKernelOwner());
    const job = state?.jobs.get(target);
    if (job) retireExecution(job, result);
  }

  _getExecutionState() {
    const owner = this.getKernelOwner() || this.editor;
    let state = documentExecutions.get(owner);
    if (!state) {
      state = {
        startTimes: new WeakMap(),
        jobs: new WeakMap(),
        activeJobs: new Set(),
        runningCounts: new Map(),
        sessions: new WeakSet(),
        subscriptions: new Set(),
        session: null,
      };
      owner.onDidDestroy?.(() => {
        for (const job of state.activeJobs) {
          job.active = false;
          job.provenance?.dispose();
        }
        state.activeJobs.clear();
        state.runningCounts.clear();
        state.startTimes = new WeakMap();
        state.jobs = new WeakMap();
        state.session = null;
        for (const subscription of state.subscriptions) subscription.dispose();
        state.subscriptions.clear();
        documentExecutions.delete(owner);
      });
      documentExecutions.set(owner, state);
    }
    return state;
  }

  _observeSession(session, state) {
    if (!session) return;
    if (state.sessions.has(session)) {
      state.session = session;
      return;
    }
    const previousSession = state.session;
    state.session = session;
    const owner = this.getKernelOwner();
    const subscriptions = [];
    const keep = (subscription) => {
      if (!subscription) return;
      subscriptions.push(subscription);
      state.subscriptions.add(subscription);
    };
    const clear = () => {
      for (const job of [...state.activeJobs]) {
        if (job.session === session) retireExecution(job);
      }
      if (state.session === session && !state.activeJobs.size && !owner?.isDestroyed?.())
        owner?.clearAllCellTimers?.();
    };
    const release = () => {
      state.sessions.delete(session);
      for (const subscription of subscriptions) {
        subscription.dispose();
        state.subscriptions.delete(subscription);
      }
    };
    const rollback = () => {
      release();
      if (state.session === session) state.session = previousSession;
    };
    try {
      keep(
        session.onDidChangeExecutionState?.((status) => {
          if (["restarting", "autorestarting", "shutting-down", "dead"].includes(status)) clear();
        }),
      );
      keep(session.onDidChangeGeneration?.(clear));
      keep(
        session.onDidDestroy?.(() => {
          clear();
          if (state.session === session) state.session = null;
          release();
        }),
      );
      state.sessions.add(session);
      return rollback;
    } catch (error) {
      rollback();
      throw error;
    }
  }

  get _executionStartTimes() {
    return this._getExecutionState().startTimes;
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
