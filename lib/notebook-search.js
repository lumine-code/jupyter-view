/**
 * NotebookSearchAdapter - search-panel search adapter for the notebook.
 *
 * Consumed by search-panel through the search.adapter service. It
 * scans every cell's source for the query, highlights matches in the cells that
 * have editors, navigates across cells (scrolling / selecting / entering edit
 * mode for markdown), and replaces matches in place. The notebook is editable,
 * so canReplace is true.
 */

const { CompositeDisposable, Emitter, TextBuffer } = require("lumine");
const cellSource = require("./cell-source");

const RESCAN_DELAY = 150;

// Character offset -> { row, column } within text (LF-counted).
function offsetToPoint(text, offset) {
  if (typeof text.positionAt === "function") {
    const point = text.positionAt(Math.min(offset, text.length));
    return [point.row, point.column];
  }
  let row = 0;
  let lineStart = 0;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10) {
      row++;
      lineStart = i + 1;
    }
  }
  return [row, Math.min(offset, text.length) - lineStart];
}

// { row, column } -> character offset within text.
function pointToOffset(text, point) {
  if (typeof text.offsetAt === "function") return text.offsetAt(point);
  let offset = 0;
  let row = 0;
  for (let i = 0; i < text.length && row < point.row; i++) {
    if (text.charCodeAt(i) === 10) {
      row++;
      offset = i + 1;
    }
  }
  return offset + point.column;
}

// Minimal unescaping of a regex replacement string (mirrors find-and-replace's
// handling of \n, \t, \r, \\). $-style backreferences are handled by replace().
function unescapeReplacement(text) {
  return text.replace(/\\(.)/g, (_, ch) => {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      default:
        return ch;
    }
  });
}

class NotebookSearchAdapter {
  canReplace = true;

  constructor(notebookEditor) {
    this.notebookEditor = notebookEditor;
    this.emitter = new Emitter();
    this.matches = []; // ordered [{ cellIndex, start, end }]
    this.currentIndex = -1;
    this.test = null; // non-global regex (single match, for replace)
    this.global = null; // global regex (scanning)
    this.useRegex = false;
    this.layersByCellId = new Map(); // cellId -> { layer, decoration }
    this.disposables = new CompositeDisposable();
    this.scanDisposables = new CompositeDisposable();
    this.states = [];
    this.pending = false;
    this.resultCount = 0;
    this.asyncSearch = true;

    const document = notebookEditor.document;
    if (document && document.onDidChange) {
      this.disposables.add(
        document.onDidChange((event) => {
          if (event?.category === "history" && event.affectsSource !== false) {
            if (!this.publishing) {
              this.controller?.abort();
              this._scheduleRescan();
            }
          }
        }),
      );
    }
    this.disposables.add(
      lumine.workspace.onDidChangeActivePaneItem((item) => {
        if (item !== this.notebookEditor) {
          this.deactivate();
        }
      }),
    );
  }

  onDidUpdate(callback) {
    return this.emitter.on("did-update", callback);
  }

  onDidChangeCurrentResult(callback) {
    return this.emitter.on("did-change-current-result", callback);
  }

  onDidError(callback) {
    return this.emitter.on("did-error", callback);
  }

  // --- querying -------------------------------------------------------------

  search(findOptions) {
    const pattern = findOptions.findPattern;
    if (!pattern) {
      this.test = null;
      this.global = null;
      this.currentIndex = -1;
      this._scan();
      return;
    }
    let regex;
    try {
      regex = findOptions.getFindPatternRegex();
    } catch (e) {
      this.test = null;
      this.global = null;
      this.currentIndex = -1;
      this._scan();
      this.queryError = e;
      this.emitter.emit("did-error", e);
      return;
    }
    this.useRegex = Boolean(findOptions.useRegex);
    const base = regex.flags.replace("g", "");
    this.test = new RegExp(regex.source, base);
    this.global = new RegExp(regex.source, base.includes("g") ? base : base + "g");
    this.currentIndex = -1;
    return this._scan();
  }

