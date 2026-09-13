/** @jsx etch.dom */
/**
 * NotebookView - the notebook's toolbar and its list of cells.
 */

const etch = require("@lumine-code/etch");
const { CompositeDisposable, Disposable } = require("lumine");
const CellView = require("./cell-view");
const { hasCellDrag, inspectCellDrag, readCellDrag } = require("./cell-drag");
const { getGrammarForLanguage, getNotebookLanguage } = require("./notebook-language");

const CELL_TYPES = [
  { value: "code", label: "Code" },
  { value: "markdown", label: "Markdown" },
  { value: "raw", label: "Raw" },
];

class CellTypeSelectBox {
  constructor(props) {
    this.props = props;
    this.controller = lumine.menu.createSelectBox({
      items: CELL_TYPES,
      value: props.value,
      ariaLabel: "Cell type",
      className: "cell-type-select",
    });
    this.element = this.controller.element;
    this.changeDisposable = this.controller.onDidChange(({ value }) => this.props.onChange(value));
    this.wheelHandler = (event) => this.props.onWheel(event);
    this.element.addEventListener("wheel", this.wheelHandler, { passive: false });
  }

  update(props) {
    this.props = props;
    this.controller.setValue(props.value);
  }

  destroy() {
    this.element.removeEventListener("wheel", this.wheelHandler);
    this.changeDisposable.dispose();
    this.controller.destroy();
  }
}

class NotebookView {
  constructor(props) {
    this.props = props;
    this.mode = "command"; // 'command' or 'edit'
    this.selectedCells = new Set(); // Set of selected cell indices
    this._selectionAnchor = null; // Anchor index for range-extension (shift+arrow / shift+click)
    this.draggingCellId = null;
    this.draggingCellIds = new Set();
    this._dropIndicatorCellId = null;
    this._dropIndicatorPosition = null;
    this._dropIndicatorElement = null;
    this._dropIndicatorClass = null;
    this._dragLeaveFrame = null;
    this._autoScrollInterval = null;
    this._autoScrollSpeed = 0;
    this._mouseButtonDown = false; // Track mouse button state for selection
    this._pendingScrollY = 0;
    this._scrollAnimId = null;
    this._observedContainer = null;
    this._dragContainer = null;
    this._dragWindow = null;
    this.scrollCallbacks = new Set();
    this.selectionCallbacks = new Set();
    this._tooltips = new CompositeDisposable();
    this._tooltipTargets = new WeakSet();

    etch.initialize(this);

    // Set up focus tracking for mode switching
    this.element.addEventListener("focusin", this.handleFocusIn.bind(this));
    this.element.addEventListener("focusout", this.handleFocusOut.bind(this));
    this.element.addEventListener("click", this.handleClick.bind(this));

    // Watch for scrollPastEnd setting changes
    this._scrollPastEndConfigOptions = this.scrollPastEndConfigOptions();
    this._scrollPastEndDisposable = lumine.config.onDidChange(
      "editor.scrollPastEnd",
      this._scrollPastEndConfigOptions,
      () => this.applyScrollPastEnd(),
    );

    // Watch for container resize to update scroll past end padding
    this._resizeObserver = new ResizeObserver(() => {
      if (lumine.config.get("editor.scrollPastEnd", this._scrollPastEndConfigOptions)) {
        this.applyScrollPastEnd();
      }
    });

    // Track mouse button state to avoid mode switch during text selection
    // Also activate pane immediately on mousedown for responsive feel
    this.element.addEventListener("mousedown", () => {
      this._mouseButtonDown = true;
      this.activatePane();
    });
    document.addEventListener(
      "mouseup",
      (this._handleGlobalMouseUp = () => {
        this._mouseButtonDown = false;
      }),
    );

    // The container only exists once the first render has run.
    this.readAfterUpdate();
  }

  // Buttons that only dispatch a command, so the toolbar can list them.
  commandButtons() {
    return [
      ["jupyter-view:run-cell", "icon-playback-play", "Run Cell"],
      ["jupyter-view:run-cell-and-move-down", "icon-jump-down", "Run Cell and Move Down"],
      ["jupyter-view:run-all", "icon-playback-fast-forward", "Run All Cells"],
      null,
      ["jupyter-repl:interrupt-kernel", "icon-stop", "Interrupt Kernel"],
      ["jupyter-repl:restart-kernel", "icon-sync", "Restart Kernel"],
      ["jupyter-repl:shutdown-kernel", "icon-circle-slash", "Shutdown Kernel"],
    ];
  }

  // Buttons that call the editor directly, with the command they are bound to
  // shown in the tooltip.
  editorButtons() {
    return [
      // Insert points an arrow at the edge it puts the cell against; move is a
      // plain direction. Both are the weight of the run and delete glyphs
      // beside them — a plain arrow reads as "move" and the chevrons were the
      // lightest marks in the row.
      ["icon-move-up", "Insert Cell Above", "jupyter-view:insert-cell-above", "insertCellAbove"],
      ["icon-move-down", "Insert Cell Below", "jupyter-view:insert-cell-below", "insertCellBelow"],
      ["icon-triangle-up", "Move Cell Up", "jupyter-view:move-cell-up", "moveCellUp"],
      ["icon-triangle-down", "Move Cell Down", "jupyter-view:move-cell-down", "moveCellDown"],
      ["icon-trashcan", "Delete Cell", "jupyter-view:delete-cell", "deleteCell"],
      null,
      ["icon-remove-close", "Clear Cell Output", "jupyter-view:clear-output", "clearOutput"],
      [
        "icon-primitive-square",
        "Clear All Outputs",
        "jupyter-view:clear-all-outputs",
        "clearAllOutputs",
      ],
    ];
  }

