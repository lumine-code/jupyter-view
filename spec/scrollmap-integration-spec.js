const NotebookScrollmap = require("../lib/scrollmap-integration");

const { normalizeLinterSeverity } = NotebookScrollmap;

// The notebook strip mirrors the linter hub's severity model, so it has to know
// every tier the hub can hand it -- a missing one would silently render as the
// wrong colour instead of failing.
describe("notebook scrollmap linter severities", () => {
  it("passes every severity of the hub model through unchanged", () => {
    expect(normalizeLinterSeverity("error")).toBe("error");
    expect(normalizeLinterSeverity("warning")).toBe("warning");
    expect(normalizeLinterSeverity("info")).toBe("info");
    expect(normalizeLinterSeverity("hint")).toBe("hint");
  });

  it("degrades an unknown severity to the neutral middle, never to error", () => {
    expect(normalizeLinterSeverity("critical")).toBe("info");
    expect(normalizeLinterSeverity(undefined)).toBe("info");
    expect(normalizeLinterSeverity(4)).toBe("info");
  });
});

describe("notebook scrollmap document geometry", () => {
  it("projects wrapped and folded buffer rows through the editor's block geometry", () => {
    const component = {
      pixelPositionAfterBlocksForRow: jasmine
        .createSpy("row pixel")
        .and.callFake((row) => row * 20 + (row >= 3 ? 80 : 0)),
      getLineHeight: () => 20,
    };
    const editor = {
      getElement: () => ({ component }),
      screenPositionForBufferPosition: jasmine
        .createSpy("screen row")
        .and.callFake(([row, column]) => ({ row: row === 4 ? 3 : column === Infinity ? 8 : 6 })),
    };
    expect(NotebookScrollmap.rowPixelRange(editor, 4, 5)).toEqual({ top: 140, bottom: 260 });
    expect(editor.screenPositionForBufferPosition.calls.allArgs()).toEqual([
      [[4, 0]],
      [[5, Infinity]],
    ]);
    expect(NotebookScrollmap.rowPixelRange(null, 0, 0)).toBeNull();
  });

  it("queries each rendered cell once and measures the container once per marker snapshot", () => {
    const container = document.createElement("div");
    container.getBoundingClientRect = jasmine
      .createSpy("container rectangle")
      .and.returnValue({ top: 100 });
    const cell = document.createElement("div");
    cell.innerHTML = '<div class="markdown-rendered"><h1>A</h1><h2>B</h2></div>';
    const headings = cell.querySelectorAll("h1,h2");
    headings[0].getBoundingClientRect = () => ({ top: 120 });
    headings[1].getBoundingClientRect = () => ({ top: 140 });
    const query = spyOn(cell, "querySelectorAll").and.callThrough();
    const map = Object.create(NotebookScrollmap.prototype);
    map.editor = {
      document: { cells: [{ id: "cell" }] },
      view: { cellsContainer: container, cellViews: new Map([["cell", { element: cell }]]) },
    };
    map.headers = [
      { cellIndex: 0, level: 1 },
      { cellIndex: 0, level: 2 },
    ];
    map.headerIndexes = new WeakMap(map.headers.map((header, index) => [header, index]));
    map.linterMessages = [];
    map.Simplemap = class {};
    map.scrollmap = {
      element: document.createElement("div"),
      setItems: jasmine.createSpy("items"),
    };
    map.observedContainer = container;
    spyOn(map, "insertScrollmap").and.returnValue(true);
    spyOn(map, "isEnabled").and.returnValue(true);
    spyOn(map, "getDepth").and.returnValue(0);
    spyOn(map, "getThreshold").and.returnValue(0);
    spyOn(lumine.scrollbars, "getGeometry").and.returnValue({
      scrollHeight: 400,
      viewportHeight: 200,
    });
    map.update();
    expect(query).toHaveBeenCalledTimes(1);
    expect(container.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(map.scrollmap.setItems.calls.mostRecent().args[0].map((item) => item.prc)).toEqual([
      5, 10,
    ]);
  });
});