  _scheduleRescan() {
    if (this._rescanTimer) clearTimeout(this._rescanTimer);
    this._rescanTimer = setTimeout(() => {
      this._rescanTimer = null;
      if (this.global) this._scan();
    }, RESCAN_DELAY);
  }

  _cells() {
    return (this.notebookEditor.document && this.notebookEditor.document.cells) || [];
  }

  // The visible text of a cell: its editor's text when one exists (so highlight
  // offsets line up with what's shown), otherwise the model source.
  _cellText(cell) {
    return this._cellEditor(cell)?.getBuffer?.().getTextSnapshot() ?? cellSource.forCell(cell);
  }

  _disposeScan() {
    this.controller?.abort();
    this.navigationController?.abort();
    this.replacementController?.abort();
    this.replacementController = null;
    this.scanDisposables?.dispose();
    this.scanDisposables = new CompositeDisposable();
    for (const state of this.states ?? []) if (state.owned) state.buffer.destroy();
    this.states = [];
  }

  _scan() {
    if (this.publishing) {
      this._scheduleRescan();
      return Promise.resolve(false);
    }
    if (this._rescanTimer) {
      clearTimeout(this._rescanTimer);
      this._rescanTimer = null;
    }
    this._disposeScan();
    const controller = new AbortController();
    this.controller = controller;
    this.matches = [];
    this.currentResult = null;
    this.currentIndex = -1;
    this.resultCount = 0;
    this.queryError = null;
    this.pending = Boolean(this.global);
    this._clearHighlights();
    this.emitter.emit("did-update");
    if (!this.global) return Promise.resolve();
    const cells = this._cells().slice();
    try {
      this.states = [];
      for (const [cellIndex, cell] of cells.entries()) {
        const mounted = this._cellEditor(cell)?.getBuffer?.();
        const buffer = mounted ?? new TextBuffer();
        if (!mounted) {
          buffer.setTextInRange(buffer.getRange(), cellSource.forCell(cell), {
            normalizeLineEndings: false,
          });
          buffer.clearUndoStack();
        }
        const state = {
          cell,
          cellIndex,
          buffer,
          owned: !mounted,
          source: buffer.getTextSnapshot(),
          revision: cell.sourceRevision,
          bufferRevision: buffer.getTextRevision(),
          count: 0,
          complete: false,
        };
        this.states.push(state);
        state.session = buffer.createSearch(this.global, { signal: controller.signal });
        if (mounted)
          this.scanDisposables.add(
            buffer.onDidChangeText(() => {
              if (!this.publishing) {
                controller.abort();
                this._scheduleRescan();
              }
            }),
          );
      }
    } catch (error) {
      this._disposeScan();
      this.queryError = error;
      this.pending = false;
      this.emitter.emit("did-update");
      this.emitter.emit("did-error", error);
      return Promise.resolve(false);
    }
    const states = this.states;
    const current = () => this.controller === controller && !controller.signal.aborted;
    this.scanPromise = (async () => {
      try {
        for (const state of states) {
          await state.session.collect({
            limit: 0,
            onProgress: ({ count, complete }) => {
              if (!current()) return;
              this.resultCount += count - state.count;
              state.count = count;
              state.complete = complete;
              this.emitter.emit("did-update");
            },
          });
          if (!current()) return false;
        }
        this.pending = false;
        if (this.currentResult?.index < 0) {
          const result = this.currentResult,
            state = states[result.cellIndex];
          const found = await state.session.findNear(result.start, {
            inclusive: true,
            allowLocal: false,
          });
          if (current() && this.currentResult === result && found?.start === result.start)
            result.index = found.index;
        }
        if (current()) {
          this.currentIndex = this._globalOrdinal(this.currentResult);
          this.emitter.emit("did-update");
        }
      } catch (error) {
        if (current()) {
          this.queryError = error;
          this.pending = false;
          this.resultCount = 0;
          controller.abort();
          this.emitter.emit("did-update");
          this.emitter.emit("did-error", error);
        }
      }
    })();
    return this.scanPromise;
  }

