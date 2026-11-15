const { Emitter } = require("lumine");

describe("notebook navigation adapter", () => {
  let editor, events, frames, subscription, callback, adapter;

  beforeEach(() => {
    const JupyterNotebookEditor = require("../lib/jupyter-notebook-editor");
    adapter = require("../lib/main").provideNavigationAdapter();
    events = new Emitter();
    frames = new Map();
    editor = Object.create(JupyterNotebookEditor.prototype);
    editor.emitter = new Emitter();
    editor.activeCellIndex = 4;
    editor.document = {
      cells: [
        { id: "preamble", type: "markdown", source: "Introduction without a heading." },
        { id: "code", type: "code", source: "print('Introduction')" },
        { id: "first", type: "markdown", source: "# First section" },
        { id: "body", type: "markdown", source: "Section body." },
        { id: "last", type: "markdown", source: "# Last section" },
        { id: "tail", type: "code", source: "print('End')" },
      ],
    };
    const bounds = [0, 900, 1000, 1100, 1800, 1900, 3000];
    editor.view = {
      cellsContainer: {
        scrollTop: 0,
        getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
      },
      cellViews: new Map(
        editor.document.cells.map((cell, index) => [
          cell.id,
          {
            element: {
              getBoundingClientRect: () => ({
                top: bounds[index] - editor.view.cellsContainer.scrollTop,
                bottom: bounds[index + 1] - editor.view.cellsContainer.scrollTop,
              }),
            },
          },
        ]),
      ),
      onDidScroll: (listener) => events.on("scroll", listener),
    };
    let frameId = 0;
    spyOn(editor, "requestFrame").and.callFake((listener) => {
      frames.set(++frameId, listener);
      return frameId;
    });
    spyOn(editor, "cancelFrame").and.callFake((frame) => frames.delete(frame));
    callback = jasmine.createSpy("navigation headers");
    expect(adapter.handlesItem(editor)).toBe(true);
    subscription = adapter.observeHeaders(editor, callback);
  });

  afterEach(() => {
    subscription.dispose();
    events.dispose();
    editor.emitter.dispose();
  });

  function flush() {
    const pending = [...frames.values()];
    frames.clear();
    for (const listener of pending) listener();
  }

  function scrollTo(top) {
    editor.view.cellsContainer.scrollTop = top;
    events.emit("scroll");
    flush();
  }

  it("reports the preamble from real cell positions despite a later active heading", () => {
    flush();
    const [headers, options] = callback.calls.mostRecent().args;
    expect(headers[0].startPoint.row).toBe(0);
    expect(headers[0].cellIndex).toBe(2);
    expect(headers[1].currentCount).toBe(1);
    expect(headers.every((header) => header.visibility === 0)).toBe(true);
    expect(options).toEqual({ instant: true, scrollBoundary: "start" });
  });

  it("repeats the start boundary for source scrolling with unchanged outline state", () => {
    flush();
    const headers = callback.calls.mostRecent().args[0];
    scrollTo(20);
    scrollTo(40);
    expect(callback.calls.count()).toBe(3);
    expect(callback.calls.mostRecent().args).toEqual([
      headers,
      { instant: false, scrollBoundary: "start" },
    ]);
  });

  it("clears the boundary when the first heading appears and keeps later gaps unbounded", () => {
    flush();
    scrollTo(1050);
    expect(callback.calls.mostRecent().args[1].scrollBoundary).toBeNull();
    expect(callback.calls.mostRecent().args[0][0].visibility).toBe(1);
    scrollTo(1200);
    expect(callback.calls.mostRecent().args[1].scrollBoundary).toBeNull();
    expect(callback.calls.mostRecent().args[0].every((header) => header.visibility === 0)).toBe(
      true,
    );
    scrollTo(2200);
    expect(callback.calls.mostRecent().args[1].scrollBoundary).toBeNull();
    callback.calls.reset();
    scrollTo(2220);
    expect(callback).not.toHaveBeenCalled();
  });

  it("coalesces source scrolling with an instant navigation update and tears it down", () => {
    events.emit("scroll");
    editor.emitter.emit("did-change-navigation");
    expect(frames.size).toBe(1);
    flush();
    expect(callback.calls.count()).toBe(1);
    expect(callback.calls.mostRecent().args[1]).toEqual({
      instant: true,
      scrollBoundary: "start",
    });
    events.emit("scroll");
    subscription.dispose();
    expect(frames.size).toBe(0);
    events.emit("scroll");
    editor.emitter.emit("did-change-navigation");
    flush();
    expect(callback.calls.count()).toBe(1);
  });

  it("does not infer a boundary without headings or a visible notebook viewport", () => {
    editor.document.cells[2].source = "First section without a heading.";
    editor.document.cells[4].source = "Last section without a heading.";
    flush();
    expect(callback.calls.mostRecent().args).toEqual([[], { instant: true, scrollBoundary: null }]);
    editor.document.cells[2].source = "# First section";
    editor.view.cellsContainer = null;
    editor.emitter.emit("did-change-navigation");
    flush();
    expect(callback.calls.mostRecent().args[1].scrollBoundary).toBeNull();
  });
});
