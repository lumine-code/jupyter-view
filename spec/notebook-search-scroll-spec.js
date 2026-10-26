const { TextBuffer } = require("lumine");
const NotebookSearchAdapter = require("../lib/notebook-search");

describe("notebook search scrolling", () => {
  let adapter, editor, buffer;

  beforeEach(() => {
    buffer = new TextBuffer("abc");
    editor = {
      getBuffer: () => buffer,
      getCursorBufferPosition: () => ({ row: 0, column: 0 }),
      setSelectedBufferRange: jasmine.createSpy("select result"),
      scrollToCursorPosition: jasmine.createSpy("reveal result"),
    };
    const cellView = { editor, focus() {} };
    adapter = Object.create(NotebookSearchAdapter.prototype);
    adapter.notebookEditor = {
      activeCellIndex: 0,
      setActiveCell() {},
      view: {
        setMode() {},
        scrollToCell() {},
        cellViews: new Map([["cell", cellView]]),
      },
    };
    adapter.matches = [{ cellIndex: 0, start: 1, end: 2 }];
    adapter.emitter = { emit() {} };
    adapter._cells = () => [{ id: "cell" }];
    adapter._clearSearchSelections = () => {};
    adapter._clearHighlights = () => {};
    adapter._highlight = () => {};
  });

  afterEach(() => buffer.destroy());

  for (const method of ["selectNext", "selectPrevious", "selectFirstFromCursor", "selectAll"]) {
    it(`uses the caller's nearest mode for ${method}`, () => {
      adapter[method]({ mode: "nearest" });
      expect(editor.scrollToCursorPosition).toHaveBeenCalledOnceWith({ mode: "nearest" });
      expect(editor.setSelectedBufferRange).toHaveBeenCalledOnceWith(
        [
          [0, 1],
          [0, 2],
        ],
        { flash: true, autoscroll: false },
      );
    });
  }

  it("defaults direct result navigation to the shared zone", () => {
    adapter.selectNext();
    expect(editor.scrollToCursorPosition).toHaveBeenCalledOnceWith({ mode: "zone" });
  });
});
