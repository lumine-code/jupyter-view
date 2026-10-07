const NotebookDocument = require("../lib/notebook-document");
const JupyterNotebookEditor = require("../lib/jupyter-notebook-editor");
const JupyterAdapterService = require("../lib/jupyter-adapter");

describe("jupyter adapter kernel language", () => {
  let document_;
  let editor;
  let adapter;

  beforeEach(async () => {
    await lumine.packages.activatePackage("language-python");
    await lumine.packages.activatePackage("language-ipython");
    await lumine.packages.activatePackage("language-json");
    await lumine.packages.activatePackage("language-text");
    document_ = new NotebookDocument(null);
    await document_.initialize();
    editor = new JupyterNotebookEditor(document_);
    await editor._sourceEditorSetupPromise;
    adapter = new JupyterAdapterService().getAdapterForItem(editor);
  });

  afterEach(() => {
    if (!editor._destroyed) editor.destroy();
    if (document_.refCount <= 0) document_.destroy();
  });

  it("uses the shared document as the stable kernel owner", () => {
    expect(adapter.getPaneItem()).toBe(editor);
    expect(adapter.getKernelOwner()).toBe(document_);
    expect(adapter.getAdapterId()).toBe(`jupyter-view:${document_.id}`);

    const split = editor.copy();
    const splitAdapter = new JupyterAdapterService().getAdapterForItem(split);
    expect(splitAdapter.getKernelOwner()).toBe(document_);
    expect(splitAdapter.getAdapterId()).toBe(adapter.getAdapterId());
    split.destroy();
  });

  it("keeps a cell syntax override separate from the notebook kernel grammar", () => {
    editor.setCellLanguage(0, "json");
    const target = adapter.getRunTarget(document_.getCell(0).id);
    expect(target.grammar.scopeName).toBe("source.json");
    expect(adapter.getKernelLanguage()).toBe("python");
    expect(adapter.getKernelGrammar().scopeName).toBe("source.python");
  });

  it("derives an explicit kernel's language without consulting a cell grammar", () => {
    editor.setCellLanguage(0, "json");
    expect(adapter.getKernelLanguage({ name: "julia-1.11", display_name: "Julia 1.11" })).toBe(
      "julia",
    );
    expect(adapter.getKernelLanguage({ name: "ir", language: "R" })).toBe("r");
    expect(
      adapter.getKernelGrammar({ name: "no-grammar", language: "unobtainium" }).scopeName,
    ).toBe("text.plain");
  });

  it("atomically replaces kernelspec and language_info after a successful binding", () => {
    document_.metadata = {
      custom: { keep: true },
      kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
      language_info: { name: "python", version: "3.10", stale: true },
    };
    const changes = [];
    document_.onDidChange((event) => changes.push(event));
    const update = spyOn(editor.view, "update").and.callThrough();

    const languageInfo = { name: "C++", version: "17", mimetype: "text/x-c++src" };
    expect(
      adapter.setKernelSpec(
        { name: "xeus-cpp17", display_name: "C++ 17", language: "cpp" },
        languageInfo,
      ),
    ).toBe(true);

    expect(document_.metadata).toEqual({
      custom: { keep: true },
      kernelspec: { name: "xeus-cpp17", display_name: "C++ 17", language: "C++" },
      language_info: languageInfo,
    });
    expect(changes.length).toBe(1);
    expect(changes[0].reason).toBe("notebook-metadata");
    expect(update).toHaveBeenCalled();
    expect(adapter.getKernelLanguage()).toBe("cpp");
  });

  it("does not alter metadata for an invalid kernelspec", () => {
    const metadata = structuredClone(document_.metadata);
    expect(adapter.setKernelSpec(null, { name: "R" })).toBe(false);
    expect(document_.metadata).toEqual(metadata);
  });

  it("fully refreshes every cell when source JSON changes metadata and one source", async () => {
    document_.insertCell(1, "code");
    editor.commitSourceEditorSnapshot("test-setup");
    const otherCell = document_.getCell(1);
    await globalThis.conditionPromise(() => editor.getCellEditorById(otherCell.id));
    const otherView = editor.view.cellViews.get(otherCell.id);
    const update = spyOn(otherView, "update").and.callThrough();
    const sourceEditor = editor.getFileTextEditor();
    const source = JSON.parse(sourceEditor.getText());
    source.cells[0].source = ["changed"];
    source.metadata.kernelspec = {
      name: "unobtainium",
      display_name: "Unobtainium",
      language: "unobtainium",
    };
    source.metadata.language_info = { name: "unobtainium", version: "1" };

    sourceEditor.setText(JSON.stringify(source, null, 2));
    await globalThis.conditionPromise(() => adapter.getKernelLanguage() === "unobtainium");
    await globalThis.conditionPromise(
      () => editor.getCellEditorById(otherCell.id)?.getGrammar()?.scopeName === "text.plain",
    );

    expect(update).toHaveBeenCalled();
    expect(document_.getCell(0).source).toBe("changed");
    expect(document_.metadata.language_info).toEqual({ name: "unobtainium", version: "1" });
  });

  it("updates a cell grammar when the same source edit changes another cell", async () => {
    document_.insertCell(1, "code");
    editor.commitSourceEditorSnapshot("test-setup");
    const firstCell = document_.getCell(0);
    const secondCell = document_.getCell(1);
    await globalThis.conditionPromise(() => editor.getCellEditorById(secondCell.id));
    const sourceEditor = editor.getFileTextEditor();
    const source = JSON.parse(sourceEditor.getText());
    source.cells[0].metadata = { vscode: { languageId: "json" } };
    source.cells[1].source = ["changed"];

    sourceEditor.setText(JSON.stringify(source, null, 2));
    await globalThis.conditionPromise(
      () => editor.getCellEditorById(firstCell.id)?.getGrammar()?.scopeName === "source.json",
    );

    expect(document_.getCell(0).metadata.vscode.languageId).toBe("json");
    expect(document_.getCell(1).source).toBe("changed");
  });

  it("uses stable cell ids for active, selected, and run targets", async () => {
    const first = document_.getCell(0);
    const second = document_.insertCell(1, "code");
    await globalThis.conditionPromise(() => editor.getCellEditorById(second.id));
    editor.setActiveCell(1);
    editor.view.selectedCells = new Set([0, 1]);

    expect(adapter.getActiveTargetId()).toBe(second.id);
    expect(adapter.getSelectedTargetIds()).toEqual([first.id, second.id]);
    expect(adapter.getRunTargetIds("all")).toEqual([first.id, second.id]);
    expect(adapter.getRunTarget(second.id)).toEqual(
      jasmine.objectContaining({ id: second.id, index: 1 }),
    );
    expect(adapter.getRunTarget(1)).toBeNull();

    adapter.setActiveTargetId(first.id);
    expect(editor.activeCellIndex).toBe(0);
  });

  it("resolves delayed execution callbacks by cell id after structural edits", () => {
    const original = document_.getCell(0);
    original.source = "original";
    const neighbor = document_.insertCell(1, "code");
    neighbor.source = "neighbor";
    const target = adapter.getRunTarget(original.id);
    expect(target.index).toBe(0);

    const inserted = document_.insertCell(0, "code");
    inserted.source = "inserted";
    document_.moveCell(1, 2);
    expect(document_.getCell(2)).toBe(original);
    expect(adapter.getRunTarget(original.id).index).toBe(2);

    adapter.beginTargetExecution(target);
    adapter.appendTargetOutput(target, { output_type: "stream", name: "stdout", text: "right" });
    adapter.setTargetExecutionCount(target, 17);
    adapter.finishTargetExecution(target, { lastExecutionTime: "0.1s" });

    expect(original.outputs).toEqual([{ output_type: "stream", name: "stdout", text: "right" }]);
    expect(original.executionCount).toBe(17);
    expect(original.status).toBeNull();
    expect(original.lastRunTimeText).toBe("0.1s");
    expect(inserted.outputs).toEqual([]);
    expect(neighbor.outputs).toEqual([]);

    document_.deleteCell(2);
    editor.setActiveCell(0);
    const setActiveCell = spyOn(editor, "setActiveCell").and.callThrough();
    adapter.beginTargetExecution(target);
    adapter.appendTargetOutput(target, { output_type: "stream", name: "stdout", text: "wrong" });
    adapter.setTargetExecutionCount(target, 99);
    adapter.finishTargetExecution(target, { lastExecutionTime: "9s" });
    adapter.focusTarget(target);
    adapter.focusTargetEditor(target);

    expect(inserted.outputs).toEqual([]);
    expect(inserted.executionCount).toBeNull();
    expect(neighbor.outputs).toEqual([]);
    expect(neighbor.executionCount).toBeNull();
    expect(setActiveCell).not.toHaveBeenCalled();
    expect(editor.activeCellIndex).toBe(0);
  });

  it("tracks parallel executions of one cell independently", () => {
    const cell = document_.getCell(0);
    const firstRun = adapter.getRunTarget(cell.id);
    const secondRun = adapter.getRunTarget(cell.id);
    const setRunning = spyOn(cell, "setRunning").and.callThrough();
    const clearRunning = spyOn(cell, "clearRunning").and.callThrough();

    adapter.clearTargetOutputs(firstRun);
    adapter.clearTargetOutputs(secondRun);
    adapter.beginTargetExecution(firstRun);
    adapter.beginTargetExecution(secondRun);
    expect(adapter._executionStartTimes.get(firstRun)).not.toBeUndefined();
    expect(adapter._executionStartTimes.get(secondRun)).not.toBeUndefined();
    expect(setRunning).toHaveBeenCalledTimes(1);

    adapter.cancelTargetExecution(firstRun);
    adapter.finishTargetExecution(firstRun, { lastExecutionTime: "first" });
    expect(clearRunning).not.toHaveBeenCalled();
    expect(adapter._executionStartTimes.has(firstRun)).toBe(false);
    expect(adapter._executionStartTimes.has(secondRun)).toBe(true);

    adapter.finishTargetExecution(secondRun, { lastExecutionTime: "second" });
    expect(clearRunning).toHaveBeenCalledTimes(1);
    expect(adapter._executionStartTimes.has(secondRun)).toBe(false);
    expect(cell.lastRunTimeText).toBe("second");
  });

  it("retires a finished job once before its lease is disposed", () => {
    const cell = document_.getCell(0);
    const target = adapter.getRunTarget(cell.id);
    const clear = spyOn(cell, "clearRunning").and.callThrough();
    const lease = adapter.beginTargetExecution(target);
    adapter.finishTargetExecution(target, { lastExecutionTime: "done" });
    lease.dispose();
    lease.dispose();
    adapter.finishTargetExecution(target, { lastExecutionTime: "late" });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(cell.lastRunTimeText).toBe("done");
    expect(adapter._executionStartTimes.has(target)).toBe(false);
  });

  it("retires only a cancelled lease while another job keeps the cell running", () => {
    const cell = document_.getCell(0);
    const first = adapter.getRunTarget(cell.id);
    const second = adapter.getRunTarget(cell.id);
    const clear = spyOn(cell, "clearRunning").and.callThrough();
    const previous = adapter.beginTargetExecution(first);
    const current = adapter.beginTargetExecution(second);
    previous.dispose();
    previous.dispose();
    expect(adapter._executionStartTimes.has(first)).toBe(false);
    expect(adapter._executionStartTimes.has(second)).toBe(true);
    expect(clear).not.toHaveBeenCalled();
    expect(cell.startTime).not.toBeNull();
    adapter.finishTargetExecution(second, { lastExecutionTime: "current" });
    current.dispose();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(cell.lastRunTimeText).toBe("current");
  });

  it("keeps a replacement job when an older lease used the same target object", () => {
    const cell = document_.getCell(0);
    const target = adapter.getRunTarget(cell.id);
    const previous = adapter.beginTargetExecution(target);
    const current = adapter.beginTargetExecution(target);
    previous.dispose();
    expect(adapter._executionStartTimes.has(target)).toBe(true);
    expect(cell.startTime).not.toBeNull();
    adapter.finishTargetExecution(target, { lastExecutionTime: "replacement" });
    current.dispose();
    expect(cell.startTime).toBeNull();
    expect(cell.lastRunTimeText).toBe("replacement");
  });

  it("does not mutate destroyed document models when its lease is disposed late", () => {
    const cell = document_.getCell(0);
    const clear = spyOn(cell, "clearRunning").and.callThrough();
    const lease = adapter.beginTargetExecution(adapter.getRunTarget(cell.id));
    editor.destroy();
    expect(document_.isDestroyed()).toBe(true);
    expect(() => lease.dispose()).not.toThrow();
    expect(clear).not.toHaveBeenCalled();
  });

  it("rolls back partially subscribed begin state and permits a healthy retry", () => {
    const { Disposable } = require("lumine");
    const disposed = jasmine.createSpy("partial observer disposed");
    const session = {
      onDidChangeExecutionState: () => new Disposable(disposed),
      onDidChangeGeneration() {
        throw new Error("observer rejected");
      },
    };
    const cell = document_.getCell(0);
    const target = adapter.getRunTarget(cell.id);
    const running = spyOn(cell, "setRunning").and.callThrough();
    expect(() => adapter.beginTargetExecution(target, { kernel: session })).toThrowError(
      "observer rejected",
    );
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(running).not.toHaveBeenCalled();
    expect(adapter._executionStartTimes.has(target)).toBe(false);
    session.onDidChangeGeneration = () => new Disposable();
    const lease = adapter.beginTargetExecution(target, { kernel: session });
    lease.dispose();
    expect(running).toHaveBeenCalledTimes(1);
    expect(cell.startTime).toBeNull();
  });

  it("releases a timer installed before a running-state hook rejects begin", () => {
    const cell = document_.getCell(0);
    const target = adapter.getRunTarget(cell.id);
    const setRunning = cell.setRunning;
    spyOn(cell, "setRunning").and.callFake(() => {
      setRunning.call(cell);
      throw new Error("running hook rejected");
    });
    expect(() => adapter.beginTargetExecution(target)).toThrowError("running hook rejected");
    expect(cell.startTime).toBeNull();
    expect(cell._runningTimer).toBeNull();
    expect(adapter._executionStartTimes.has(target)).toBe(false);
  });

  it("rolls back both observer groups when provenance subscription rejects begin", () => {
    const { Emitter } = require("lumine");
    const events = new Emitter();
    let generations = 0;
    const session = {
      generation: 1,
      onDidChangeExecutionState: (callback) => events.on("state", callback),
      onDidChangeGeneration(callback) {
        if (++generations === 2) throw new Error("provenance observer rejected");
        return events.on("generation", callback);
      },
    };
    const cell = document_.getCell(0);
    const target = adapter.getRunTarget(cell.id);
    const running = spyOn(cell, "setRunning").and.callThrough();
    expect(() => adapter.beginTargetExecution(target, { kernel: session })).toThrowError(
      "provenance observer rejected",
    );
    expect(events.handlersByEventName.state).toBeUndefined();
    expect(events.handlersByEventName.generation).toBeUndefined();
    expect(running).not.toHaveBeenCalled();
    expect(adapter._executionStartTimes.has(target)).toBe(false);
    events.dispose();
  });

  it("returns a safely disposable lease after the document closes reentrantly during begin", () => {
    const cell = document_.getCell(0);
    const target = adapter.getRunTarget(cell.id);
    const setRunning = cell.setRunning;
    spyOn(cell, "setRunning").and.callFake(() => {
      setRunning.call(cell);
      document_.destroy();
    });
    const clear = spyOn(cell, "clearRunning").and.callThrough();
    const lease = adapter.beginTargetExecution(target);
    expect(typeof lease.dispose).toBe("function");
    expect(() => lease.dispose()).not.toThrow();
    expect(clear).not.toHaveBeenCalled();
    expect(cell._runningTimer).toBeNull();
  });

  it("clears shared document timers for session shutdown through any API", () => {
    const { Emitter } = require("lumine");
    const events = new Emitter();
    const session = {
      generation: 1,
      onDidChangeExecutionState: (callback) => events.on("state", callback),
      onDidChangeGeneration: (callback) => events.on("generation", callback),
    };
    const target = adapter.getRunTarget(document_.getCell(0).id);
    const clear = spyOn(document_, "clearAllCellTimers").and.callThrough();
    adapter.beginTargetExecution(target, { kernel: session });
    adapter.beginTargetExecution(adapter.getRunTarget(target.id), { kernel: session });
    expect(events.handlersByEventName.state.length).toBe(2);
    events.emit("state", "shutting-down");
    expect(clear).toHaveBeenCalledTimes(1);
    expect(adapter._executionStartTimes.has(target)).toBe(false);
    events.dispose();
  });

  it("releases retired session observers while the notebook document stays open", () => {
    const { Emitter } = require("lumine");
    const events = new Emitter();
    const session = {
      generation: 1,
      onDidChangeExecutionState: (callback) => events.on("state", callback),
      onDidChangeGeneration: (callback) => events.on("generation", callback),
      onDidDestroy: (callback) => events.on("destroy", callback),
    };
    adapter.beginTargetExecution(adapter.getRunTarget(document_.getCell(0).id), {
      kernel: session,
    });
    expect(events.handlersByEventName.state.length).toBe(2);
    events.emit("destroy");
    expect(events.handlersByEventName.state).toBeUndefined();
    expect(events.handlersByEventName.generation).toBeUndefined();
    expect(document_.isDestroyed()).toBe(false);
    events.dispose();
  });

  it("keeps a replacement session's timers when the previous session finishes shutting down", () => {
    const { Emitter } = require("lumine");
    const previousEvents = new Emitter();
    const previous = {
      generation: 1,
      onDidChangeExecutionState: (callback) => previousEvents.on("state", callback),
      onDidDestroy: (callback) => previousEvents.on("destroy", callback),
    };
    const first = adapter.getRunTarget(document_.getCell(0).id);
    adapter.beginTargetExecution(first, { kernel: previous });
    adapter.finishTargetExecution(first, { lastExecutionTime: "first" });
    const current = adapter.getRunTarget(first.id);
    adapter.beginTargetExecution(current, { kernel: { generation: 1 } });
    const clear = spyOn(document_, "clearAllCellTimers").and.callThrough();
    previousEvents.emit("state", "shutting-down");
    previousEvents.emit("destroy");
    expect(clear).not.toHaveBeenCalled();
    expect(adapter._executionStartTimes.has(current)).toBe(true);
    adapter.finishTargetExecution(current, { lastExecutionTime: "current" });
    expect(document_.getCell(0).lastRunTimeText).toBe("current");
    previousEvents.dispose();
  });
});