  _globalOrdinal(match) {
    if (!match || match.index < 0) return -1;
    let count = match.index;
    for (let i = 0; i < match.cellIndex; i++) {
      if (!this.states[i].complete) return -1;
      count += this.states[i].count;
    }
    return count;
  }

  isPending() {
    return this.pending;
  }

  dataChanged() {
    if (this.global) {
      return this._scan();
    } else {
      this.resultCount = 0;
      this.matches = [];
      this.currentIndex = -1;
      this._highlight();
      this.emitter.emit("did-update");
    }
  }

  // --- highlighting ---------------------------------------------------------

  _clearHighlights() {
    for (const entry of this.layersByCellId.values()) {
      try {
        entry.decoration?.destroy();
      } catch (e) {
        // decoration may already be gone
      }
      try {
        entry.layer?.clear?.();
        entry.layer?.destroy?.();
      } catch (e) {
        // editor/layer may already be gone
      }
    }
    this.layersByCellId.clear();
    this._clearEditorFindDecorations();
  }

  _clearEditorFindDecorations() {
    const view = this.notebookEditor.view;
    if (!view || !view.cellViews) return;
    for (const cellView of view.cellViews.values()) {
      const editor = cellView && cellView.editor;
      if (!editor || !editor.getDecorations) continue;
      let decorations;
      try {
        decorations = editor.getDecorations({ type: "highlight", class: "find-result" });
        if (decorations.length === 0) {
          decorations = editor.getDecorations().filter((decoration) => {
            const properties = decoration.getProperties?.() || {};
            return properties.type === "highlight" && properties.class === "find-result";
          });
        }
      } catch (e) {
        continue;
      }
      for (const decoration of decorations) {
        try {
          decoration.destroy();
        } catch (e) {
          // decoration may already be gone
        }
      }
    }
  }

  _highlight() {
    this._clearHighlights();
    const view = this.notebookEditor.view;
    if (!view || !view.cellViews) return;
    const cells = this._cells();
    const currentMatch =
      this.currentResult ||
      (this.currentIndex >= 0 && this.currentIndex < this.matches.length
        ? this.matches[this.currentIndex]
        : null);
    if (!currentMatch) return;

    const byCell = new Map();
    byCell.set(currentMatch.cellIndex, [currentMatch]);

    for (const [ci, cellMatches] of byCell) {
      const cell = cells[ci];
      const cellView = cell && view.cellViews.get(cell.id);
      const editor = cellView && cellView.editor;
      if (!editor) continue; // rendered markdown: no inline highlight
      try {
        const text = editor.getBuffer().getTextSnapshot();
        const layer = editor.addMarkerLayer();
        for (const m of cellMatches) {
          layer.markBufferRange([offsetToPoint(text, m.start), offsetToPoint(text, m.end)], {
            invalidate: "inside",
          });
        }
        const decoration = editor.decorateMarkerLayer(layer, {
          type: "highlight",
          class: "find-result",
        });
        this.layersByCellId.set(cell.id, { layer, decoration });
      } catch (e) {
        // ignore highlight failures for a cell; navigation still works
      }
    }
  }

  // --- navigation -----------------------------------------------------------

  getResultCount() {
    return this.asyncSearch ? this.resultCount : this.matches.length;
  }

  getCurrentResultIndex() {
    return this.currentIndex;
  }

  _compare(match, anchor) {
    return match.cellIndex - anchor.cellIndex || match.start - anchor.offset;
  }

  _anchor() {
    const cells = this._cells();
    const editor = this.notebookEditor;
    const idx = Math.min(Math.max(editor.activeCellIndex || 0, 0), Math.max(cells.length - 1, 0));
    const cell = cells[idx];
    const view = editor.view;
    const cellView = cell && view && view.cellViews && view.cellViews.get(cell.id);
    let offset = -1; // before the first cell's start, so "next" can hit start 0
    if (cellView && cellView.editor) {
      offset = pointToOffset(
        cellView.editor.getBuffer().getTextSnapshot(),
        cellView.editor.getCursorBufferPosition(),
      );
    }
    return { cellIndex: idx, offset };
  }

