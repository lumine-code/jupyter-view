const { Emitter } = require("lumine");

describe("executed notebook definition provenance", () => {
  let navigation, document_, editor, kernel, events, documentEvents;
  const frame = () => ({
    filename: "<ipython-input-31-abcd>",
    line: 1,
    source: "@identity\ndef fn():\n    return 1",
    generation: 1,
  });

  function capture(index = 0, count = 31) {
    const cell = document_.cells[index];
    const target = { id: cell.id, source: cell.source, row: cell.source.split("\n").length - 1 };
    navigation.beginExecution(document_, target, kernel);
    navigation.recordCount(document_, target, count);
    return target;
  }

  beforeEach(() => {
    navigation = require("../lib/traceback-navigation");
    events = new Emitter();
    documentEvents = new Emitter();
    document_ = {
      cells: [
        { id: "definition", source: "@identity\ndef fn():\n    return 1" },
        { id: "caller", source: "fn()" },
      ],
      onDidDestroy: (callback) => documentEvents.on("destroy", callback),
    };
    editor = {
      document: document_,
      revealCellById: jasmine
        .createSpy("reveal definition cell")
        .and.returnValue(Promise.resolve()),
    };
    kernel = {
      generation: 1,
      executionState: "idle",
      destroyed: false,
      onDidChangeExecutionState: (callback) => events.on("state", callback),
    };
    capture();
  });
  afterEach(() => {
    documentEvents.emit("destroy");
    documentEvents.dispose();
    events.dispose();
  });

  it("exposes an adapter link to the stable cell id after cell reordering", async () => {
    const JupyterAdapterService = require("../lib/jupyter-adapter");
    editor.constructor = { name: "JupyterNotebookEditor" };
    const adapter = new JupyterAdapterService().getAdapterForItem(editor);
    document_.cells.reverse();
    await adapter.resolveSourceFrame(frame(), kernel).open();
    const [cellId, range, guard] = editor.revealCellById.calls.mostRecent().args;
    expect(cellId).toBe("definition");
    expect(range).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(guard()).toBe(true);
  });

  it("accepts explicit modern filename counts and never treats them as cell indices", () => {
    const query = { ...frame(), filename: "/tmp/ipykernel_77/abc.py", executionCount: 31 };
    expect(navigation.resolveSourceFrame(editor, kernel, query)).toBeTruthy();
    expect(
      navigation.resolveSourceFrame(editor, kernel, { ...query, executionCount: 1 }),
    ).toBeNull();
  });

  it("resolves through a surviving split of the same notebook document", async () => {
    editor._destroyed = true;
    const split = {
      document: document_,
      revealCellById: jasmine
        .createSpy("reveal surviving split")
        .and.returnValue(Promise.resolve()),
    };
    await navigation.resolveSourceFrame(split, kernel, frame()).open();
    expect(split.revealCellById.calls.mostRecent().args[0]).toBe("definition");
    expect(editor.revealCellById).not.toHaveBeenCalled();
  });

  it("does not mistake another notebook's or another kernel's history for this definition", () => {
    const other = {
      document: { cells: [{ id: "other", source: "@identity\ndef fn():\n    return 1" }] },
    };
    const target = { id: "other", source: other.document.cells[0].source, row: 2 };
    navigation.beginExecution(other.document, target, kernel);
    navigation.recordCount(other.document, target, 32);
    expect(navigation.resolveSourceFrame(other, kernel, frame())).toBeNull();
    expect(
      navigation.resolveSourceFrame(editor, { generation: kernel.generation }, frame()),
    ).toBeNull();
    expect(navigation.resolveSourceFrame(editor, kernel, frame())).toBeTruthy();
  });

  it("declines changed or deleted source cells and different runtime source", () => {
    expect(
      navigation.resolveSourceFrame(editor, kernel, { ...frame(), source: "@other" }),
    ).toBeNull();
    document_.cells[0].source = "changed()";
    expect(navigation.resolveSourceFrame(editor, kernel, frame())).toBeNull();
    document_.cells.shift();
    expect(navigation.resolveSourceFrame(editor, kernel, frame())).toBeNull();
  });

  it("does not infer provenance from a restored execution count", () => {
    const restored = {
      document: { cells: [{ id: "restored", source: "@identity", executionCount: 31 }] },
    };
    expect(navigation.resolveSourceFrame(restored, kernel, frame())).toBeNull();
  });

  it("guards session destruction and generation changes before navigation", async () => {
    const link = navigation.resolveSourceFrame(editor, kernel, frame());
    kernel.destroyed = true;
    spyOn(lumine.notifications, "addWarning");
    await link.open();
    expect(editor.revealCellById).not.toHaveBeenCalled();
    capture();
    kernel.generation++;
    expect(navigation.resolveSourceFrame(editor, kernel, frame())).toBeNull();
  });

  it("checks generation again while the notebook cell is being revealed", async () => {
    const link = navigation.resolveSourceFrame(editor, kernel, frame());
    await link.open();
    const guard = editor.revealCellById.calls.mostRecent().args[2];
    kernel.generation++;
    expect(guard()).toBe(false);
  });

  it("declines an expired origin at lookup and during a deferred cell reveal", async () => {
    let originCurrent = false;
    let finishReveal;
    const focused = jasmine.createSpy("focus deferred cell");
    const query = { ...frame(), isCurrent: () => originCurrent };
    expect(navigation.resolveSourceFrame(editor, kernel, query)).toBeNull();
    originCurrent = true;
    editor.revealCellById.and.callFake(
      (_cellId, _range, guard) =>
        new Promise((resolve) => {
          finishReveal = () => {
            if (guard()) focused();
            resolve();
          };
        }),
    );
    const pending = navigation.resolveSourceFrame(editor, kernel, query).open();
    originCurrent = false;
    finishReveal();
    await pending;
    expect(focused).not.toHaveBeenCalled();
  });

  it("invalidates restart provenance without needing a new execution count", () => {
    for (const state of ["restarting", "autorestarting"]) {
      capture();
      expect(navigation.resolveSourceFrame(editor, kernel, frame())).toBeTruthy();
      events.emit("state", state);
      events.emit("state", "idle");
      expect(navigation.resolveSourceFrame(editor, kernel, frame())).toBeNull();
    }
  });

  it("releases its generation observer when its document closes", () => {
    expect(events.handlersByEventName.state.length).toBe(1);
    documentEvents.emit("destroy");
    expect(events.handlersByEventName.state).toBeUndefined();
    expect(navigation.resolveSourceFrame(editor, kernel, frame())).toBeNull();
  });
});
