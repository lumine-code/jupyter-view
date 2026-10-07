const { CompositeDisposable } = require("lumine");

describe("notebook execution requests and provider lifecycle", () => {
  let main, notebook, active, edges;

  beforeEach(async () => {
    const pack = await lumine.packages.activatePackage("jupyter-view");
    main = pack.mainModule;
    const NotebookDocument = require("../lib/notebook-document");
    const NotebookEditor = require("../lib/jupyter-notebook-editor");
    edges = new CompositeDisposable();
    for (const name of ["language-json", "language-python", "language-text"]) {
      const grammar = await lumine.packages.activatePackage(name);
      await grammar.resourceLoadPromise;
    }
    const build = async () => {
      const document_ = new NotebookDocument(null);
      await document_.initialize();
      const item = new NotebookEditor(document_);
      await item._sourceEditorSetupPromise;
      return item;
    };
    notebook = await build();
    active = await build();
    notebook.document.updateCellSource(0, "original()");
    spyOn(main, "getActiveNotebook").and.returnValue(active);
  });

  afterEach(() => {
    edges.dispose();
    notebook.destroy();
    active.destroy();
  });

  const runtime = () => ({
    execute: jasmine
      .createSpy("execute")
      .and.callFake(() =>
        Promise.resolve({ accepted: true, done: Promise.resolve({ status: "ok" }) }),
      ),
  });
  const event = () => ({ target: notebook._containerElement });

  it("executes the dispatched notebook even when another notebook is active", async () => {
    const execution = runtime();
    edges.add(main.consumeJupyterExecution(execution));
    await main.executeNotebook("active", false, event());
    const request = execution.execute.calls.mostRecent().args[0];
    expect(request.item).toBe(notebook);
    expect(request.owner).toBe(notebook.document);
    expect(request.targets.map((target) => target.source)).toEqual(["original()"]);
  });

  it("captures the invocation's selected cells before runtime activation", async () => {
    const execution = runtime();
    const second = notebook.document.insertCell(1, "code");
    notebook.document.updateCellSource(1, "other()");
    main.executionService = null;
    let release;
    spyOn(lumine.packages, "requestService").and.returnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = main.executeNotebook("active", false, event());
    notebook.setActiveCell(1);
    edges.add(main.consumeJupyterExecution(execution));
    release(true);
    await pending;
    const request = execution.execute.calls.mostRecent().args[0];
    expect(request.targets.map((target) => target.source)).toEqual(["original()"]);
    expect(request.targets[0].id).not.toBe(second.id);
    expect(lumine.packages.requestService).toHaveBeenCalledWith("jupyter.execution", "^1.0.0");
  });

  it("cancels preparation when notebook source changes during activation", async () => {
    const execution = runtime();
    main.executionService = null;
    let release;
    spyOn(lumine.packages, "requestService").and.returnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = main.executeNotebook("all", false, event());
    notebook.document.updateCellSource(0, "changed()");
    edges.add(main.consumeJupyterExecution(execution));
    release(true);
    await pending;
    expect(execution.execute).not.toHaveBeenCalled();
  });

  it("does not revoke newer execution and rendering providers with stale disposables", () => {
    const previous = main.consumeJupyterExecution(runtime());
    const execution = runtime();
    edges.add(main.consumeJupyterExecution(execution));
    previous.dispose();
    expect(main.executionService).toBe(execution);
    const oldOutput = main.consumeJupyterOutput({});
    const output = {};
    edges.add(main.consumeJupyterOutput(output));
    oldOutput.dispose();
    expect(require("../lib/output-renderer").get()).toBe(output);
  });
});
