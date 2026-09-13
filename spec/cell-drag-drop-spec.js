const NotebookDocument = require("../lib/notebook-document");
const JupyterNotebookEditor = require("../lib/jupyter-notebook-editor");
const { cellDragTypeForDocument, readCellDrag } = require("../lib/cell-drag");

class TestDataTransfer {
  constructor() {
    this.data = new Map();
    this.files = [];
    this.items = [];
    this.dropEffect = "none";
    this.effectAllowed = "all";
    this.mode = "readwrite";
  }

  get types() {
    return [...this.data.keys()];
  }

  setData(type, value) {
    if (this.mode === "readwrite") this.data.set(type, value);
  }

  getData(type) {
    return this.mode === "protected" ? "" : this.data.get(type) || "";
  }
}

function dragEvent(type, target, dataTransfer, { y = 75, relatedTarget = null } = {}) {
  const event = new CustomEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    clientX: { value: 50 },
    clientY: { value: y },
    relatedTarget: { value: relatedTarget },
  });
  target.dispatchEvent(event);
  return event;
}

function notebookData(ids) {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
      language_info: { name: "python" },
    },
    cells: ids.map((id) => ({
      cell_type: "code",
      id,
      metadata: {},
      source: [`# ${id}`],
      execution_count: null,
      outputs: [],
    })),
  };
}