  dispatchCommand = (command) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    this.activatePane();
    lumine.commands.dispatch(this.element, command);
  };

  callEditor = (method) => () => {
    const { editor } = this.props;
    if (editor) editor[method]();
  };

  handleCellTypeChange = (value) => {
    const { editor } = this.props;
    if (editor) editor.changeCellType(value);
  };

  // Scrolling the dropdown cycles the type, which is quicker than opening it.
  handleCellTypeWheel = (event) => {
    const { editor } = this.props;
    const select = this.refs.cellTypeSelect?.controller;
    if (!editor || !select) return;
    event.preventDefault();
    if (event.deltaY > 0) select.selectNext();
    else if (event.deltaY < 0) select.selectPrevious();
  };

  activeCellType() {
    const { cells, activeCellIndex } = this.props;
    return cells && cells[activeCellIndex] ? cells[activeCellIndex].type : "code";
  }

  renderToolbar() {
    return (
      <div className="jupyter-notebook-toolbar">
        <div className="toolbar-left">
          {this.commandButtons().map((entry, index) =>
            entry ? (
              <button
                key={entry[0]}
                className={`btn btn-sm icon ${entry[1]}`}
                ref={`command-${entry[0]}`}
                onClick={this.dispatchCommand(entry[0])}
              />
            ) : (
              <div key={`sep-command-${index}`} className="toolbar-separator" />
            ),
          )}
          <div className="toolbar-separator" />
          {this.editorButtons().map((entry, index) =>
            entry ? (
              <button
                key={entry[3]}
                className={`btn btn-sm icon ${entry[0]}`}
                ref={`editor-${entry[3]}`}
                onClick={this.callEditor(entry[3])}
              />
            ) : (
              <div key={`sep-editor-${index}`} className="toolbar-separator" />
            ),
          )}
          <div className="toolbar-separator" />
          <CellTypeSelectBox
            ref="cellTypeSelect"
            value={this.activeCellType()}
            onChange={this.handleCellTypeChange}
            onWheel={this.handleCellTypeWheel}
          />
          <div className="toolbar-separator" />
          <span className="mode-indicator">{this.mode === "edit" ? "Edit" : "Command"}</span>
        </div>
      </div>
    );
  }

  // Props for one cell. The navigation callbacks close over the index, so they
  // are rebuilt per render rather than cached.
  cellProps(cell, index, cellsArray, notebookLanguage) {
    const { activeCellIndex, editor } = this.props;

    const focusSibling = (target, toEnd) => {
      if (!editor) return;
      editor.setActiveCell(target);
      requestAnimationFrame(() => {
        const view = this.cellViews.get(cellsArray[target]?.id);
        if (!view) return;
        view.focus();
        if (view.editor) {
          const row = toEnd ? view.editor.getLastBufferRow() : 0;
          view.editor.setCursorBufferPosition([row, toEnd ? Infinity : 0]);
        }
      });
    };

    return {
      cell,
      index,
      active: index === activeCellIndex,
      selected: this.selectedCells.has(index),
      mode: this.mode,
      editor,
      notebookView: this,
      notebookLanguage,
      cellSourceRevision: cell.sourceRevision || 0,
      onCellSelect: (event) => this.handleCellSelect(index, event),
      onFocus: () => editor && editor.setActiveCell(index),
      onSourceChange: (source) => editor && editor.updateCellSource(index, source),
      onLanguageChange: (languageId) => editor && editor.setCellLanguage(index, languageId),
      onEnterEditMode: () => this.enterEditMode(),
      onEnterCommandMode: () => this.setMode("command"),
      onNavigateToPreviousCell: () => index > 0 && focusSibling(index - 1, true),
      onNavigateToNextCell: () => index < cellsArray.length - 1 && focusSibling(index + 1, false),
    };
  }

  render() {
    const { cells, editor } = this.props;
    const cellsArray = cells || [];
    const notebookLanguage = getNotebookLanguage(editor?.document?.metadata || {});
    const mode = this.mode === "edit" ? "edit-mode" : "command-mode";

    return (
      <div className={`jupyter-notebook ${mode}`} tabIndex={-1}>
        {this.renderToolbar()}
        <div className="jupyter-notebook-cells" ref="cellsContainer" onScroll={this.handleScroll}>
          {/* Keyed by cell id, so reordering moves each cell's element — and
              with it the TextEditor inside — instead of rebuilding them. */}
          {cellsArray.map((cell, index) => (
            <CellView
              key={cell.id}
              ref={`cell-${cell.id}`}
              {...this.cellProps(cell, index, cellsArray, notebookLanguage)}
            />
          ))}
        </div>
      </div>
    );
  }

  /** The cell views, keyed by cell id, as etch created them. */
  get cellViews() {
    const views = new Map();
    for (const [name, value] of Object.entries(this.refs)) {
      if (name.startsWith("cell-")) views.set(name.slice(5), value);
    }
    return views;
  }

  get cellsContainer() {
    return this.refs.cellsContainer || null;
  }

  handleScroll = () => {
    for (const callback of this.scrollCallbacks) {
      callback();
    }
  };

  // Tooltips and the container listeners attach to elements the diff keeps, so
  // each is registered once for the element it is on.
  readAfterUpdate() {
    for (const entry of this.commandButtons()) {
      if (!entry) continue;
      this.addTooltip(this.refs[`command-${entry[0]}`], {
        title: entry[2],
        keyBindingCommand: entry[0],
      });
    }
    for (const entry of this.editorButtons()) {
      if (!entry) continue;
      this.addTooltip(this.refs[`editor-${entry[3]}`], {
        title: entry[1],
        keyBindingCommand: entry[2],
      });
    }
    this.addTooltip(this.refs.cellTypeSelect?.element, { title: "Cell Type (scroll to cycle)" });

    const container = this.cellsContainer;
    if (container && this._observedContainer !== container) {
      if (this._observedContainer) this._resizeObserver?.unobserve?.(this._observedContainer);
      this._observedContainer = container;
      this.applyScrollPastEnd();
      if (this._resizeObserver) this._resizeObserver.observe(container);
      this.setupCellDragAndDrop();
    }
  }

  addTooltip(element, options) {
    if (!element || this._tooltipTargets.has(element)) return;
    this._tooltipTargets.add(element);
    this._tooltips.add(lumine.tooltips.add(element, options));
  }

  setupCellDragAndDrop() {
    const container = this.cellsContainer;
    if (!container) return;

    // Remove old listeners if they exist (prevents leaks on re-render)
    if (this._dragContainer && this._dragOverHandler) {
      this._dragContainer.removeEventListener("dragenter", this._dragEnterHandler, true);
      this._dragContainer.removeEventListener("dragover", this._dragOverHandler, true);
      this._dragContainer.removeEventListener("dragleave", this._dragLeaveHandler, true);
      this._dragContainer.removeEventListener("drop", this._dropHandler, true);
    }
    this._dragWindow?.removeEventListener("dragend", this._dragEndHandler, true);
    this._dragWindow?.removeEventListener("blur", this._dragWindowBlurHandler, true);
    this._dragContainer = container;
    this._dragWindow = container.ownerDocument.defaultView;

    const SCROLL_ZONE = 60; // pixels from edge to trigger scroll
    const MAX_SCROLL_SPEED = 15; // max pixels per frame

    this._dragEnterHandler = (event) => {
      if (!this.claimCellDragEvent(event)) return;
      this.updateCellDropIndicator(event);
    };

    this._dragOverHandler = (event) => {
      if (!this.claimCellDragEvent(event)) return;

      this.updateCellDropIndicator(event);

      const rect = this.cellsContainer.getBoundingClientRect();
      const mouseY = event.clientY;

      // Calculate distance from edges
      const distFromTop = mouseY - rect.top;
      const distFromBottom = rect.bottom - mouseY;

      if (distFromTop < SCROLL_ZONE) {
        // Near top - scroll up (negative speed)
        const intensity = 1 - distFromTop / SCROLL_ZONE;
        this._autoScrollSpeed = -MAX_SCROLL_SPEED * intensity;
        this.startAutoScroll();
      } else if (distFromBottom < SCROLL_ZONE) {
        // Near bottom - scroll down (positive speed)
        const intensity = 1 - distFromBottom / SCROLL_ZONE;
        this._autoScrollSpeed = MAX_SCROLL_SPEED * intensity;
        this.startAutoScroll();
      } else {
        // Not in scroll zone
        this.stopAutoScroll();
      }
    };

    this._dragLeaveHandler = (event) => {
      if (!this.acceptsCellDrag(event.dataTransfer)) return;
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      this.cancelCellDragLeave();
      if (this.cellsContainer.contains(event.relatedTarget)) {
        return;
      }
      if (event.relatedTarget == null) {
        // Chromium commonly reports a null relatedTarget while crossing child
        // boundaries. Defer cleanup and hit-test the pointer; a matching
        // enter/over cancels it, while a slow next dragover still keeps the
        // cursor and insertion marker continuous inside the container.
        const { clientX, clientY } = event;
        this._dragLeaveFrame = requestAnimationFrame(() => {
          this._dragLeaveFrame = null;
          const pointerElement = this.element.ownerDocument.elementFromPoint?.(clientX, clientY);
          if (pointerElement && this.cellsContainer.contains(pointerElement)) return;
          this.stopAutoScroll();
          this.clearCellDropIndicator();
        });
      } else {
        this.stopAutoScroll();
        this.clearCellDropIndicator();
      }
    };

    this._dropHandler = (event) => {
      this.stopAutoScroll();
      if (!this.claimCellDragEvent(event)) return;
      const target = this.getCellDropTarget(event);
      const payload = readCellDrag(event.dataTransfer);
      this.clearCellDropIndicator();
      if (target && payload) this.performCellDrop(payload, target);
    };

    this._dragEndHandler = (event) => {
      if (
        hasCellDrag(event.dataTransfer) ||
        this.draggingCellIds.size > 0 ||
        this._dropIndicatorCellId
      ) {
        this.finishCellDrag();
      }
    };
    this._dragWindowBlurHandler = () => this.finishCellDrag();

    // The container owns this embedded interaction in capture phase. That
    // keeps the accepted cursor continuous over cell editors and gaps, and
    // prevents the document's unhandled-drop fallback from seeing it.
    container.addEventListener("dragenter", this._dragEnterHandler, true);
    container.addEventListener("dragover", this._dragOverHandler, true);
    container.addEventListener("dragleave", this._dragLeaveHandler, true);
    container.addEventListener("drop", this._dropHandler, true);
    this._dragWindow.addEventListener("dragend", this._dragEndHandler, true);
    this._dragWindow.addEventListener("blur", this._dragWindowBlurHandler, true);
  }

  claimCellDragEvent(event) {
    if (!this.acceptsCellDrag(event.dataTransfer)) {
      this.cancelCellDragLeave();
      this.stopAutoScroll();
      this.clearCellDropIndicator();
      return false;
    }
    this.cancelCellDragLeave();
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    return true;
  }

  acceptsCellDrag(dataTransfer) {
    const offer = inspectCellDrag(dataTransfer);
    return offer?.sourceDocumentId === this.props.editor?.document?.id;
  }

  getCellDropTarget(event) {
    const cells = this.props.editor?.document?.cells || [];
    if (cells.length === 0 || !this.cellsContainer) return null;

    const directElement = event.target?.closest?.(".jupyter-cell");
    if (directElement && this.cellsContainer.contains(directElement)) {
      const cellId = directElement.getAttribute("data-cell-id");
      const cellIndex = cells.findIndex((cell) => cell.id === cellId);
      if (cellIndex >= 0) {
        const rect = directElement.getBoundingClientRect();
        const after = event.clientY >= rect.top + rect.height / 2;
        return this.cellDropTargetForBoundary(cellIndex + (after ? 1 : 0));
      }
    }

    const entries = cells
      .map((cell, index) => ({
        index,
        cellId: cell.id,
        element: this.cellViews.get(cell.id)?.element,
      }))
      .filter((entry) => entry.element && this.cellsContainer.contains(entry.element));
    if (entries.length === 0) return null;

    for (const entry of entries) {
      const rect = entry.element.getBoundingClientRect();
      if (event.clientY < rect.top) {
        return this.cellDropTargetForBoundary(entry.index);
      }
      if (event.clientY <= rect.bottom) {
        const after = event.clientY >= rect.top + rect.height / 2;
        return this.cellDropTargetForBoundary(entry.index + (after ? 1 : 0));
      }
    }
    return this.cellDropTargetForBoundary(cells.length);
  }

  cellDropTargetForBoundary(boundaryIndex) {
    const cells = this.props.editor?.document?.cells || [];
    if (boundaryIndex < 0 || boundaryIndex > cells.length || cells.length === 0) return null;

    const indicatorPosition = boundaryIndex < cells.length ? "above" : "below";
    const indicatorCellId =
      boundaryIndex < cells.length ? cells[boundaryIndex].id : cells[cells.length - 1].id;
    const element = this.cellViews.get(indicatorCellId)?.element || null;
    return {
      boundaryIndex,
      indicatorCellId,
      indicatorPosition,
      element,
    };
  }

  updateCellDropIndicator(event) {
    const target = this.getCellDropTarget(event);
    const nextElement = target?.element || null;
    const nextClass = target ? `drop-${target.indicatorPosition}` : null;
    if (
      nextElement === this._dropIndicatorElement &&
      nextClass === this._dropIndicatorClass &&
      nextElement?.classList.contains(nextClass)
    )
      return;
    this.clearCellDropIndicator();
    nextElement?.classList.add(nextClass);
    this._dropIndicatorCellId = target?.indicatorCellId || null;
    this._dropIndicatorPosition = target?.indicatorPosition || null;
    this._dropIndicatorElement = nextElement;
    this._dropIndicatorClass = nextClass;
  }

  clearCellDropIndicator() {
    this.cellViews
      .get(this._dropIndicatorCellId)
      ?.element?.classList.remove("drop-above", "drop-below");
    this._dropIndicatorElement?.classList.remove("drop-above", "drop-below");
    this._dropIndicatorCellId = null;
    this._dropIndicatorPosition = null;
    this._dropIndicatorElement = null;
    this._dropIndicatorClass = null;
  }

  cancelCellDragLeave() {
    if (this._dragLeaveFrame != null) cancelAnimationFrame(this._dragLeaveFrame);
    this._dragLeaveFrame = null;
  }

  performCellDrop(payload, target) {
    const editor = this.props.editor;
    const notebookDocument = editor?.document;
    if (!notebookDocument || payload.sourceDocumentId !== notebookDocument.id) return false;

    const cells = notebookDocument.cells || [];
    const selectedIndices = payload.cellIds.map((cellId) =>
      cells.findIndex((candidate) => candidate.id === cellId),
    );

    // Structural edits during a drag are allowed, but a missing source or
    // target invalidates the entire operation rather than moving a subset.
    if (selectedIndices.some((index) => index < 0)) return false;
    if (target.boundaryIndex < 0 || target.boundaryIndex > cells.length) return false;
    const before = cells.map((cell) => cell.id);
    const selected = new Set(payload.cellIds);
    const draggedIds = before.filter((cellId) => selected.has(cellId));
    const remaining = before.filter((cellId) => !selected.has(cellId));
    const adjustedInsertionIndex =
      target.boundaryIndex - selectedIndices.filter((index) => index < target.boundaryIndex).length;
    const expected = [
      ...remaining.slice(0, adjustedInsertionIndex),
      ...draggedIds,
      ...remaining.slice(adjustedInsertionIndex),
    ];

    // An adjacent/self-equivalent drop is accepted without creating history.
    if (expected.every((cellId, index) => cellId === before[index])) return false;

    const previousActiveCellId = cells[editor.activeCellIndex]?.id || null;
    editor.moveCells(selectedIndices, target.boundaryIndex);

    const movedIndices = payload.cellIds
      .map((cellId) => notebookDocument.cells.findIndex((cell) => cell.id === cellId))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b);
    const activeCellId = payload.cellIds.includes(previousActiveCellId)
      ? previousActiveCellId
      : payload.primaryCellId;
    editor.setActiveCell(notebookDocument.cells.findIndex((cell) => cell.id === activeCellId));

    this.replaceSelection(movedIndices);
    return true;
  }

  beginCellDrag(payload) {
    this.finishCellDrag();
    this.draggingCellId = payload.primaryCellId;
    this.draggingCellIds = new Set(payload.cellIds);
    for (const cellId of payload.cellIds) {
      this.cellViews.get(cellId)?.element?.classList.add("dragging");
    }
  }

  isCellDragging(cellId) {
    return this.draggingCellIds.has(cellId);
  }

  getCellDropPosition(cellId) {
    return cellId === this._dropIndicatorCellId ? this._dropIndicatorPosition : null;
  }

  finishCellDrag() {
    this.cancelCellDragLeave();
    this.stopAutoScroll();
    this.clearCellDropIndicator();
    for (const cell of this.element.querySelectorAll(".jupyter-cell")) {
      cell.classList.remove("dragging", "drop-above", "drop-below");
    }
    this.draggingCellId = null;
    this.draggingCellIds.clear();
  }

  startAutoScroll() {
    if (this._autoScrollInterval) return;

    this._autoScrollInterval = setInterval(() => {
      if (this.cellsContainer && this._autoScrollSpeed !== 0) {
        this.cellsContainer.scrollTop += this._autoScrollSpeed;
      }
    }, 16); // ~60fps
  }

  stopAutoScroll() {
    if (this._autoScrollInterval) {
      clearInterval(this._autoScrollInterval);
      this._autoScrollInterval = null;
    }
    this._autoScrollSpeed = 0;
  }

  /**
   * Apply scroll past end padding based on Lumine's editor.scrollPastEnd setting
   */
  applyScrollPastEnd() {
    if (!this.cellsContainer) return;

    const scrollPastEnd = lumine.config.get(
      "editor.scrollPastEnd",
      this._scrollPastEndConfigOptions,
    );
    if (scrollPastEnd) {
      // Add padding-bottom equal to the container's height minus some minimal space
      // This allows scrolling the last cell to near the top of the viewport
      requestAnimationFrame(() => {
        if (this.cellsContainer) {
          const containerHeight = this.cellsContainer.clientHeight;
          // Leave at least 50px visible at the bottom
          const padding = Math.max(0, containerHeight - 50);
          this.cellsContainer.style.paddingBottom = `${padding}px`;
        }
      });
    } else {
      this.cellsContainer.style.paddingBottom = "";
    }
  }

  scrollPastEndConfigOptions() {
    const language = getNotebookLanguage(this.props.editor?.document?.metadata || {});
    const grammar = getGrammarForLanguage(language);
    return grammar?.scopeName ? { scope: [grammar.scopeName] } : {};
  }

  update(props) {
    const nextCells = props.cells || this.props.cells || [];
    const nextCellIds = new Set(nextCells.map((cell) => cell.id));
    if (
      this.draggingCellIds.size > 0 &&
      Array.from(this.draggingCellIds).some((cellId) => !nextCellIds.has(cellId))
    ) {
      this.finishCellDrag();
    } else if (this._dropIndicatorCellId && !nextCellIds.has(this._dropIndicatorCellId)) {
      this.clearCellDropIndicator();
    }
    this.props = { ...this.props, ...props };
    return etch.update(this);
  }

  updateCells(cellIds) {
    const cells = this.props.cells || [];
    const notebookLanguage = getNotebookLanguage(this.props.editor?.document?.metadata || {});
    const indexes = new Map(cells.map((cell, index) => [cell.id, index]));
    const updates = [];
    for (const cellId of new Set(cellIds || [])) {
      const index = indexes.get(cellId);
      const cellView = this.cellViews.get(cellId);
      if (index === undefined || !cellView) continue;
      updates.push(cellView.update(this.cellProps(cells[index], index, cells, notebookLanguage)));
    }
    return Promise.all(updates);
  }

  onDidScroll(callback) {
    this.scrollCallbacks.add(callback);
    return new Disposable(() => {
      this.scrollCallbacks.delete(callback);
    });
  }

  onDidChangeSelection(callback) {
    this.selectionCallbacks.add(callback);
    return new Disposable(() => {
      this.selectionCallbacks.delete(callback);
    });
  }

  setMode(mode) {
    if (this.mode !== mode) {
      this.mode = mode;

      // The classes, the indicator and the cells all read the mode, and the
      // keymap selectors need the class immediately.
      etch.updateSync(this);
      this.props.editor?.notifyNotebookModeChange?.();
    }
  }

  enterEditMode() {
    this.setMode("edit");
    this.focusActiveCellEditor();
    const index = this.props.activeCellIndex;
    const cells = this.props.cells;
    if (cells && cells[index]) {
      const cellView = this.cellViews.get(cells[index].id);
      if (cellView && cellView.editor) {
        this.scrollToCursor(index, cellView.editor);
      }
    }
  }

  /**
   * Focus the active cell's editor without changing mode
   */
  focusActiveCellEditor() {
    const activeCellIndex = this.props.activeCellIndex;
    const cells = this.props.cells;
    if (cells && cells[activeCellIndex]) {
      const cellView = this.cellViews.get(cells[activeCellIndex].id);
      if (cellView) {
        // Temporarily disable mode switching from focus events
        this._skipFocusModeChange = true;
        cellView.focus();
        // Re-enable after focus events have been processed
        // Use setTimeout to ensure it runs after handleFocusOut's setTimeout(0)
        setTimeout(() => {
          this._skipFocusModeChange = false;
        }, 50);
      }
    }
  }

  enterCommandMode() {
    this.setMode("command");
    this.element.focus();
  }

  /**
   * Activate the pane containing this notebook
   */
  activatePane() {
    const { editor } = this.props;
    if (editor) {
      const pane = lumine.workspace.paneForItem(editor);
      if (pane && !pane.isActive()) {
        pane.activate();
      }
    }
  }

  handleFocusIn(event) {
    // Activate the pane containing this notebook when any element receives focus
    this.activatePane();

    // Restore selection styling when notebook gains focus
    this.updateCellSelectionClasses();

    // Skip mode change if programmatically focusing.
    if (this._skipFocusModeChange) return;

    // Check if focus went to an editor inside a cell
    const isEditor = event.target.closest("lumine-text-editor");
    const isInCell = event.target.closest(".jupyter-cell");

    if (isEditor && isInCell) {
      this.setMode("edit");
    }
  }

  handleFocusOut() {
    // Check if focus is leaving the notebook entirely
    setTimeout(() => {
      // Guard against destroyed view
      if (!this.element) return;

      // Don't switch mode if programmatically focusing or mouse button held
      if (this._skipFocusModeChange) return;
      if (this._mouseButtonDown) return;

      if (!this.element.contains(document.activeElement)) {
        // Focus left the notebook - hide selections
        this._hideSelectionClasses();
      } else if (!document.activeElement.closest("lumine-text-editor")) {
        // Focus is in notebook but not in an editor
        this.setMode("command");
      }
    }, 0);
  }

  handleClick(event) {
    // Activate pane on any click
    this.activatePane();

    // Don't steal focus from interactive toolbar controls.
    if (event.target.closest("input, button")) {
      return;
    }

    // Clicking on a cell but not in the editor should enter command mode
    const isEditor = event.target.closest("lumine-text-editor");
    const isCell = event.target.closest(".jupyter-cell");

    if (isCell && !isEditor) {
      // Clicked on cell but not editor - command mode
      this.setMode("command");
      this.element.focus();
    } else if (isEditor) {
      // Clicked in editor - edit mode
      this.setMode("edit");
      this.clearSelection();
    } else if (!isCell) {
      // Clicked on background (not on any cell) - command mode and clear selection
      this.setMode("command");
      this.element.focus();
      this.clearSelection();
    }
  }

  /**
   * Handle cell selection with Ctrl/Shift modifiers
   * @param {number} index - Cell index that was clicked
   * @param {MouseEvent} event - The click event
   */
  handleCellSelect(index, event) {
    const { editor, activeCellIndex } = this.props;

    if (event.ctrlKey || event.metaKey) {
      // Ctrl+click: toggle selection of clicked cell
      if (this.selectedCells.has(index)) {
        this.selectedCells.delete(index);
      } else {
        this.selectedCells.add(index);
      }
      this._selectionAnchor = null;
      // Set active cell to clicked cell
      if (editor) editor.setActiveCell(index);
    } else if (event.shiftKey) {
      // Shift+click: select range from anchor (or active cell) to clicked cell
      if (this._selectionAnchor === null) {
        this._selectionAnchor = activeCellIndex;
      }
      const anchor = this._selectionAnchor;
      const start = Math.min(anchor, index);
      const end = Math.max(anchor, index);
      this.selectedCells.clear();
      for (let i = start; i <= end; i++) {
        this.selectedCells.add(i);
      }
      if (editor) editor.setActiveCell(index);
    } else {
      // Normal click: clear selection and select only clicked cell
      this.selectedCells.clear();
      this.selectedCells.add(index);
      this._selectionAnchor = null;
      if (editor) editor.setActiveCell(index);
    }

    // Update cell views to reflect selection state
    this.updateCellSelectionClasses();
  }

  /**
   * Extend selection by one cell in the given direction (-1 = up, +1 = down).
   * Uses the selection anchor so repeated shift+arrow presses grow/shrink
   * the block around the anchor, like a file explorer.
   */
  extendSelectionByStep(direction) {
    const { editor, cells, activeCellIndex } = this.props;
    if (!editor || !cells || cells.length === 0) return;

    const nextIndex = activeCellIndex + direction;
    if (nextIndex < 0 || nextIndex >= cells.length) return;

    if (this._selectionAnchor === null) {
      this._selectionAnchor = activeCellIndex;
    }

    const anchor = this._selectionAnchor;
    const start = Math.min(anchor, nextIndex);
    const end = Math.max(anchor, nextIndex);

    this.selectedCells.clear();
    for (let i = start; i <= end; i++) {
      this.selectedCells.add(i);
    }

    editor.setActiveCell(nextIndex);
    this.scrollToCell(nextIndex);
    this.updateCellSelectionClasses();
  }

  selectPreviousCell() {
    this.extendSelectionByStep(-1);
  }

  selectNextCell() {
    this.extendSelectionByStep(1);
  }

  /**
   * Update CSS classes on cells to reflect selection state
   * Also validates and cleans up any invalid indices in selectedCells
   */
  updateCellSelectionClasses() {
    const { cells } = this.props;
    if (!cells) return;

    // Validate selection indices - remove any that are out of bounds
    const validSelection = new Set();
    for (const index of this.selectedCells) {
      if (index >= 0 && index < cells.length) {
        validSelection.add(index);
      }
    }
    this.selectedCells = validSelection;

    cells.forEach((cell, index) => {
      const cellView = this.cellViews.get(cell.id);
      if (cellView && cellView.element) {
        if (this.selectedCells.has(index)) {
          cellView.element.classList.add("selected");
        } else {
          cellView.element.classList.remove("selected");
        }
      }
    });

    for (const callback of this.selectionCallbacks) {
      callback(this.getSelectedCells());
    }
  }

  /**
   * Hide selection classes without clearing the selection data
   * Used when notebook loses focus
   */
  _hideSelectionClasses() {
    const { cells } = this.props;
    if (!cells) return;

    cells.forEach((cell) => {
      const cellView = this.cellViews.get(cell.id);
      if (cellView && cellView.element) {
        cellView.element.classList.remove("selected");
      }
    });
  }

  /**
   * Clear all cell selections
   */
  clearSelection() {
    this.replaceSelection([]);
  }

  /** Replace the complete selection and notify observers once. */
  replaceSelection(indices) {
    this.selectedCells = new Set(indices || []);
    this._selectionAnchor = null;
    this.updateCellSelectionClasses();
  }

  /**
   * Extend selection to include the specified cell index
   */
  extendSelection(index) {
    this.selectedCells.add(index);
    this.updateCellSelectionClasses();
  }

  /**
   * Get array of selected cell indices
   */
  getSelectedCells() {
    return Array.from(this.selectedCells).sort((a, b) => a - b);
  }

  focusPreviousCell() {
    const { editor, activeCellIndex } = this.props;
    if (editor && activeCellIndex > 0) {
      this._selectionAnchor = null;
      this.clearSelection();
      editor.setActiveCell(activeCellIndex - 1);
      this.scrollToCell(activeCellIndex - 1);
    }
  }

  focusNextCell() {
    const { editor, activeCellIndex, cells } = this.props;
    if (editor && cells && activeCellIndex < cells.length - 1) {
      this._selectionAnchor = null;
      this.clearSelection();
      editor.setActiveCell(activeCellIndex + 1);
      this.scrollToCell(activeCellIndex + 1);
    }
  }

  focusFirstCell() {
    const { editor, cells } = this.props;
    if (editor && cells && cells.length > 0) {
      this._selectionAnchor = null;
      this.clearSelection();
      editor.setActiveCell(0);
      this.scrollToCell(0);
    }
  }

  focusLastCell() {
    const { editor, cells } = this.props;
    if (editor && cells && cells.length > 0) {
      this._selectionAnchor = null;
      this.clearSelection();
      editor.setActiveCell(cells.length - 1);
      this.scrollToCell(cells.length - 1);
    }
  }

  scrollToCursor(index, editor) {
    if (!this.cellsContainer) return;
    const cells = this.props.cells;
    if (!cells || !cells[index]) return;
    const cellView = this.cellViews.get(cells[index].id);
    if (!cellView || !cellView.editorElement) return;

    const lineHeight = editor.getLineHeightInPixels();
    if (!lineHeight) return;

    const cursorRow = editor.getLastCursor().getScreenPosition().row;
    const editorRect = cellView.editorElement.getBoundingClientRect();
    const containerRect = this.cellsContainer.getBoundingClientRect();

    // Mirror Lumine's getVerticalAutoscrollMargin() logic
    const containerHeight = this.cellsContainer.clientHeight;
    const maxMarginLines = Math.floor((containerHeight / lineHeight - 1) / 2);
    const margin = Math.min(editor.verticalScrollMargin, maxMarginLines) * lineHeight;

    const cursorTop = editorRect.top + cursorRow * lineHeight;
    const cursorBottom = cursorTop + lineHeight;

    let newScrollTop = null;
    if (cursorTop - margin < containerRect.top) {
      newScrollTop = this.cellsContainer.scrollTop + (cursorTop - margin - containerRect.top);
    } else if (cursorBottom + margin > containerRect.bottom) {
      newScrollTop = this.cellsContainer.scrollTop + (cursorBottom + margin - containerRect.bottom);
    }

    if (newScrollTop !== null) {
      this.cellsContainer.scrollTo({ top: newScrollTop, behavior: "instant" });
    }
  }

  scrollToCell(index) {
    const cells = this.props.cells;
    if (!cells || !cells[index] || !this.cellsContainer) return;
    const cellView = this.cellViews.get(cells[index].id);
    if (!cellView || !cellView.element) return;

    const container = this.cellsContainer;
    const cellRect = cellView.element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    let newScrollTop = null;
    if (cellRect.top < containerRect.top) {
      newScrollTop = container.scrollTop + (cellRect.top - containerRect.top);
    } else if (cellRect.bottom > containerRect.bottom) {
      newScrollTop = container.scrollTop + (cellRect.bottom - containerRect.bottom);
    }

    if (newScrollTop !== null) {
      container.scrollTo({ top: newScrollTop, behavior: "smooth" });
    }
  }

  getMode() {
    return this.mode;
  }

  getDraggingCell() {
    return this.draggingCellId;
  }

  scrollUp() {
    if (!this.cellsContainer) return;
    const scrollPos = lumine.config.get("jupyter-view.notebook.scrollPos") ?? 1;
    this._smoothScrollBy(-this.cellsContainer.offsetHeight * scrollPos);
  }

  scrollDown() {
    if (!this.cellsContainer) return;
    const scrollPos = lumine.config.get("jupyter-view.notebook.scrollPos") ?? 1;
    this._smoothScrollBy(+this.cellsContainer.offsetHeight * scrollPos);
  }

  _smoothScrollBy(deltaY) {
    const scrollDiv = lumine.config.get("jupyter-view.notebook.scrollDiv") ?? 20;
    this._pendingScrollY = deltaY + (scrollDiv - 1) * Math.sign(deltaY);
    if (this._scrollAnimId) return;
    const animate = () => {
      const container = this.cellsContainer;
      if (!container || this._pendingScrollY === 0) {
        this._scrollAnimId = null;
        return;
      }
      const div = lumine.config.get("jupyter-view.notebook.scrollDiv") ?? 20;
      const step = Math.trunc(this._pendingScrollY / div);
      if (step !== 0) {
        container.scrollTop += step;
        this._pendingScrollY -= step;
      } else {
        container.scrollTop += this._pendingScrollY;
        this._pendingScrollY = 0;
      }
      this._scrollAnimId = this._pendingScrollY !== 0 ? requestAnimationFrame(animate) : null;
    };
    this._scrollAnimId = requestAnimationFrame(animate);
  }

  destroy() {
    if (this._tooltips) {
      this._tooltips.dispose();
      this._tooltips = null;
    }

    // Stop any drag lifecycle work before destroying its DOM.
    this.finishCellDrag();

    if (this._scrollAnimId) {
      cancelAnimationFrame(this._scrollAnimId);
      this._scrollAnimId = null;
    }

    // Remove global mouse up listener
    if (this._handleGlobalMouseUp) {
      document.removeEventListener("mouseup", this._handleGlobalMouseUp);
      this._handleGlobalMouseUp = null;
    }

    // Remove cell drag listeners
    if (this._dragContainer && this._dragOverHandler) {
      this._dragContainer.removeEventListener("dragenter", this._dragEnterHandler, true);
      this._dragContainer.removeEventListener("dragover", this._dragOverHandler, true);
      this._dragContainer.removeEventListener("dragleave", this._dragLeaveHandler, true);
      this._dragContainer.removeEventListener("drop", this._dropHandler, true);
    }
    this._dragWindow?.removeEventListener("dragend", this._dragEndHandler, true);
    this._dragWindow?.removeEventListener("blur", this._dragWindowBlurHandler, true);
    this._dragContainer = null;
    this._dragWindow = null;
    this._dragEnterHandler = null;
    this._dragOverHandler = null;
    this._dragLeaveHandler = null;
    this._dropHandler = null;
    this._dragEndHandler = null;
    this._dragWindowBlurHandler = null;

    this.scrollCallbacks.clear();
    this.selectionCallbacks.clear();

    // Dispose scrollPastEnd config observer
    if (this._scrollPastEndDisposable) {
      this._scrollPastEndDisposable.dispose();
      this._scrollPastEndDisposable = null;
    }

    // Disconnect resize observer
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    this._observedContainer = null;
    // The cell views are children of this component, so they go with it — and
    // synchronously, because each one owns a TextEditor that has to be released
    // when the notebook closes rather than on some later frame.
    return etch.destroySync(this);
  }
}

module.exports = NotebookView;
