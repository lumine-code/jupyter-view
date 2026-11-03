const etch = require("@lumine-code/etch");

describe("notebook action icons", () => {
  let view;
  let host;

  beforeEach(async () => {
    await lumine.packages.activatePackage("jupyter-view");
    const NotebookView = require("../lib/notebook-view");
    view = new NotebookView({
      cells: [{ id: "code", type: "code", source: "", outputs: [] }],
      activeCellIndex: 0,
      editor: null,
    });
    etch.updateSync(view);
    host = document.createElement("div");
    host.className = "jupyter-view";
    host.appendChild(view.element);
    jasmine.attachToDOM(host);
    host.querySelector(".cell-actions").style.display = "flex";
  });

  afterEach(() => {
    view.destroy();
    host.remove();
  });

  it("centers toolbar and cell actions independently of the surrounding font metrics", () => {
    const buttons = [...host.querySelectorAll("button.jupyter-action-button")];
    expect(buttons.length).toBe(16);
    for (const font of ["10px/18px system-ui", "18px/32px monospace"]) {
      for (const button of buttons) {
        button.style.font = font;
        const icon = button.querySelector("svg");
        const rect = button.getBoundingClientRect();
        const ink = icon.querySelector("path").getBBox();
        const carrier = icon.getBoundingClientRect();
        expect(Math.abs(carrier.x + carrier.width / 2 - rect.x - rect.width / 2))
          .withContext(button.getAttribute("aria-label"))
          .toBeLessThan(0.05);
        expect(Math.abs(carrier.y + carrier.height / 2 - rect.y - rect.height / 2))
          .withContext(button.getAttribute("aria-label"))
          .toBeLessThan(0.05);
        expect(ink.width).toBeGreaterThan(0);
        expect(ink.height).toBeGreaterThan(0);
        expect(ink.x).toBeGreaterThanOrEqual(1);
        expect(ink.y).toBeGreaterThanOrEqual(1);
        expect(ink.x + ink.width).toBeLessThanOrEqual(15);
        expect(ink.y + ink.height).toBeLessThanOrEqual(15);
      }

      // This was the most visibly raised glyph. Check the drawn square,
      // rather than just its carrier, against the actual button center.
      const button = view.refs["editor-clearAllOutputs"];
      const path = button.querySelector("path");
      const box = path.getBBox();
      const center = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(
        path.getScreenCTM(),
      );
      const rect = button.getBoundingClientRect();
      expect(center.x).toBeCloseTo(rect.x + rect.width / 2, 1);
      expect(center.y).toBeCloseTo(rect.y + rect.height / 2, 1);
    }
  });

  it("keeps accessible labels and dispatches clicks from the SVG exactly once", () => {
    const dispatch = spyOn(lumine.commands, "dispatch");
    for (const entry of view.commandButtons().filter(Boolean)) {
      const button = view.refs[`command-${entry[0]}`];
      expect(button.getAttribute("aria-label")).toBe(entry[2]);
      expect(button.querySelector("svg").getAttribute("aria-hidden")).toBe("true");
      dispatch.calls.reset();
      button.querySelector("path").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(dispatch).toHaveBeenCalledOnceWith(view.element, entry[0]);
    }
    const editor = { clearAllOutputs: jasmine.createSpy("clearAllOutputs") };
    view.update({ editor });
    etch.updateSync(view);
    view.refs["editor-clearAllOutputs"]
      .querySelector("path")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(editor.clearAllOutputs).toHaveBeenCalledTimes(1);
  });
});
