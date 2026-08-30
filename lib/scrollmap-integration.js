const { CompositeDisposable, Disposable } = require("lumine");

const LINTER_SEVERITIES = new Set(["error", "warning", "info", "hint"]);

class NotebookScrollmap {
  constructor(editor, Simplemap) {
    this.editor = editor;
    this.Simplemap = Simplemap;
    this.headers = [];
    this.linterMessages = [];
    this.scrollmap = null;
    this.frame = null;
    this.observedContainer = null;
    this.selectionDispose = null;
    this.disposables = new CompositeDisposable();
    this.resizeObserver = new ResizeObserver(() => this.scheduleUpdate());

    this.disposables.add(
      editor.observeNavigationHeaders((headers) => {
        this.headers = flattenHeaders(headers || []);
        this.scheduleUpdate();
      }),
      editor.onDidChange?.(() => this.scheduleUpdate()),
      lumine.workspace.onDidChangeActivePaneItem((item) => {
        if (item === this.editor) {
          this.scheduleUpdate();
        }
      }),
      lumine.config.onDidChange("jupyter-view.scrollmap.enabled", () => this.scheduleUpdate()),
      lumine.config.onDidChange("jupyter-view.scrollmap.threshold", () => this.scheduleUpdate()),
      lumine.config.onDidChange("jupyter-view.scrollmap.depth", () => this.scheduleUpdate()),
      lumine.config.onDidChange("jupyter-view.input.maxHeight", () => this.scheduleUpdate()),
      lumine.config.onDidChange("jupyter-view.output.maxHeight", () => this.scheduleUpdate()),
      new Disposable(() => this.resizeObserver.disconnect()),
    );

    this.insertScrollmap();
    this.attachSelectionListener();
    this.scheduleUpdateAfterLoad();
    this.scheduleUpdate();
  }

  destroy() {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.disposables.dispose();
    this.scrollmap?.destroy();
    this.scrollmap = null;
    this.editor = null;
    this.headers = [];
    this.selectionDispose = null;
  }