describe("notebook cell drag and drop", () => {
  let workspaceElement;
  let notebooks;
  let documentDragOver;

  beforeEach(() => {
    workspaceElement = lumine.workspace.getElement();
    jasmine.attachToDOM(workspaceElement);
    notebooks = [];
    documentDragOver = jasmine
      .createSpy("document dragover fallback")
      .and.callFake((event) => (event.dataTransfer.dropEffect = "none"));
    document.addEventListener("dragover", documentDragOver);
  });

  afterEach(() => {
    document.removeEventListener("dragover", documentDragOver);
    for (const { document: document_, editor } of notebooks) {
      if (!editor._destroyed) editor.destroy();
      if (document_.refCount <= 0) document_.destroy();
    }
  });

  async function buildNotebook(ids) {
    const document_ = new NotebookDocument(null);
    await document_.initializeFromData(notebookData(ids));
    const editor = new JupyterNotebookEditor(document_);
    await editor._sourceEditorSetupPromise;
    workspaceElement.appendChild(editor._containerElement);
    const notebook = { document: document_, editor };
    notebooks.push(notebook);
    return notebook;
  }

  function cellElement(editor, cellId) {
    return editor.view.cellViews.get(cellId).element;
  }

  function startDrag(notebook, cellId) {
    const dataTransfer = new TestDataTransfer();
    const gutter = cellElement(notebook.editor, cellId).querySelector(".cell-gutter");
    dragEvent("dragstart", gutter, dataTransfer);
    return dataTransfer;
  }

  function dropBelow(notebook, cellId, dataTransfer) {
    const target = cellElement(notebook.editor, cellId);
    spyOn(target, "getBoundingClientRect").and.returnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    });
    dataTransfer.mode = "protected";
    const dragOver = dragEvent("dragover", target, dataTransfer);
    dataTransfer.mode = "readonly";
    const drop = dragEvent("drop", target, dataTransfer);
    return { dragOver, drop };
  }

  it("keeps an accepted dragover away from the document fallback", async () => {
    const notebook = await buildNotebook(["a", "b"]);
    const dataTransfer = startDrag(notebook, "a");
    const payload = readCellDrag(dataTransfer);

    expect(payload).toEqual({
      sourceDocumentId: notebook.document.id,
      primaryCellId: "a",
      cellIds: ["a"],
    });

    const target = cellElement(notebook.editor, "b");
    spyOn(target, "getBoundingClientRect").and.returnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    });
    dataTransfer.mode = "protected";
    const event = dragEvent("dragover", target, dataTransfer);

    expect(event.defaultPrevented).toBe(true);
    expect(documentDragOver).not.toHaveBeenCalled();
    expect(dataTransfer.dropEffect).toBe("move");
  });

  it("keeps the move accepted through a gap and drops at that boundary", async () => {
    const notebook = await buildNotebook(["a", "b", "c"]);
    const cellA = cellElement(notebook.editor, "a");
    const cellB = cellElement(notebook.editor, "b");
    spyOn(cellA, "getBoundingClientRect").and.returnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    });
    spyOn(cellB, "getBoundingClientRect").and.returnValue({
      left: 0,
      top: 110,
      right: 100,
      bottom: 210,
      width: 100,
      height: 100,
    });
    const dataTransfer = startDrag(notebook, "c");
    dataTransfer.mode = "protected";

    dataTransfer.dropEffect = "none";
    const dragEnter = dragEvent("dragenter", notebook.editor.view.cellsContainer, dataTransfer, {
      y: 105,
    });
    expect(dragEnter.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("move");

    spyOn(document, "elementFromPoint").and.returnValue(notebook.editor.view.cellsContainer);
    dataTransfer.dropEffect = "none";
    dragEvent("dragleave", cellA, dataTransfer, {
      y: 105,
      // Chromium may report this as null even while crossing descendants.
      relatedTarget: null,
    });
    expect(dataTransfer.dropEffect).toBe("move");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(cellB.classList.contains("drop-above")).toBe(true);

    dataTransfer.dropEffect = "none";
    const dragOver = dragEvent("dragover", notebook.editor.view.cellsContainer, dataTransfer, {
      y: 105,
    });
    expect(dragOver.defaultPrevented).toBe(true);
    expect(documentDragOver).not.toHaveBeenCalled();
    expect(dataTransfer.dropEffect).toBe("move");
    expect(cellB.classList.contains("drop-above")).toBe(true);

    dataTransfer.mode = "readonly";
    const drop = dragEvent("drop", notebook.editor.view.cellsContainer, dataTransfer, { y: 105 });
    expect(drop.defaultPrevented).toBe(true);
    expect(notebook.document.cells.map((cell) => cell.id)).toEqual(["a", "c", "b"]);
  });

  it("uses one canonical marker for both sides of an interior boundary", async () => {
    const notebook = await buildNotebook(["a", "b", "c"]);
    const cellA = cellElement(notebook.editor, "a");
    const cellB = cellElement(notebook.editor, "b");
    spyOn(cellA, "getBoundingClientRect").and.returnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    });
    spyOn(cellB, "getBoundingClientRect").and.returnValue({
      left: 0,
      top: 110,
      right: 100,
      bottom: 210,
      width: 100,
      height: 100,
    });
    const dataTransfer = startDrag(notebook, "c");
    dataTransfer.mode = "protected";

    dragEvent("dragover", cellA, dataTransfer, { y: 75 });
    expect(cellA.classList.contains("drop-below")).toBe(false);
    expect(cellB.classList.contains("drop-above")).toBe(true);

    dragEvent("dragover", notebook.editor.view.cellsContainer, dataTransfer, { y: 105 });
    expect(cellA.classList.contains("drop-below")).toBe(false);
    expect(cellB.classList.contains("drop-above")).toBe(true);
  });

  it("gives one boundary the same drop semantics from either side", async () => {
    const throughCell = await buildNotebook(["a", "b", "c", "d"]);
    throughCell.editor.view.selectedCells = new Set([0, 2]);
    const cellTransfer = startDrag(throughCell, "a");
    const cellA = cellElement(throughCell.editor, "a");
    spyOn(cellA, "getBoundingClientRect").and.returnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    });
    cellTransfer.mode = "readonly";
    dragEvent("drop", cellA, cellTransfer, { y: 75 });

    const throughGap = await buildNotebook(["a", "b", "c", "d"]);
    throughGap.editor.view.selectedCells = new Set([0, 2]);
    const gapTransfer = startDrag(throughGap, "a");
    const gapA = cellElement(throughGap.editor, "a");
    const gapB = cellElement(throughGap.editor, "b");
    spyOn(gapA, "getBoundingClientRect").and.returnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    });
    spyOn(gapB, "getBoundingClientRect").and.returnValue({
      left: 0,
      top: 110,
      right: 100,
      bottom: 210,
      width: 100,
      height: 100,
    });
    gapTransfer.mode = "readonly";
    dragEvent("drop", throughGap.editor.view.cellsContainer, gapTransfer, { y: 105 });

    expect(throughCell.document.cells.map((cell) => cell.id)).toEqual(["a", "c", "b", "d"]);
    expect(throughGap.document.cells.map((cell) => cell.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("moves a cell using stable ids from the drag payload", async () => {
    const notebook = await buildNotebook(["a", "b", "c"]);
    const dataTransfer = startDrag(notebook, "a");

    const { drop } = dropBelow(notebook, "b", dataTransfer);

    expect(drop.defaultPrevented).toBe(true);
    expect(notebook.document.cells.map((cell) => cell.id)).toEqual(["b", "a", "c"]);
    expect(notebook.editor.activeCellIndex).toBe(1);
    expect(notebook.editor.view.getSelectedCells()).toEqual([1]);
  });

  it("moves multiple selected cells without changing their order", async () => {
    const notebook = await buildNotebook(["a", "b", "c", "d"]);
    notebook.editor.view.selectedCells = new Set([0, 1]);
    const dataTransfer = startDrag(notebook, "a");

    expect(readCellDrag(dataTransfer)).toEqual({
      sourceDocumentId: notebook.document.id,
      primaryCellId: "a",
      cellIds: ["a", "b"],
    });
    const selectionChanged = jasmine.createSpy("selection changed");
    const subscription = notebook.editor.view.onDidChangeSelection(selectionChanged);

    dropBelow(notebook, "d", dataTransfer);

    expect(notebook.document.cells.map((cell) => cell.id)).toEqual(["c", "d", "a", "b"]);
    expect(notebook.editor.activeCellIndex).toBe(2);
    expect(notebook.editor.view.getSelectedCells()).toEqual([2, 3]);
    expect(selectionChanged.calls.allArgs()).toEqual([[[2, 3]]]);
    subscription.dispose();
  });

  it("preserves a noncontiguous selection and activates the dragged primary cell", async () => {
    const notebook = await buildNotebook(["a", "b", "c", "d", "e"]);
    notebook.editor.view.selectedCells = new Set([0, 2]);
    notebook.editor.setActiveCell(4);
    const dataTransfer = startDrag(notebook, "c");

    expect(readCellDrag(dataTransfer)).toEqual({
      sourceDocumentId: notebook.document.id,
      primaryCellId: "c",
      cellIds: ["a", "c"],
    });

    dropBelow(notebook, "d", dataTransfer);

    expect(notebook.document.cells.map((cell) => cell.id)).toEqual(["b", "d", "a", "c", "e"]);
    expect(notebook.editor.activeCellIndex).toBe(3);
    expect(notebook.editor.view.getSelectedCells()).toEqual([2, 3]);
  });

  it("resolves dragged and target cell ids again when structure changes mid-drag", async () => {
    const notebook = await buildNotebook(["a", "b", "c", "d"]);
    const dataTransfer = startDrag(notebook, "a");

    const inserted = notebook.document.insertCell(0, "code");
    dropBelow(notebook, "c", dataTransfer);

    expect(notebook.document.cells.map((cell) => cell.id)).toEqual([
      inserted.id,
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("rejects a cell drop from a different notebook document", async () => {
    const source = await buildNotebook(["a", "b"]);
    const target = await buildNotebook(["x", "y"]);
    const dataTransfer = startDrag(source, "a");

    const { dragOver } = dropBelow(target, "y", dataTransfer);

    expect(dragOver.defaultPrevented).toBe(true);
    expect(documentDragOver).toHaveBeenCalled();
    expect(dataTransfer.dropEffect).toBe("none");
    expect(cellElement(target.editor, "y").classList.contains("drop-below")).toBe(false);
    expect(source.document.cells.map((cell) => cell.id)).toEqual(["a", "b"]);
    expect(target.document.cells.map((cell) => cell.id)).toEqual(["x", "y"]);
  });

  it("cleans every split of a notebook when a drag is cancelled", async () => {
    const source = await buildNotebook(["a", "b"]);
    const targetEditor = new JupyterNotebookEditor(source.document);
    await targetEditor._sourceEditorSetupPromise;
    workspaceElement.appendChild(targetEditor._containerElement);
    const target = { document: source.document, editor: targetEditor };
    notebooks.push(target);
    const dataTransfer = startDrag(source, "a");
    const targetCell = cellElement(target.editor, "b");
    spyOn(targetCell, "getBoundingClientRect").and.returnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    });
    dataTransfer.mode = "protected";
    dragEvent("dragover", targetCell, dataTransfer, { y: 25 });
    expect(targetCell.classList.contains("drop-above")).toBe(true);

    const sourceGutter = cellElement(source.editor, "a").querySelector(".cell-gutter");
    dragEvent("dragend", sourceGutter, dataTransfer);

    expect(cellElement(source.editor, "a").classList.contains("dragging")).toBe(false);
    expect(targetCell.classList.contains("drop-above")).toBe(false);
  });

  it("does not record history for an adjacent no-op drop", async () => {
    const notebook = await buildNotebook(["a", "b", "c"]);
    const dataTransfer = startDrag(notebook, "a");
    const historyStateId = notebook.document.currentHistoryStateId;
    const didChange = jasmine.createSpy("did change");
    const subscription = notebook.document.onDidChange(didChange);

    const target = cellElement(notebook.editor, "b");
    spyOn(target, "getBoundingClientRect").and.returnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    });
    dataTransfer.mode = "readonly";
    dragEvent("drop", target, dataTransfer, { y: 25 });

    expect(notebook.document.cells.map((cell) => cell.id)).toEqual(["a", "b", "c"]);
    expect(notebook.document.currentHistoryStateId).toBe(historyStateId);
    expect(didChange).not.toHaveBeenCalled();
    subscription.dispose();
  });

  it("atomically rejects malformed and missing-cell payloads", async () => {
    const notebook = await buildNotebook(["a", "b", "c"]);
    const target = cellElement(notebook.editor, "c");
    spyOn(target, "getBoundingClientRect").and.returnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    });
    const dataTransfer = new TestDataTransfer();

    dataTransfer.setData(cellDragTypeForDocument(notebook.document.id), "{");
    dataTransfer.mode = "readonly";
    dragEvent("drop", target, dataTransfer);
    expect(notebook.document.cells.map((cell) => cell.id)).toEqual(["a", "b", "c"]);

    dataTransfer.mode = "readwrite";
    dataTransfer.setData(
      cellDragTypeForDocument(notebook.document.id),
      JSON.stringify({
        sourceDocumentId: notebook.document.id,
        primaryCellId: "missing",
        cellIds: ["missing"],
      }),
    );
    dataTransfer.mode = "readonly";
    dragEvent("drop", target, dataTransfer);
    expect(notebook.document.cells.map((cell) => cell.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps drag classes and the marker across a cell render", async () => {
    const notebook = await buildNotebook(["a", "b", "c"]);
    const dataTransfer = startDrag(notebook, "c");
    const cellB = cellElement(notebook.editor, "b");
    spyOn(cellB, "getBoundingClientRect").and.returnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    });
    dataTransfer.mode = "protected";
    dragEvent("dragover", cellB, dataTransfer, { y: 25 });

    await notebook.editor.view.updateCells(["b", "c"]);

    expect(cellElement(notebook.editor, "b").classList.contains("drop-above")).toBe(true);
    expect(cellElement(notebook.editor, "c").classList.contains("dragging")).toBe(true);

    const gutter = cellElement(notebook.editor, "c").querySelector(".cell-gutter");
    dragEvent("dragend", gutter, dataTransfer);
    await Promise.all([
      notebook.editor.view.cellViews.get("b").update(notebook.editor.view.cellViews.get("b").props),
      notebook.editor.view.cellViews.get("c").update(notebook.editor.view.cellViews.get("c").props),
    ]);

    expect(cellElement(notebook.editor, "b").classList.contains("drop-above")).toBe(false);
    expect(cellElement(notebook.editor, "c").classList.contains("dragging")).toBe(false);
  });

  it("ends the drag if a dragged cell disappears during a structural update", async () => {
    const notebook = await buildNotebook(["a", "b"]);
    const dataTransfer = startDrag(notebook, "a");
    const cellB = cellElement(notebook.editor, "b");
    spyOn(cellB, "getBoundingClientRect").and.returnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    });
    dataTransfer.mode = "protected";
    dragEvent("dragover", cellB, dataTransfer);
    notebook.editor.view._autoScrollSpeed = 1;
    notebook.editor.view.startAutoScroll();

    notebook.document.deleteCell(0);

    expect(notebook.editor.view.getDraggingCell()).toBe(null);
    expect(notebook.editor.view.draggingCellIds.size).toBe(0);
    expect(notebook.editor.view._autoScrollInterval).toBe(null);
    expect(cellB.classList.contains("drop-above")).toBe(false);
    expect(cellB.classList.contains("drop-below")).toBe(false);
  });

  it("lets external drags bubble without starting notebook auto-scroll", async () => {
    const notebook = await buildNotebook(["a", "b"]);
    const target = cellElement(notebook.editor, "b");
    const startAutoScroll = spyOn(notebook.editor.view, "startAutoScroll");
    const dataTransfer = new TestDataTransfer();
    dataTransfer.setData("text/plain", "external");
    dataTransfer.mode = "protected";

    dragEvent("dragover", target, dataTransfer);

    expect(startAutoScroll).not.toHaveBeenCalled();
    expect(documentDragOver).toHaveBeenCalled();
  });
});
