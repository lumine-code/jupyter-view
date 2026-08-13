/** @jsx etch.dom */
/**
 * CellView - one notebook cell: its gutter, its input and its outputs.
 */

const etch = require("@lumine-code/etch");
const { CompositeDisposable } = require("lumine");
const OutputView = require("./output-view");
const { renderMarkdown } = require("./markdown");
const { getGrammarScopesForLanguage, languageIdForGrammar } = require("./notebook-language");

// The cell's own language id, when a grammar was picked for it explicitly.
// Read straight off the metadata so plain cell snapshots work too.
function cellLanguageOf(cell) {
  return cell?.metadata?.vscode?.languageId || null;
}

function resolveGrammar(targetScopes) {
  for (const scope of targetScopes || []) {
    const grammar = lumine.grammars.grammarForScopeName(scope);
    if (grammar) return grammar;
  }
  return null;
}

// MIME type tagging the cell-reorder drag payload, so external file/text drops
// (which carry a text/plain path) are ignored instead of failing JSON.parse.
const CELL_DRAG_MIME = "application/x-jupyter-cell";

// Output types worth showing; the rest (status, execute_input) are protocol
// bookkeeping.
const DISPLAYABLE_OUTPUTS = new Set(["stream", "execute_result", "display_data", "error"]);

/**
 * Hosts the cell's TextEditor element.
 *
 * A TextEditor element is not ours to rebuild — it carries the buffer, the
 * cursor and the selection — so it is attached once here and this component
 * never renders anything into itself again. Etch then moves the whole host when
 * cells are reordered, rather than recreating the editor inside it.
 */
class EditorHost {
  constructor(props) {
    this.props = props;
    etch.initialize(this);
    this.attach();
  }

  attach() {
    const element = this.props.editorElement;
    if (element && element.parentNode !== this.element) {
      this.element.appendChild(element);
    }
  }

  render() {
    const max = lumine.config.get("jupyter-view.input.maxHeight");
    const style = max > 0 ? { maxHeight: `${max}px`, overflowY: "auto" } : {};
    return <div className="cell-editor-container" style={style} />;
  }

  update(props) {
    this.props = props;
    // Attach now rather than after the update: the host's own markup does not
    // depend on the editor, and a caller that renders synchronously must see
    // the editor in the tree without waiting for a frame.
    this.attach();
    return etch.update(this);
  }

  destroy() {
    // The editor outlives this host: the cell owns it and decides when it goes.
    const element = this.props.editorElement;
    if (element && element.parentNode === this.element) {
      element.remove();
    }
    return etch.destroy(this);
  }
}

class CellView {
  constructor(props) {
    this.props = props;
    this.editorElement = null;
    this.editor = null;
    this._lastKnownSource = props.cell ? props.cell.source : "";
    this._lastKnownType = props.cell ? props.cell.type : "code"; // Track cell type for change detection
    this._lastKnownLanguage = this.grammarLanguage();
    this._editorIsDirty = false; // Track if editor has unsaved changes
    this._updatingFromExternal = false; // Guard against feedback loops when syncing from other editors
    this._localChangeSourceRevision = null;
    this._tooltips = new CompositeDisposable();
    this._tooltipTargets = new WeakSet();

    etch.initialize(this);
    this.setupEditor();
    // The editor is built after the first render, so the host has to be told
    // about it once it exists.
    etch.updateSync(this);

    this._maxInputHeightDisposable = lumine.config.observe("jupyter-view.input.maxHeight", () => {
      etch.update(this);
    });
    this._maxOutputHeightDisposable = lumine.config.observe("jupyter-view.output.maxHeight", () => {
      etch.update(this);
    });
  }

  isMarkdownRendered(cell, active, mode) {
    if (!cell || cell.type !== "markdown") return false;
    return !active || mode !== "edit";
  }

  get showsEditor() {
    return !this.isMarkdownRendered(this.props.cell, this.props.active, this.props.mode);
  }