  selectNext(options) {
    if (this.asyncSearch) return this._navigate(false, false, options);
    if (this.matches.length === 0) return { found: false, wrapped: null };
    const anchor = this._anchor();
    let index = this.matches.findIndex((m) => this._compare(m, anchor) > 0);
    let wrapped = null;
    if (index === -1) {
      index = 0;
      wrapped = "up";
    }
    return this._reveal(index, wrapped, options);
  }

  selectFirstFromCursor(options) {
    if (this.asyncSearch) return this._navigate(false, true, options);
    if (this.matches.length === 0) return { found: false, wrapped: null };
    const anchor = this._anchor();
    let index = this.matches.findIndex((m) => this._compare(m, anchor) >= 0);
    let wrapped = null;
    if (index === -1) {
      index = 0;
      wrapped = "up";
    }
    return this._reveal(index, wrapped, options);
  }

  selectPrevious(options) {
    if (this.asyncSearch) return this._navigate(true, false, options);
    if (this.matches.length === 0) return { found: false, wrapped: null };
    const anchor = this._anchor();
    let index = -1;
    for (let i = this.matches.length - 1; i >= 0; i--) {
      if (this._compare(this.matches[i], anchor) < 0) {
        index = i;
        break;
      }
    }
    let wrapped = null;
    if (index === -1) {
      index = this.matches.length - 1;
      wrapped = "down";
    }
    return this._reveal(index, wrapped, options);
  }

  selectAll(options) {
    if (this.asyncSearch) return this._navigate(false, true, options, { cellIndex: 0, offset: -1 });
    if (this.matches.length === 0) return { found: false, wrapped: null };
    return this._reveal(0, null, options);
  }

  async _navigate(backwards, inclusive, options, anchor = this._anchor()) {
    this.navigationController?.abort();
    const controller = new AbortController();
    this.navigationController = controller;
    const query = this.controller,
      states = this.states;
    if (!query || query.signal.aborted || !states.length) return { found: false, wrapped: null };
    try {
      for (let step = 0; step <= states.length; step++) {
        const index =
          (anchor.cellIndex + (backwards ? -step : step) + states.length) % states.length;
        const state = states[index];
        const offset = step === 0 ? anchor.offset : backwards ? state.source.length + 1 : -1;
        const session = state.session.withSignal(controller.signal);
        const match = await session.findNear(offset, {
          backwards,
          inclusive: step === 0 ? inclusive : true,
        });
        if (this.controller !== query || query.signal.aborted || controller.signal.aborted)
          return { found: false, wrapped: null };
        if (match) {
          this._clearSearchSelections();
          this.matches = [{ ...match, cellIndex: index }];
          this.currentResult = this.matches[0];
          const wrapped = backwards
            ? index > anchor.cellIndex || step === states.length
              ? "down"
              : null
            : index < anchor.cellIndex || step === states.length
              ? "up"
              : null;
          return this._reveal(0, wrapped, options);
        }
      }
      return { found: false, wrapped: null };
    } catch (error) {
      if (error.name !== "AbortError" && this.controller === query && !query.signal.aborted)
        this.emitter.emit("did-error", error);
      return { found: false, wrapped: null };
    }
  }

  _reveal(index, wrapped, { mode = "zone" } = {}) {
    this._clearSearchSelections();
    this._clearHighlights();
    const match = this.matches[index];
    this.currentIndex = this.asyncSearch ? this._globalOrdinal(match) : index;
    const cells = this._cells();
    const cell = cells[match.cellIndex];
    const editor = this.notebookEditor;
    const view = editor.view;

    editor.setActiveCell(match.cellIndex);
    if (view) {
      view.setMode("edit");
      view.scrollToCell(match.cellIndex);
      const cellView = view.cellViews.get(cell.id);
      this._highlight(); // editors may have been re-created by the mode change
      if (cellView && cellView.editor) {
        const text = cellView.editor.getBuffer().getTextSnapshot();
        cellView.editor.setSelectedBufferRange(
          [offsetToPoint(text, match.start), offsetToPoint(text, match.end)],
          { flash: true, autoscroll: false },
        );
        cellView.editor.scrollToCursorPosition({ mode });
        cellView.focus();
      }
    }

    this.emitter.emit("did-change-current-result", this.currentIndex);
    return { found: true, wrapped };
  }