  scheduleUpdate() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.update();
    });
  }

  scheduleUpdateAfterLoad() {
    const loadingPromise = this.editor?._loadingPromise;
    if (!loadingPromise) return;
    loadingPromise.finally(() => {
      if (this.editor) {
        this.scheduleUpdate();
      }
    });
  }

  insertScrollmap() {
    const notebookElement = this.editor?.view?.element;
    if (!notebookElement) {
      return false;
    }

    if (!this.scrollmap) {
      this.scrollmap = new this.Simplemap();
      this.scrollmap.element.classList.add("jupyter-header-map");
    }

    const element = this.scrollmap.element;
    if (element.parentNode !== notebookElement) {
      element.remove();
      notebookElement.appendChild(element);
    }
    return true;
  }

  update() {
    if (!this.editor || !this.Simplemap) return;
    if (!this.insertScrollmap()) {
      return;
    }

    if (!this.isEnabled()) {
      this.scrollmap.element.style.display = "none";
      this.scrollmap.setItems([]);
      return;
    }

    const view = this.editor.view;
    const container = view?.cellsContainer;
    if (!container || !this.scrollmap) {
      return;
    }
    this.attachSelectionListener();
    this.scrollmap.element.style.display = "block";

    if (this.observedContainer !== container) {
      this.resizeObserver.disconnect();
      this.resizeObserver.observe(container);
      this.observedContainer = container;
    }

    this.positionMap(view, container);

    const scrollHeight = container.scrollHeight;
    if (!scrollHeight || scrollHeight <= container.clientHeight) {
      this.scrollmap.setItems([]);
      return;
    }

    const selectionItems = this.cellMarkers(container).filter(Boolean);
    const headerItems = this.filteredHeaders()
      .map((header) => this.markerForHeader(header, container))
      .filter(Boolean);
    const linterItems = this.linterMarkers(container).filter(Boolean);
    const items = [...selectionItems, ...headerItems, ...linterItems].sort((a, b) => a.prc - b.prc);
    const threshold = this.getThreshold();

    if (threshold > 0 && items.length > threshold) {
      this.scrollmap.setItems([]);
      return;
    }

    this.scrollmap.setItems(items);
  }

  isEnabled() {
    return lumine.config.get("jupyter-view.scrollmap.enabled") !== false;
  }

  getThreshold() {
    return lumine.config.get("jupyter-view.scrollmap.threshold") || 0;
  }

  getDepth() {
    return lumine.config.get("jupyter-view.scrollmap.depth") || 0;
  }

  filteredHeaders() {
    const depth = this.getDepth();
    if (depth <= 0) return this.headers;
    return this.headers.filter((header) => (header.level || 1) <= depth);
  }

  attachSelectionListener() {
    const view = this.editor?.view;
    if (this.selectionDispose || !view?.onDidChangeSelection) return;
    this.selectionDispose = view.onDidChangeSelection(() => this.scheduleUpdate());
    this.disposables.add(this.selectionDispose);
  }

  positionMap(view, container) {
    const toolbar = view.element.querySelector(".jupyter-notebook-toolbar");
    const top = toolbar?.offsetHeight || 0;
    const bottom = Math.max(0, view.element.clientHeight - top - container.clientHeight);
    const scrollbarWidth = container.offsetWidth - container.clientWidth;
    this.scrollmap.element.style.top = `${top}px`;
    this.scrollmap.element.style.bottom = `${bottom}px`;
    this.scrollmap.element.style.width = `${scrollbarWidth || 12}px`;
  }

  markerForHeader(header, container) {
    const cell = this.editor.document?.cells?.[header.cellIndex];
    const cellView = cell ? this.editor.view?.cellViews?.get(cell.id) : null;
    const cellElement = cellView?.element;
    if (!cellElement) return null;

    const y = this.getHeaderOffset(header, cellView, cellElement, container);
    const prc = clamp((y / container.scrollHeight) * 100, 0, 100);
    const level = Math.max(1, Math.min(header.level || 1, 6));
    const cls = [`marker-jupyter-h${level}`];
    if (header.visibility > 0) cls.push("visible");
    if (header.currentCount > 0 || header.stackCount > 0) cls.push("current");

    return {
      prc,
      cls: cls.join(" "),
    };
  }

  cellMarkers(container) {
    const view = this.editor?.view;
    const mode = view?.getMode?.() === "edit" ? "edit" : "command";
    const markedCells = this.getMarkedCellIndexes(view);
    return markedCells.map(({ index, active }) => {
      const cell = this.editor.document?.cells?.[index];
      const element = cell ? view.cellViews?.get(cell.id)?.element : null;
      if (!element) return null;

      const top = elementTopInContainer(element, container);
      const bottom = top + element.offsetHeight;
      const prc = clamp((top / container.scrollHeight) * 100, 0, 100);
      const end = clamp((bottom / container.scrollHeight) * 100, prc, 100);

      return {
        prc,
        end,
        cls: active
          ? `marker-jupyter-active marker-jupyter-active-${mode}`
          : "marker-jupyter-selected",
      };
    });
  }

  setLinterMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    if (!this.editor?.ownsLinterMessage) {
      this.linterMessages = [];
      this.scheduleUpdate();
      return;
    }
    this.linterMessages = list.filter((m) => this.editor.ownsLinterMessage(m));
    this.scheduleUpdate();
  }

  linterMarkers(container) {
    if (!this.linterMessages.length) return [];
    return this.linterMessages
      .map((message) => this.markerForLinterMessage(message, container))
      .filter(Boolean);
  }

  markerForLinterMessage(message, container) {
    if (!this.editor?.getLinterMessageCellIndex) return null;
    const cellIndex = this.editor.getLinterMessageCellIndex(message);
    if (cellIndex == null || cellIndex < 0) return null;
    const cell = this.editor.document?.cells?.[cellIndex];
    if (!cell) return null;
    const cellView = this.editor.view?.cellViews?.get(cell.id);
    const cellElement = cellView?.element;
    if (!cellElement) return null;

    const position = message?.location?.position;
    const startRow = position?.start?.row ?? 0;
    const endRow = position?.end?.row ?? startRow;

    const cellTopInContainer = elementTopInContainer(cellElement, container);
    const cellEditor = cellView.editor;
    const cellEditorElement = cellView.editorElement;
    const lineHeight = cellEditor?.getLineHeightInPixels?.() || 0;

    let top;
    let bottom;
    if (cellEditorElement && lineHeight > 0) {
      const editorTop = elementTopInContainer(cellEditorElement, container);
      top = editorTop + startRow * lineHeight;
      bottom = editorTop + (endRow + 1) * lineHeight;
    } else {
      top = cellTopInContainer;
      bottom = cellTopInContainer + cellElement.offsetHeight;
    }

    const prc = clamp((top / container.scrollHeight) * 100, 0, 100);
    const end = clamp((bottom / container.scrollHeight) * 100, prc, 100);
    // Hints render here unlike marker-linter's opt-in: this strip is only
    // jupyter-view's own, so a parallel setting would double a niche view's
    // config surface for nothing.
    const severity = normalizeLinterSeverity(message?.severity);

    return {
      prc,
      end,
      cls: `left marker-linter ${severity}`,
    };
  }

  getMarkedCellIndexes(view) {
    if (!view) return [];
    const cells = new Map();
    for (const index of view.getSelectedCells?.() || []) {
      cells.set(index, { index, active: false, selected: true });
    }

    const activeIndex = this.editor?.activeCellIndex;
    if (activeIndex != null && activeIndex >= 0) {
      const existing = cells.get(activeIndex);
      cells.set(activeIndex, {
        index: activeIndex,
        active: true,
        selected: Boolean(existing?.selected),
      });
    }

    return Array.from(cells.values()).sort((a, b) => a.index - b.index);
  }

  getHeaderOffset(header, cellView, cellElement, container) {
    const heading = this.findRenderedHeading(header, cellElement);
    if (heading) {
      return elementTopInContainer(heading, container);
    }

    const editorElement = cellView.editorElement;
    const editor = cellView.editor;
    if (editorElement && editor) {
      const lineHeight = editor.getLineHeightInPixels?.() || 0;
      if (lineHeight > 0) {
        return elementTopInContainer(editorElement, container) + (header.cellRow || 0) * lineHeight;
      }
    }

    return elementTopInContainer(cellElement, container);
  }

  findRenderedHeading(header, cellElement) {
    const headings = Array.from(
      cellElement.querySelectorAll(
        ".markdown-rendered h1, .markdown-rendered h2, .markdown-rendered h3, " +
          ".markdown-rendered h4, .markdown-rendered h5, .markdown-rendered h6",
      ),
    );
    if (!headings.length) return null;

    const indexInCell = this.headers
      .filter((item) => item.cellIndex === header.cellIndex)
      .findIndex((item) => item === header);

    return headings[indexInCell] || headings[0];
  }
}

function flattenHeaders(headers, result = []) {
  for (const header of headers) {
    result.push(header);
    flattenHeaders(header.children || [], result);
  }
  return result;
}

function elementTopInContainer(element, container) {
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return container.scrollTop + elementRect.top - containerRect.top;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeLinterSeverity(severity) {
  if (LINTER_SEVERITIES.has(severity)) return severity;
  // Reachable in a release build: the hub validates severities only in dev mode,
  // so degrade a stray one to the neutral middle rather than paint it as error.
  return "info";
}

// Exposed for the specs: the class needs a live editor, this does not.
NotebookScrollmap.normalizeLinterSeverity = normalizeLinterSeverity;

module.exports = NotebookScrollmap;