  getCellClasses() {
    const { cell, active, selected } = this.props;
    return [
      "jupyter-cell",
      `jupyter-cell-${cell.type}`,
      active ? "active" : "",
      selected ? "selected" : "",
      cell.status === "running" ? "running" : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  getExecutionCountText() {
    const { cell } = this.props;
    if (cell.status === "running") return "[*]";
    if (cell.executionCount) return `[${cell.executionCount}]`;
    return "";
  }

  displayableOutputs() {
    const { cell } = this.props;
    if (cell.type !== "code" || cell.outputVisible === false) return [];
    return (cell.outputs || []).filter((output) => DISPLAYABLE_OUTPUTS.has(output.output_type));
  }

  // A click anywhere in the rendered markdown puts the cell into edit mode,
  // unless it landed on something interactive.
  handleMarkdownClick = (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target.closest("a, button, input, select, textarea, label")) return;

    event.stopPropagation();
    if (this.props.onCellSelect) this.props.onCellSelect(event);
    if (this.props.onFocus) this.props.onFocus();
    if (this.props.onEnterEditMode) this.props.onEnterEditMode();
  };

  handleClick = (event) => {
    // Clicks inside the editor mean editing, not selecting.
    if (event.target.closest("lumine-text-editor")) return;
    if (this.props.onCellSelect) this.props.onCellSelect(event);
  };

  runCell = (event) => {
    event.stopPropagation();
    const { editor, index } = this.props;
    if (!editor) return;
    editor.setActiveCell(index);
    lumine.commands.dispatch(editor.view?.element || this.element, "jupyter-repl:run-cell");
  };

  clearOutput = (event) => {
    event.stopPropagation();
    if (this.props.editor) this.props.editor.clearOutputAt(this.props.index);
  };

  deleteCell = (event) => {
    event.stopPropagation();
    if (this.props.editor) this.props.editor.deleteCellAt(this.props.index);
  };

  renderGutter() {
    const { cell, index } = this.props;
    const isCode = cell.type === "code";

    return (
      <div
        className={cell.status === "running" ? "cell-gutter running" : "cell-gutter"}
        draggable={true}
        onDragStart={this.handleDragStart}
        onDragEnd={this.handleDragEnd}
      >
        <div className="cell-prompt">
          {isCode ? <span className="execution-count">{this.getExecutionCountText()}</span> : null}
          <div className="cell-number">{String(index + 1)}</div>
        </div>
        {/* Code cells say what they are with their execution count. */}
        {isCode ? null : (
          <div className="cell-type-indicator">{cell.type === "markdown" ? "md" : "raw"}</div>
        )}
        {/* The last completed run's duration; static, there is no live timer. */}
        {isCode ? <div className="cell-timer">{this.getRunTimeText(cell)}</div> : null}
      </div>
    );
  }

  renderInput() {
    const { cell } = this.props;
    const style = cell.inputVisible === false ? { display: "none" } : {};

    return (
      <div className="cell-input" style={style}>
        {this.showsEditor ? (
          <EditorHost ref="editorHost" editorElement={this.editorElement} />
        ) : (
          <div
            className="markdown-rendered"
            innerHTML={renderMarkdown(cell.source)}
            onClick={this.handleMarkdownClick}
          />
        )}
      </div>
    );
  }

  renderActions() {
    const isCode = this.props.cell.type === "code";
    return (
      <div className="cell-actions">
        {isCode ? (
          <button
            className="btn btn-xs icon icon-playback-play"
            ref="runButton"
            onClick={this.runCell}
          />
        ) : null}
        {isCode ? (
          <button
            className="btn btn-xs icon icon-remove-close"
            ref="clearButton"
            onClick={this.clearOutput}
          />
        ) : null}
        <button
          className="btn btn-xs icon icon-trashcan"
          ref="deleteButton"
          onClick={this.deleteCell}
        />
      </div>
    );
  }

  render() {
    const outputs = this.displayableOutputs();

    return (
      <div
        className={this.getCellClasses()}
        attributes={{ "data-cell-id": this.props.cell.id }}
        onClick={this.handleClick}
        onDragOver={this.handleDragOver}
        onDragEnter={this.handleDragEnter}
        onDragLeave={this.handleDragLeave}
        onDrop={this.handleDrop}
      >
        {this.renderGutter()}
        <div className="cell-content">
          {this.renderInput()}
          {outputs.length > 0 ? (
            <div className="cell-output-container">
              <OutputView
                ref="outputView"
                outputs={outputs}
                maxHeight={lumine.config.get("jupyter-view.output.maxHeight")}
              />
            </div>
          ) : null}
        </div>
        {this.renderActions()}
      </div>
    );
  }

  // Tooltips attach to elements the diff keeps across updates, so each one is
  // registered once for the element it is on.
  readAfterUpdate() {
    this.addTooltip(this.refs.runButton, {
      title: "Run Cell",
      keyBindingCommand: "jupyter-repl:run-cell",
    });
    this.addTooltip(this.refs.clearButton, {
      title: "Clear Output",
      keyBindingCommand: "jupyter-view:clear-output",
    });
    this.addTooltip(this.refs.deleteButton, {
      title: "Delete Cell",
      keyBindingCommand: "jupyter-view:delete-cell",
    });
  }

  addTooltip(element, options) {
    if (!element || this._tooltipTargets.has(element)) return;
    this._tooltipTargets.add(element);
    this._tooltips.add(lumine.tooltips.add(element, options));
  }

  get outputView() {
    return this.refs.outputView || null;
  }

  get editorContainer() {
    return this.refs.editorHost ? this.refs.editorHost.element : null;
  }

  setupEditor() {
    const { cell, active, mode } = this.props;

    // Don't set up editor for rendered markdown
    if (this.isMarkdownRendered(cell, active, mode)) {
      return;
    }

    // Already built; the host re-attaches it after each render.
    if (this.editor && this.editorElement) return;

    // Create a text editor
    this.editor = lumine.workspace.buildTextEditor({
      mini: false,
      lineNumberGutterVisible: true,
      autoHeight: true,
    });

    this.editor.setText(cell.source);

    // Apply syntax highlighting grammar
    this.applyGrammar();

    // Get the editor element
    this.editorElement = lumine.views.getView(this.editor);
    this.editorElement.classList.add("jupyter-cell-editor");

    // Register with Lumine's global text editor registry so packages
    // (linters, formatters, etc.) and lumine.textEditors.observe() see this
    // editor. The "fragment" role marks it as a piece of the notebook, so
    // autocomplete shares words across cells and open documents.
    this.editorRegistryDisposable = lumine.textEditors.add(this.editor, { role: "fragment" });

    // Render-only linter registration: no provider ever lints a cell editor
    // (the notebook is checked through the source editor and the language
    // servers), but its buffer needs the linter's marker layers so projected
    // diagnostics draw squiggles and answer hover inside the cell.
    this.linterRegistration = require("./linter-editors").addLinterEditor(this.editor, {
      lint: false,
    });

    // Cell editors aren't workspace pane items, so autocomplete has to be
    // asked to watch them explicitly (cleaned up on editor destroy)
    require("./autocomplete-watch").watchCellEditor(this.editor);

    // A grammar assigned from outside — the grammar selector — becomes the
    // cell's own language; applyGrammar's assignments are guarded off.
    this.editorGrammarSubscription = this.editor.onDidChangeGrammar(() => {
      if (this._applyingGrammar) return;
      this.handleGrammarAssignment();
    });

    // Scroll to cursor position on any cursor activity (typing, arrow keys, clicks)
    this.editorCursorSubscription = this.editor.onDidChangeCursorPosition(() => {
      const { notebookView, index } = this.props;
      if (notebookView) {
        notebookView.scrollToCursor(index, this.editor);
      }
    });

    // Listen for changes - track dirty state to avoid race conditions
    this.editorChangeSubscription = this.editor.onDidChange(() => {
      this._editorIsDirty = true;
      if (!this._updatingFromExternal && this._localChangeSourceRevision === null) {
        this._localChangeSourceRevision = this.props.cellSourceRevision || 0;
      }
    });

    this.editorSubscription = this.editor.onDidStopChanging(() => {
      // Don't trigger source change if we're updating from external source
      if (this._updatingFromExternal) {
        this._updatingFromExternal = false;
        this._editorIsDirty = false;
        this._localChangeSourceRevision = null;
        return;
      }
      const source = this.editor.getText();
      const modelSource = this.props.cell?.source || "";
      const currentSourceRevision = this.props.cellSourceRevision || 0;
      const localChangeSourceRevision = this._localChangeSourceRevision;
      this._localChangeSourceRevision = null;

      if (
        localChangeSourceRevision !== null &&
        localChangeSourceRevision !== currentSourceRevision &&
        source !== modelSource
      ) {
        this._updatingFromExternal = true;
        const position = this.editor.getCursorBufferPosition();
        this.editor.setText(modelSource);
        this.editor.setCursorBufferPosition(position);
        this._lastKnownSource = modelSource;
        this._editorIsDirty = false;
        return;
      }
      // Only trigger source change if the source actually changed from last known
      const sourceChanged = source !== this._lastKnownSource;
      this._lastKnownSource = source;
      this._editorIsDirty = false;
      if (sourceChanged && this.props.onSourceChange) {
        this.props.onSourceChange(source);
      }
    });

    // Handle click on editor to enter edit mode and focus
    this.editorElement.addEventListener("mousedown", () => {
      if (this.props.onFocus) this.props.onFocus();
      if (this.props.onEnterEditMode) this.props.onEnterEditMode();
    });

    // Handle cursor movement for cell navigation
    this.setupCellNavigation();

    // Editors are created and destroyed as cells change type or markdown flips
    // between rendered and editable; consumers following the notebook's cell
    // editors — the language-server bridge — hear about it here.
    this.props.editor?.notifyCellEditorChange?.(cell.id, this.editor);
  }

  /**
   * Set up keyboard navigation between cells when cursor is at first/last row
   */
  setupCellNavigation() {
    if (!this.editorElement) return;

    this.editorElement.addEventListener("keydown", (e) => {
      // Only handle arrow keys
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;

      // Don't interfere with selection or modified keys
      if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;

      const cursor = this.editor.getCursorBufferPosition();
      const lastRow = this.editor.getLastBufferRow();

      if (e.key === "ArrowUp" && cursor.row === 0) {
        // Cursor is on first row and trying to move up
        if (this.props.onNavigateToPreviousCell) {
          e.preventDefault();
          e.stopPropagation();
          this.props.onNavigateToPreviousCell();
        }
      } else if (e.key === "ArrowDown" && cursor.row === lastRow) {
        // Cursor is on last row and trying to move down
        if (this.props.onNavigateToNextCell) {
          e.preventDefault();
          e.stopPropagation();
          this.props.onNavigateToNextCell();
        }
      }
    });
  }

  handleDragStart(event) {
    const { cell, index, notebookView, editor } = this.props;

    // Get selected cells from notebook view, or just use this cell's index
    let selectedIndices = [index];
    if (notebookView) {
      const selected = notebookView.getSelectedCells();
      if (selected.length > 0 && selected.includes(index)) {
        // Current cell is in selection, drag all selected cells
        selectedIndices = selected;
      } else {
        // Current cell is not in selection - replace selection with just this cell
        notebookView.clearSelection();
        notebookView.extendSelection(index);
        if (editor) editor.setActiveCell(index);
        selectedIndices = [index];
      }
    }

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      CELL_DRAG_MIME,
      JSON.stringify({
        cellId: cell.id,
        fromIndex: index,
        selectedIndices: selectedIndices,
      }),
    );

    // Add dragging class to all selected cells
    if (notebookView && selectedIndices.length > 1) {
      const cells = this.props.editor?.document?.cells || [];
      selectedIndices.forEach((i) => {
        const cellView = notebookView.cellViews.get(cells[i]?.id);
        if (cellView && cellView.element) {
          cellView.element.classList.add("dragging");
        }
      });
    } else {
      this.element.classList.add("dragging");
    }

    if (notebookView) {
      notebookView.setDraggingCell(index);
    }
  }