  // --- replace --------------------------------------------------------------

  _cellEditor(cell) {
    const view = this.notebookEditor.view;
    const cellView = view && cell && view.cellViews && view.cellViews.get(cell.id);
    return cellView ? cellView.editor : null;
  }

  async replaceCurrentMatch(replaceText, direction = "next") {
    if (!this.global) return 0;
    if (this.controller?.signal.aborted) this._scan();
    if (!this.currentResult) {
      const result = await this._navigate(direction === "previous", true);
      if (!result.found) return 0;
    }
    return this._replacePrepared(replaceText, this.currentResult);
  }

  replaceAll(replaceText) {
    return this._replacePrepared(replaceText);
  }

  async _replacePrepared(replaceText, onlyMatch) {
    if (!this.global) return 0;
    const expression = this.global;
    const operationCells = this._cells().slice();
    const previousStates = operationCells.map((cell) => {
      const buffer = this._cellEditor(cell)?.getBuffer?.();
      return {
        cell,
        buffer,
        revision: cell.sourceRevision,
        bufferRevision: buffer?.getTextRevision(),
      };
    });
    await this.notebookEditor.sourceController?.flushPendingChanges(this.notebookEditor);
    if (
      this.global !== expression ||
      this._cells().length !== operationCells.length ||
      previousStates.some(
        (state, index) =>
          this._cells()[index] !== state.cell ||
          (state.buffer
            ? state.buffer.getTextRevision() !== state.bufferRevision
            : state.cell.sourceRevision !== state.revision),
      )
    )
      throw Object.assign(new Error("Notebook search changed"), { name: "AbortError" });
    this._scan();
    if (this.queryError) throw this.queryError;
    const query = this.controller,
      states = this.states,
      cells = this._cells().slice();
    const controller = new AbortController();
    this.replacementController = controller;
    // Replacement performs its own complete scan. Do not count the same huge
    // source concurrently, and never derive replacements from a marker list.
    query.abort();
    this.pending = true;
    const plans = [],
      updates = [];
    const isCurrent = () =>
      this.controller === query &&
      !controller.signal.aborted &&
      this.global === expression &&
      !this.notebookEditor._destroyed &&
      this._cells().length === cells.length &&
      states.every(
        (state, index) =>
          this._cells()[index] === state.cell &&
          state.cell.sourceRevision === state.revision &&
          state.buffer.getTextRevision() === state.bufferRevision,
      );
    try {
      for (const state of states) {
        if (onlyMatch && onlyMatch.cellIndex !== state.cellIndex) continue;
        if (!isCurrent())
          throw Object.assign(new Error("Notebook source changed while preparing replacement"), {
            name: "AbortError",
          });
        const plan = await state.buffer.prepareReplaceAllMatches(
          expression,
          this.useRegex ? unescapeReplacement(replaceText) : replaceText,
          {
            signal: controller.signal,
            literalReplacement: !this.useRegex,
            ...(onlyMatch ? { onlyMatch: { start: onlyMatch.start, end: onlyMatch.end } } : {}),
          },
        );
        plans.push(plan);
        if (plan.count) updates.push({ index: state.cellIndex, source: plan.snapshot });
      }
      this.publishing = true;
      return this.notebookEditor.document.withSourcePublicationLock((publicationToken) =>
        TextBuffer.commitPreparedReplacements(plans, {
          signal: controller.signal,
          isCurrent,
          didCommit: () =>
            this.notebookEditor.document.updateCellSources(updates, this.notebookEditor, {
              publicationToken,
            }),
        }),
      );
    } finally {
      this.publishing = false;
      for (const plan of plans) plan.dispose();
      if (this.replacementController === controller) {
        this.replacementController = null;
        this._scan();
      }
    }
  }

