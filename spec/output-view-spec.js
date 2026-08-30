const etch = require("@lumine-code/etch");
const OutputView = require("../lib/output-view");
const outputRenderer = require("../lib/output-renderer");

// Rendering lives in jupyter-repl now, behind the `jupyter.output` service:
// one implementation for the whole family, exercised by that package's own
// specs. What this file pins is the seam — outputs go through the service
// when it is there, the built-in fallback keeps a notebook readable when it
// is not, and a mounted view crosses between the two without being rebuilt.

const flush = (view) => etch.updateSync(view);

function mount(outputs, maxHeight = 0) {
  const view = new OutputView({ outputs, maxHeight });
  flush(view);
  return view;
}

// The stand-in offers exactly what the view touches: normalizeOutput and
// renderDisplay. Rendering a marker element per call keeps the assertions
// about routing, not about jupyter-repl's markup.
function fakeService() {
  return {
    calls: [],
    normalizeOutput(output) {
      return { ...output, _normalized: true };
    },
    renderDisplay(output) {
      this.calls.push(output);
      return etch.dom("div", { className: "service-rendered" }, output.output_type);
    },
  };
}

describe("output view", () => {
  let view;

  afterEach(() => {
    view?.destroy();
    view = null;
    outputRenderer.set(null);
  });

  describe("without the jupyter.output service", () => {
    beforeEach(() => outputRenderer.set(null));

    it("renders a stream as plain text", () => {
      view = mount([{ output_type: "stream", name: "stdout", text: "hello" }]);

      expect(view.element.querySelector(".output-stream.output-stdout")).toBeTruthy();
      expect(view.element.textContent).toContain("hello");
    });

    it("renders an error as its traceback text", () => {
      view = mount([
        { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["Trace", "bad"] },
      ]);

      expect(view.element.querySelector(".output-error").textContent).toContain("Trace");
    });

    it("falls back to name and value when an error has no traceback", () => {
      view = mount([{ output_type: "error", ename: "ValueError", evalue: "bad", traceback: [] }]);

      expect(view.element.querySelector(".output-error").textContent).toContain("ValueError: bad");
    });

    it("renders an image from its base64 data", () => {
      view = mount([{ output_type: "display_data", data: { "image/png": "AAAA" } }]);

      const img = view.element.querySelector("img.output-image");
      expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA");
      expect(img.draggable).toBe(false);
    });

    it("shows the plain text of a bundle it cannot render richly", () => {
      view = mount([
        {
          output_type: "execute_result",
          data: { "text/html": "<b>rich</b>", "text/plain": "42" },
        },
      ]);

      expect(view.element.querySelector(".output-text").textContent).toContain("42");
      expect(view.element.querySelector(".output-html")).toBeFalsy();
    });

    it("joins the string arrays Jupyter stores multi-line values as", () => {
      view = mount([{ output_type: "stream", name: "stdout", text: ["one\n", "two"] }]);

      expect(view.element.textContent).toContain("one");
      expect(view.element.textContent).toContain("two");
    });
  });

  describe("with the jupyter.output service", () => {
    let service;

    beforeEach(() => {
      service = fakeService();
      outputRenderer.set(service);
    });

    it("renders every output through the service, normalized first", () => {
      view = mount([
        { output_type: "stream", name: "stdout", text: "hi" },
        { output_type: "display_data", data: { "text/plain": "42" } },
      ]);

      expect(view.element.querySelectorAll(".service-rendered").length).toBe(2);
      // Initialize and the sync flush each render, so per-output call counts
      // double; what matters is that everything went through, normalized.
      expect(service.calls.length).toBeGreaterThan(0);
      expect(service.calls.every((output) => output._normalized)).toBe(true);
    });

    it("upgrades an already-mounted view when the service arrives", () => {
      outputRenderer.set(null);
      view = mount([{ output_type: "stream", name: "stdout", text: "hi" }]);
      expect(view.element.querySelector(".service-rendered")).toBeFalsy();

      outputRenderer.set(service);
      flush(view);

      expect(view.element.querySelector(".service-rendered")).toBeTruthy();
    });

    it("degrades to the fallback when the service goes away", () => {
      view = mount([{ output_type: "stream", name: "stdout", text: "hi" }]);
      expect(view.element.querySelector(".service-rendered")).toBeTruthy();

      outputRenderer.set(null);
      flush(view);

      expect(view.element.querySelector(".service-rendered")).toBeFalsy();
      expect(view.element.querySelector(".output-stream")).toBeTruthy();
    });
  });

  describe("the wrapper this package owns", () => {
    it("keeps one entry per output, indexed for selection", () => {
      view = mount([
        { output_type: "stream", name: "stdout", text: "a" },
        { output_type: "stream", name: "stdout", text: "b" },
      ]);

      const entries = view.element.querySelectorAll(".jupyter-output");
      expect(entries.length).toBe(2);
      expect(entries[1].getAttribute("data-output-index")).toBe("1");
    });

    it("applies the maximum height it is given, and drops it again", () => {
      view = mount([{ output_type: "stream", name: "stdout", text: "a" }], 120);
      const outputs = () => view.element.querySelector(".jupyter-outputs");

      expect(outputs().style.maxHeight).toBe("120px");
      expect(outputs().style.overflowY).toBe("auto");

      view.update({ maxHeight: 0 });
      flush(view);

      expect(outputs().style.maxHeight).toBe("");
    });

    it("replaces its content when the outputs change", () => {
      view = mount([{ output_type: "stream", name: "stdout", text: "first" }]);
      expect(view.element.textContent).toContain("first");

      view.update({ outputs: [{ output_type: "stream", name: "stdout", text: "second" }] });
      flush(view);

      expect(view.element.textContent).toContain("second");
      expect(view.element.textContent).not.toContain("first");
    });
  });
});
