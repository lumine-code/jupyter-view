/**
 * NotebookSearchAdapter - search-panel search adapter for the notebook.
 *
 * Consumed by search-panel through the search.adapter service. It
 * scans every cell's source for the query, highlights matches in the cells that
 * have editors, navigates across cells (scrolling / selecting / entering edit
 * mode for markdown), and replaces matches in place. The notebook is editable,
 * so canReplace is true.
 */

const { CompositeDisposable, Emitter } = require("lumine");

const RESCAN_DELAY = 150;

function normalizeSource(source) {
  if (Array.isArray(source)) return source.join("");
  return source == null ? "" : String(source);
}

// Character offset -> { row, column } within text (LF-counted).
function offsetToPoint(text, offset) {
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

    const document = notebookEditor.document;
    if (document && document.onDidChange) {
      this.disposables.add(
        document.onDidChange((event) => {
          if (event?.category === "history" && event.affectsSource !== false) {
            this._scheduleRescan();
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
      this.emitter.emit("did-error", e);
      this._scan();
      return;
    }
    this.useRegex = Boolean(findOptions.useRegex);
    const base = regex.flags.replace("g", "");
    this.test = new RegExp(regex.source, base);
    this.global = new RegExp(regex.source, base.includes("g") ? base : base + "g");
    this.currentIndex = -1;
    this._scan();
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
    const view = this.notebookEditor.view;
    const cellView = view && cell && view.cellViews && view.cellViews.get(cell.id);
    if (cellView && cellView.editor) return cellView.editor.getText();
    return normalizeSource(cell && cell.source);
  }

  _scan() {
    const cells = this._cells();
    const matches = [];
    if (this.global) {
      for (let ci = 0; ci < cells.length; ci++) {
        const text = this._cellText(cells[ci]);
        this.global.lastIndex = 0;
        let m;
        while ((m = this.global.exec(text)) !== null) {
          if (m[0].length === 0) {
            this.global.lastIndex++; // avoid an infinite loop on empty matches
            continue;
          }
          matches.push({ cellIndex: ci, start: m.index, end: m.index + m[0].length });
        }
      }
    }
    this.matches = matches;
    if (this.currentIndex >= matches.length) {
      this.currentIndex = matches.length - 1;
    }
    this._highlight();
    this.emitter.emit("did-update");
  }

  dataChanged() {
    if (this.global) {
      this._scan();
    } else {
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
      this.currentIndex >= 0 && this.currentIndex < this.matches.length
        ? this.matches[this.currentIndex]
        : null;
    if (!currentMatch) return;

    const byCell = new Map();
    byCell.set(currentMatch.cellIndex, [currentMatch]);

    for (const [ci, cellMatches] of byCell) {
      const cell = cells[ci];
      const cellView = cell && view.cellViews.get(cell.id);
      const editor = cellView && cellView.editor;
      if (!editor) continue; // rendered markdown: no inline highlight
      try {
        const text = editor.getText();
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
    return this.matches.length;
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
      offset = pointToOffset(cellView.editor.getText(), cellView.editor.getCursorBufferPosition());
    }
    return { cellIndex: idx, offset };
  }

  selectNext() {
    if (this.matches.length === 0) return { found: false, wrapped: null };
    const anchor = this._anchor();
    let index = this.matches.findIndex((m) => this._compare(m, anchor) > 0);
    let wrapped = null;
    if (index === -1) {
      index = 0;
      wrapped = "up";
    }
    return this._reveal(index, wrapped);
  }

  selectFirstFromCursor() {
    if (this.matches.length === 0) return { found: false, wrapped: null };
    const anchor = this._anchor();
    let index = this.matches.findIndex((m) => this._compare(m, anchor) >= 0);
    let wrapped = null;
    if (index === -1) {
      index = 0;
      wrapped = "up";
    }
    return this._reveal(index, wrapped);
  }

  selectPrevious() {
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
    return this._reveal(index, wrapped);
  }

  selectAll() {
    if (this.matches.length === 0) return { found: false, wrapped: null };
    return this._reveal(0, null);
  }

  _reveal(index, wrapped) {
    this._clearSearchSelections();
    this._clearHighlights();
    this.currentIndex = index;
    const match = this.matches[index];
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
        const text = cellView.editor.getText();
        cellView.editor.setSelectedBufferRange(
          [offsetToPoint(text, match.start), offsetToPoint(text, match.end)],
          { flash: true },
        );
        cellView.focus();
      }
    }

    this.emitter.emit("did-change-current-result", index);
    return { found: true, wrapped };
  }

  // --- replace --------------------------------------------------------------

  _computeReplacement(matched, replaceText) {
    if (this.useRegex && this.test) {
      return matched.replace(this.test, unescapeReplacement(replaceText));
    }
    return replaceText;
  }

  _cellEditor(cell) {
    const view = this.notebookEditor.view;
    const cellView = view && cell && view.cellViews && view.cellViews.get(cell.id);
    return cellView ? cellView.editor : null;
  }

  // Apply the given cell's matches. Editing the editor buffer in place (when one
  // exists) keeps editor.getText() correct for the synchronous re-scan that
  // follows; rendered-markdown cells fall back to the model source.
  _replaceInCell(cellIndex, cellMatches, replaceText) {
    const cell = this._cells()[cellIndex];
    const editor = this._cellEditor(cell);
    if (editor) {
      const text = editor.getText();
      editor.transact(() => {
        // Last to first so earlier buffer positions stay valid.
        for (let i = cellMatches.length - 1; i >= 0; i--) {
          const m = cellMatches[i];
          const replacement = this._computeReplacement(text.slice(m.start, m.end), replaceText);
          editor.setTextInBufferRange(
            [offsetToPoint(text, m.start), offsetToPoint(text, m.end)],
            replacement,
          );
        }
      });
    } else {
      let src = normalizeSource(cell.source);
      for (let i = cellMatches.length - 1; i >= 0; i--) {
        const m = cellMatches[i];
        const replacement = this._computeReplacement(src.slice(m.start, m.end), replaceText);
        src = src.slice(0, m.start) + replacement + src.slice(m.end);
      }
      this.notebookEditor.document.updateCellSource(cellIndex, src, this.notebookEditor);
    }
  }

  replaceCurrentMatch(replaceText, direction) {
    if (this.matches.length === 0) return;
    let index = this.currentIndex;
    if (index < 0 || index >= this.matches.length) {
      const anchor = this._anchor();
      if (direction === "previous") {
        for (let i = this.matches.length - 1; i >= 0; i--) {
          if (this._compare(this.matches[i], anchor) < 0) {
            index = i;
            break;
          }
        }
        if (index < 0) index = this.matches.length - 1;
      } else {
        index = this.matches.findIndex((m) => this._compare(m, anchor) >= 0);
        if (index < 0) index = 0;
      }
    }
    const match = this.matches[index];
    this._replaceInCell(match.cellIndex, [match], replaceText);
    this.currentIndex = -1;
    this._scan();
  }

  replaceAll(replaceText) {
    if (this.matches.length === 0) return;
    const byCell = new Map();
    for (const m of this.matches) {
      if (!byCell.has(m.cellIndex)) byCell.set(m.cellIndex, []);
      byCell.get(m.cellIndex).push(m);
    }
    for (const [ci, cellMatches] of byCell) {
      this._replaceInCell(ci, cellMatches, replaceText);
    }
    this.currentIndex = -1;
    this._scan();
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
    const text = active.getText();
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
      const text = editor.getText();
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