  // --- selection helpers ----------------------------------------------------

  _activeEditor() {
    const cells = this._cells();
    const editor = this.notebookEditor;
    const cell = cells[editor.activeCellIndex || 0];
    const view = editor.view;
    const cellView = cell && view && view.cellViews && view.cellViews.get(cell.id);
    return cellView ? cellView.editor : null;
  }

  hasSelectionMatchingResult() {
    const active = this._activeEditor();
    if (!active) return false;
    const range = active.getSelectedBufferRange();
    if (range.isEmpty()) return false;
    const text = active.getBuffer().getTextSnapshot();
    const start = pointToOffset(text, range.start);
    const end = pointToOffset(text, range.end);
    const idx = this.notebookEditor.activeCellIndex || 0;
    return this.matches.some((m) => m.cellIndex === idx && m.start === start && m.end === end);
  }

  _clearSearchSelection() {
    const active = this._activeEditor();
    if (!active) return;
    const range = active.getSelectedBufferRange();
    if (range.isEmpty()) return;
    if (!this.hasSelectionMatchingResult()) return;

    active.setCursorBufferPosition(range.end, { autoscroll: false });
  }

  _clearSearchSelections() {
    const view = this.notebookEditor.view;
    if (!view || !view.cellViews) return;
    const cells = this._cells();
    for (const [cellId, cellView] of view.cellViews) {
      const editor = cellView && cellView.editor;
      if (!editor) continue;
      const range = editor.getSelectedBufferRange();
      if (!range || range.isEmpty()) continue;
      const cellIndex = cells.findIndex((cell) => cell && cell.id === cellId);
      if (cellIndex < 0) continue;
      const text = editor.getBuffer().getTextSnapshot();
      const start = pointToOffset(text, range.start);
      const end = pointToOffset(text, range.end);
      const isSearchSelection = this.matches.some(
        (m) => m.cellIndex === cellIndex && m.start === start && m.end === end,
      );
      if (isSearchSelection) {
        editor.setCursorBufferPosition(range.end, { autoscroll: false });
      }
    }
  }

  isSelectionEmpty() {
    const active = this._activeEditor();
    return active ? active.getSelectedBufferRange().isEmpty() : true;
  }

  getBuffer() {
    return this._activeEditor()?.getBuffer();
  }

  getSelectedBufferRange() {
    return this._activeEditor()?.getSelectedBufferRange();
  }

  getCursorBufferPosition() {
    return this._activeEditor()?.getCursorBufferPosition();
  }

  getSelectedText() {
    const active = this._activeEditor();
    return active && active.getSelectedText ? active.getSelectedText() : "";
  }

  getWordUnderCursor() {
    const active = this._activeEditor();
    return active && active.getWordUnderCursor ? active.getWordUnderCursor() : "";
  }

  getWrapIconHost() {
    const view = this.notebookEditor.view;
    return view && view.element ? view.element : null;
  }

  // Clear matches/highlights when the notebook is no longer the active search
  // target (e.g. focus moved to another pane).
  deactivate() {
    this._disposeScan();
    this.pending = false;
    this.resultCount = 0;
    this.currentResult = null;
    if (this._rescanTimer) {
      clearTimeout(this._rescanTimer);
      this._rescanTimer = null;
    }
    this._clearSearchSelection();
    this.test = null;
    this.global = null;
    this.matches = [];
    this.currentIndex = -1;
    this._clearHighlights();
  }

  destroy() {
    this._disposeScan();
    if (this._rescanTimer) {
      clearTimeout(this._rescanTimer);
      this._rescanTimer = null;
    }
    this.disposables.dispose();
    this._clearHighlights();
    this.emitter.dispose();
  }
}

module.exports = NotebookSearchAdapter;
