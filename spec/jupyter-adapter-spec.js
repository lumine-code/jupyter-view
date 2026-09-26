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
    expect(adapter.getKernelGrammar().scopeName).toBe("source.python.ipy");
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
});
