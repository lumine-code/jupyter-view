const { Range } = require("lumine");
const NotebookView = require("../lib/notebook-view");

describe("notebook editor scrolling", () => {
  let view, editor, container;

  beforeEach(() => {
    container = {
      clientHeight: 200,
      scrollTop: 100,
      getBoundingClientRect: () => ({ top: 0, bottom: 200 }),
      scrollTo: jasmine.createSpy("scroll notebook"),
    };
    editor = { getLineHeightInPixels: () => 20, verticalScrollMargin: 0 };
    const editorElement = {
      getBoundingClientRect: () => ({ top: 0 }),
      pixelPositionForScreenPosition: (point) => ({ top: point.row * 20 }),
    };
    view = Object.create(NotebookView.prototype);
    view.props = { cells: [{ id: "cell" }] };
    view.refs = { "cell-cell": { editorElement }, cellsContainer: container };
  });

  const reveal = (row, mode, endRow = row, reversed = true) =>
    view.scrollToEditorRange(0, editor, {
      screenRange: new Range([row, 0], [endRow, 0]),
      options: { mode, reversed },
    });

  it("keeps nearest requests still while the target is visible", () => {
    reveal(8, [0, 100]);
    expect(container.scrollTo).not.toHaveBeenCalled();
  });

  it("lands a downward navigation at the configured lower bound", () => {
    reveal(8, [0, 50]);
    expect(container.scrollTo).toHaveBeenCalledOnceWith({ top: 170, behavior: "instant" });
  });

  it("keeps a target already inside the navigation zone still", () => {
    reveal(3, [0, 50]);
    expect(container.scrollTo).not.toHaveBeenCalled();
  });

  it("uses the opposite landing edge for an inverted zone", () => {
    reveal(8, [50, 0]);
    expect(container.scrollTo).toHaveBeenCalledOnceWith({ top: 260, behavior: "instant" });
  });

  it("uses the requested active end for ranges taller than the viewport", () => {
    reveal(1, [0, 100], 20, false);
    expect(container.scrollTo).toHaveBeenCalledOnceWith({ top: 320, behavior: "instant" });
  });

  it("includes the editor's scroll margin when landing at the top", () => {
    editor.verticalScrollMargin = 1;
    reveal(0, [0, 100]);
    expect(container.scrollTo).toHaveBeenCalledOnceWith({ top: 80, behavior: "instant" });
  });
});