  handleDragEnd() {
    // Remove dragging class from all cells
    const cells = document.querySelectorAll(".jupyter-cell");
    cells.forEach((cell) => {
      cell.classList.remove("dragging", "drop-above", "drop-below");
    });

    if (this.props.notebookView) {
      this.props.notebookView.setDraggingCell(null);
    }
  }

  handleDragOver(event) {
    // Only react to cell-reorder drags; let external drops use default handling.
    if (!event.dataTransfer.types.includes(CELL_DRAG_MIME)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    const rect = this.element.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;

    this.element.classList.remove("drop-above", "drop-below");
    if (event.clientY < midY) {
      this.element.classList.add("drop-above");
    } else {
      this.element.classList.add("drop-below");
    }
  }

  handleDragEnter(event) {
    if (!event.dataTransfer.types.includes(CELL_DRAG_MIME)) {
      return;
    }
    event.preventDefault();
  }

  handleDragLeave(event) {
    if (!this.element.contains(event.relatedTarget)) {
      this.element.classList.remove("drop-above", "drop-below");
    }
  }

  handleDrop(event) {
    const raw = event.dataTransfer.getData(CELL_DRAG_MIME);
    if (!raw) {
      // Not a cell reorder (e.g. an external file or text drop); leave it to the
      // default handler instead of throwing on JSON.parse.
      return;
    }

    event.preventDefault();

    this.element.classList.remove("drop-above", "drop-below");

    try {
      const data = JSON.parse(raw);
      const selectedIndices = data.selectedIndices || [data.fromIndex];
      const { index: toIndex, editor, notebookView } = this.props;

      if (selectedIndices.length === 0) {
        return;
      }

      // Don't drop onto a cell that's being dragged
      if (selectedIndices.includes(toIndex)) {
        return;
      }

      const rect = this.element.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const dropAbove = event.clientY < midY;

      let targetIndex = dropAbove ? toIndex : toIndex + 1;

      if (editor) {
        const previousActiveIndex = editor.activeCellIndex;
        let newFirstIndex;
        let movedCount;
        let newActiveIndex;

        if (selectedIndices.length === 1) {
          // Single cell move
          const fromIndex = selectedIndices[0];
          if (fromIndex < targetIndex) {
            targetIndex--;
          }
          if (fromIndex !== targetIndex) {
            editor.moveCell(fromIndex, targetIndex);
          }
          newFirstIndex = targetIndex;
          movedCount = 1;
          newActiveIndex = targetIndex;
        } else {
          // Multiple cells move - move them as a group
          const sorted = [...selectedIndices].sort((a, b) => a - b);
          const cellsBeforeTarget = sorted.filter((i) => i < targetIndex).length;
          newFirstIndex = targetIndex - cellsBeforeTarget;
          movedCount = sorted.length;
          editor.moveCells(selectedIndices, targetIndex);

          // Map previous active cell to its new position in the moved block
          const posInSelection = sorted.indexOf(previousActiveIndex);
          newActiveIndex = posInSelection >= 0 ? newFirstIndex + posInSelection : newFirstIndex;
        }

        // Restore active cell to the moved cell's new position
        editor.setActiveCell(newActiveIndex);

        // Preserve selection on the moved cells at their new positions
        if (notebookView) {
          notebookView.clearSelection();
          if (movedCount > 1) {
            for (let i = 0; i < movedCount; i++) {
              notebookView.extendSelection(newFirstIndex + i);
            }
          }
        }
      }
    } catch (e) {
      console.error("Drop error:", e);
    }
  }

  // The tracked value deciding when the grammar must be re-applied: the cell's
  // own language when one was picked, the notebook's otherwise.
  grammarLanguage() {
    return cellLanguageOf(this.props.cell) || this.props.notebookLanguage || null;
  }

  // The scopes the cell's type and the notebook's language imply, ignoring any
  // grammar picked for the cell itself. Raw cells imply none.
  defaultGrammarTargets() {
    const { cell } = this.props;
    if (cell.type === "markdown") {
      return ["source.gfm", "text.md", "text.md.basic"];
    }
    if (cell.type === "code") {
      return getGrammarScopesForLanguage(this.props.notebookLanguage || "python");
    }
    return null;
  }

  applyGrammar() {
    if (!this.editor) return;

    // A grammar picked for this cell outranks what its type implies.
    const cellLanguage = cellLanguageOf(this.props.cell);
    const targetScopes = cellLanguage
      ? getGrammarScopesForLanguage(cellLanguage)
      : this.defaultGrammarTargets();
    const grammar = resolveGrammar(targetScopes);

    if (grammar) {
      // Register the scope as a language override instead of installing the
      // currently available grammar object directly. The registry can then
      // replace a TextMate fallback with the preferred Tree-sitter grammar
      // when language packages finish loading during workspace restoration.
      this._applyingGrammar = true;
      try {
        lumine.grammars.assignLanguageMode(this.editor.getBuffer(), grammar.scopeName);
      } finally {
        this._applyingGrammar = false;
      }
    } else if (targetScopes?.length && !this._grammarRetryScheduled) {
      // Grammar not found - might not be loaded yet during restore
      // Schedule a retry after grammars are loaded
      this._grammarRetryScheduled = true;
      const disposable = lumine.grammars.onDidAddGrammar(() => {
        disposable.dispose();
        this._grammarRetryScheduled = false;
        this.applyGrammar();
      });
      // Also try again after a short delay as a fallback
      setTimeout(() => {
        if (this._grammarRetryScheduled && this.editor) {
          this._grammarRetryScheduled = false;
          disposable.dispose();
          this.applyGrammar();
        }
      }, 1000);
    }
  }

  /**
   * The grammar changed under us: the grammar selector (or a script) assigned
   * one straight to the cell's editor. Record it on the cell so it survives
   * editor rebuilds, reaches other views of the notebook, and is saved with
   * the file; picking the cell's own default, or Auto Detect, clears it.
   */
  handleGrammarAssignment() {
    if (!this.editor) return;

    const assignedScope = lumine.grammars.getAssignedLanguageId(this.editor.getBuffer());
    if (assignedScope == null) {
      // Auto Detect: back to what the cell's type and the notebook imply.
      this._lastKnownLanguage = this.props.notebookLanguage || null;
      if (this.props.onLanguageChange) this.props.onLanguageChange(null);
      this.applyGrammar();
      return;
    }

    const defaultGrammar = resolveGrammar(this.defaultGrammarTargets());
    const languageId =
      assignedScope === defaultGrammar?.scopeName
        ? null
        : languageIdForGrammar(this.editor.getGrammar());
    this._lastKnownLanguage = languageId || this.props.notebookLanguage || null;
    if (this.props.onLanguageChange) this.props.onLanguageChange(languageId);
  }

  update(props) {
    const oldProps = this.props;
    this.props = { ...this.props, ...props };

    // The editor is rebuilt only when the cell stops (or starts) being one:
    // its type changed, or markdown switched between rendered and editable.
    // Use _lastKnownType, since the cell object is mutated in place.
    const typeChanged = this._lastKnownType !== props.cell.type;
    const wasRendered = this.isMarkdownRendered(oldProps.cell, oldProps.active, oldProps.mode);
    const willBeRendered = this.isMarkdownRendered(props.cell, props.active, props.mode);

    if (typeChanged || wasRendered !== willBeRendered) {
      this.destroyEditor();
      this._lastKnownSource = props.cell ? props.cell.source : "";
      this._lastKnownType = props.cell ? props.cell.type : "code";
      this._lastKnownLanguage = this.grammarLanguage();
      this._editorIsDirty = false;
      this._localChangeSourceRevision = null;
      this.setupEditor();
      return etch.update(this);
    }

    // The source changed somewhere else — another editor on the same cell, or
    // the model itself. Compare against what this view last knew rather than
    // against the editor text, which may be mid-edit.
    if (this.editor && props.cell && props.cell.source !== this._lastKnownSource) {
      // setText triggers onDidStopChanging, so flag it as not a local edit.
      this._updatingFromExternal = true;
      const position = this.editor.getCursorBufferPosition();
      this.editor.setText(props.cell.source);
      this.editor.setCursorBufferPosition(position);
      this._lastKnownSource = props.cell.source;
      this._editorIsDirty = false;
      this._localChangeSourceRevision = null;
    } else if (!this.editor && props.cell) {
      this._lastKnownSource = props.cell.source;
    }

    const grammarLanguage = this.grammarLanguage();
    if (this.editor && grammarLanguage !== this._lastKnownLanguage) {
      this._lastKnownLanguage = grammarLanguage;
      this.applyGrammar();
    }

    return etch.update(this);
  }

  _formatRunTime(ms) {
    if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}m ${s}s`;
  }

  getRunTimeText(cell) {
    if (!cell) return "";
    if (cell.lastRunTimeText) return cell.lastRunTimeText;
    return cell.lastRunTime > 0 ? this._formatRunTime(cell.lastRunTime) : "";
  }

  focus() {
    if (this.editor && this.editorElement) {
      // Focus must happen in next frame to work reliably
      requestAnimationFrame(() => {
        if (!this.editorElement) return;

        // preventScroll: true — scrolling is handled by scrollToCell (block: nearest)
        this.editorElement.focus({ preventScroll: true });

        // Also ensure the text editor model knows it's focused
        const editorView = this.editorElement;
        if (editorView && editorView.getModel) {
          const model = editorView.getModel();
          if (model) {
            // This triggers the cursor to appear
            lumine.views.getView(lumine.workspace).focus();
            this.editorElement.focus({ preventScroll: true });
          }
        }
      });
    }
  }

  // Both heights are rendered from config, so a change is just a re-render.
  applyOutputHeight() {
    return etch.update(this);
  }

  applyMaxInputHeight() {
    return etch.update(this);
  }

  destroyEditor() {
    const hadEditor = !!this.editor;
    if (this.editorGrammarSubscription) {
      this.editorGrammarSubscription.dispose();
      this.editorGrammarSubscription = null;
    }
    if (this.editorCursorSubscription) {
      this.editorCursorSubscription.dispose();
      this.editorCursorSubscription = null;
    }
    if (this.editorChangeSubscription) {
      this.editorChangeSubscription.dispose();
      this.editorChangeSubscription = null;
    }
    if (this.editorSubscription) {
      this.editorSubscription.dispose();
      this.editorSubscription = null;
    }
    if (this.editorRegistryDisposable) {
      this.editorRegistryDisposable.dispose();
      this.editorRegistryDisposable = null;
    }
    if (this.linterRegistration) {
      this.linterRegistration.dispose();
      this.linterRegistration = null;
    }
    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }
    this.editorElement = null;
    if (hadEditor) {
      this.props.editor?.notifyCellEditorChange?.(this.props.cell.id, null);
    }
  }

  destroy() {
    this._tooltips.dispose();
    this._maxInputHeightDisposable?.dispose();
    this._maxOutputHeightDisposable?.dispose();

    // Cancel any pending grammar retry
    this._grammarRetryScheduled = false;

    this.destroyEditor();
    return etch.destroy(this);
  }
}

module.exports = CellView;
