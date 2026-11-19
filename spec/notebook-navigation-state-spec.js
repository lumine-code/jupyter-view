const { CompositeDisposable, Emitter } = require("lumine");

describe("notebook navigation snapshots and state changes", () => {
  let editor, notebook, events, frames, subscriptions, scan, visible, publish;

  beforeEach(async () => {
    const NotebookDocument = require("../lib/notebook-document");
    const NotebookEditor = require("../lib/jupyter-notebook-editor");
    notebook = new NotebookDocument(null);
    await notebook.initializeFromData({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { id: "parent", cell_type: "markdown", source: "# Parent", metadata: {} },
        { id: "child", cell_type: "markdown", source: "## Child", metadata: {} },
        { id: "code", cell_type: "code", source: "print(1)", metadata: {}, outputs: [] },
        { id: "last", cell_type: "markdown", source: "# Last", metadata: {} },
      ],
    });
    events = new Emitter();
    frames = new Map();
    subscriptions = new CompositeDisposable();
    editor = Object.create(NotebookEditor.prototype);
    editor.document = notebook;
    editor.emitter = new Emitter();
    editor.disposables = new CompositeDisposable();
    editor.deferredCellCursors = new Map();
    editor.activeCellIndex = 1;
    editor.view = {
      selectedCells: new Set(),
      setActiveCellIndex() {},
      onDidScroll: (callback) => events.on("scroll", callback),
    };
    let frameId = 0;
    spyOn(editor, "requestFrame").and.callFake((callback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    spyOn(editor, "cancelFrame").and.callFake((frame) => frames.delete(frame));
    spyOn(editor, "updateView");
    spyOn(editor, "updateSourceEditorFromNotebook");
    visible = [0, 1];
    spyOn(editor, "getVisibleNavigationCellIndexes").and.callFake(() => visible);
    editor.subscribeToDocument();
    scan = spyOn(require("../lib/notebook-headings"), "collectHeadings").and.callThrough();
    publish = jasmine.createSpy("publish notebook navigation");
    subscriptions.add(editor.observeNavigationHeaders(publish));
    flush();
  });

  afterEach(() => {
    subscriptions.dispose();
    editor.disposables.dispose();
    editor.emitter.dispose();
    events.dispose();
    notebook.destroy();
  });

  function flush() {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback();
  }

  it("keeps the first tree and emits current, ancestor and visible deltas without rescanning", () => {
    const initial = publish.calls.mostRecent().args[0];
    const child = initial[0].children[0];
    expect(scan).toHaveBeenCalledTimes(1);
    editor.setActiveCell(3);
    visible = [3];
    events.emit("scroll");
    expect(frames.size).toBe(1);
    flush();
    expect(scan).toHaveBeenCalledTimes(1);
    const [headers, options] = publish.calls.mostRecent().args;
    expect(headers).toBeNull();
    expect(options.instant).toBe(true);
    expect(options.stateChanges).toEqual(
      jasmine.arrayContaining([
        { path: [0], currentCount: 0, stackCount: 0, visibility: 0 },
        { path: [0, 0], currentCount: 0, stackCount: 0, visibility: 0 },
        { path: [1], currentCount: 1, stackCount: 1, visibility: 1 },
      ]),
    );
    expect(initial[0].children[0]).toBe(child);
    expect(child.currentCount).toBe(0);
    expect(initial[1].currentCount).toBe(1);

    visible = [1];
    events.emit("scroll");
    flush();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(publish.calls.mostRecent().args[0]).toBeNull();
    expect(publish.calls.mostRecent().args[1].instant).toBe(false);
    expect(child.visibility).toBe(1);
  });

  it("retains independent trees and deltas for simultaneous panel and scrollmap observers", () => {
    const other = jasmine.createSpy("second navigation observer");
    subscriptions.add(editor.observeNavigationHeaders(other));
    flush();
    const firstTree = publish.calls.mostRecent().args[0];
    const secondTree = other.calls.mostRecent().args[0];
    expect(firstTree).not.toBe(secondTree);
    expect(firstTree[0].children[0]).not.toBe(secondTree[0].children[0]);
    expect(scan).toHaveBeenCalledTimes(1);
    editor.setActiveCell(3);
    visible = [3];
    flush();
    expect(publish.calls.mostRecent().args).toEqual(other.calls.mostRecent().args);
    expect(publish.calls.mostRecent().args[0]).toBeNull();
    expect(firstTree[1].currentCount).toBe(1);
    expect(secondTree[1].currentCount).toBe(1);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("rebuilds after source edits, cell moves and cell type changes", () => {
    notebook.updateCellSource(1, "## Renamed child");
    flush();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(publish.calls.mostRecent().args[0][0].children[0].text).toBe("Renamed child");
    expect(publish.calls.mostRecent().args[1].stateChanges).toBeUndefined();

    notebook.moveCell(3, 0);
    flush();
    expect(scan).toHaveBeenCalledTimes(3);
    expect(publish.calls.mostRecent().args[0].map((header) => header.text)).toEqual([
      "Last",
      "Parent",
    ]);
    expect(publish.calls.mostRecent().args[0][1].children[0].cellIndex).toBe(2);

    notebook.getCell(2).setType("code");
    flush();
    expect(scan).toHaveBeenCalledTimes(4);
    expect(publish.calls.mostRecent().args[0][1].children).toEqual([]);
    editor.setActiveCell(0);
    flush();
    expect(scan).toHaveBeenCalledTimes(4);
    expect(publish.calls.mostRecent().args[0]).toBeNull();
    expect(publish.calls.mostRecent().args[1].stateChanges).toEqual(
      jasmine.arrayContaining([{ path: [0], currentCount: 1, stackCount: 1, visibility: 1 }]),
    );
  });

  it("keeps cached headings through output, language and notebook metadata changes", () => {
    notebook.getCell(2).addOutput({ output_type: "stream", name: "stdout", text: "result" });
    notebook.getCell(2).setLanguage("javascript");
    notebook.updateMetadata({ title: "Notebook title" });
    flush();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(publish.calls.allArgs().filter(([headers]) => headers !== null).length).toBe(1);
    editor.setActiveCell(3);
    flush();
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("keeps scrollmap entries and marker indexes alive across state-only notifications", () => {
    const NotebookScrollmap = require("../lib/scrollmap-integration");
    spyOn(NotebookScrollmap.prototype, "insertScrollmap");
    spyOn(NotebookScrollmap.prototype, "attachSelectionListener");
    spyOn(NotebookScrollmap.prototype, "scheduleUpdateAfterLoad");
    spyOn(NotebookScrollmap.prototype, "scheduleUpdate");
    const scrollmap = new NotebookScrollmap(editor, class {});
    try {
      flush();
      const headers = scrollmap.headers;
      const indexes = scrollmap.headerIndexes;
      editor.setActiveCell(3);
      visible = [3];
      flush();
      expect(scrollmap.headers).toBe(headers);
      expect(scrollmap.headerIndexes).toBe(indexes);
      expect(headers.find((header) => header.cellIndex === 3).currentCount).toBe(1);
      expect(headers.find((header) => header.cellIndex === 3).visibility).toBe(1);
      expect(headers.find((header) => header.cellIndex === 1).currentCount).toBe(0);
      expect(scan).toHaveBeenCalledTimes(1);

      notebook.updateCellSource(1, "## New marker caption");
      flush();
      expect(scrollmap.headers).not.toBe(headers);
      expect(scrollmap.headerIndexes).not.toBe(indexes);
      expect(scrollmap.headers.some((header) => header.text === "New marker caption")).toBe(true);
    } finally {
      scrollmap.destroy();
    }
  });

  it("uses an empty state patch to repeat the preamble boundary without rebuilding", () => {
    notebook.updateCellSource(0, "Preamble without a heading");
    visible = [0];
    flush();
    expect(publish.calls.mostRecent().args[1].scrollBoundary).toBe("start");
    publish.calls.reset();
    scan.calls.reset();
    events.emit("scroll");
    flush();
    expect(publish).toHaveBeenCalledOnceWith(null, {
      instant: false,
      scrollBoundary: "start",
      stateChanges: [],
    });
    expect(scan).not.toHaveBeenCalled();
  });

  it("cancels queued updates and releases listeners after observer disposal and item teardown", () => {
    publish.calls.reset();
    scan.calls.reset();
    events.emit("scroll");
    expect(frames.size).toBe(1);
    subscriptions.dispose();
    expect(frames.size).toBe(0);
    notebook.updateCellSource(0, "# Changed while unobserved");
    events.emit("scroll");
    flush();
    expect(publish).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();

    const observation = editor.observeNavigationHeaders(publish);
    editor.emitter.emit("did-destroy");
    expect(frames.size).toBe(0);
    flush();
    expect(publish).not.toHaveBeenCalled();
    observation.dispose();
  });
});
