const CellModel = require("../lib/cell-model");
const NotebookDocument = require("../lib/notebook-document");
const JupyterNotebookEditor = require("../lib/jupyter-notebook-editor");

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

describe("source editor benchmark", () => {
  it("measures the 1000-cell / 50 MB interactive path", async () => {
    const document = new NotebookDocument(null);
    await document.initialize();
    const megabyte = "x".repeat(1024 * 1024);
    const largeOutputs = Array.from({ length: 50 }, () => ({
      output_type: "display_data",
      data: { "image/png": megabyte },
    }));
    document.cells = Array.from(
      { length: 1000 },
      (_, index) =>
        new CellModel({
          id: `cell-${index}`,
          type: "code",
          source: "x".repeat(1024),
          outputs: index === 0 ? largeOutputs : [],
          executionCount: null,
          metadata: {},
        }),
    );
    document._resubscribeCells();

    const editor = new JupyterNotebookEditor(document);
    await editor._sourceEditorSetupPromise;
    const withOutputs = [];
    const withoutOutputs = [];
    let revision = 0;
    const measure = (_index, outputs, target) => {
      document.getCell(0).outputs = outputs;
      const started = performance.now();
      document.updateCellSource(500, `${"x".repeat(1023)}${revision++ % 10}`, editor);
      editor.sourceController.commitSnapshot("benchmark", editor);
      target.push(performance.now() - started);
    };
    for (let index = 0; index < 5; index++) {
      measure(index, largeOutputs, []);
      measure(index + 1, [], []);
    }
    for (let index = 0; index < 30; index++) {
      if (index % 2 === 0) {
        measure(index + 10, largeOutputs, withOutputs);
        measure(index + 11, [], withoutOutputs);
      } else {
        measure(index + 10, [], withoutOutputs);
        measure(index + 11, largeOutputs, withOutputs);
      }
    }

    let runtimeSnapshots = 0;
    const originalCommit = editor.sourceController.commitSnapshot.bind(editor.sourceController);
    editor.sourceController.commitSnapshot = (...args) => {
      runtimeSnapshots++;
      return originalCommit(...args);
    };
    for (let index = 0; index < 100; index++) {
      document.getCell(0).addOutput({
        output_type: "stream",
        name: "stdout",
        text: String(index),
      });
    }
    editor.sourceController.flushPendingChanges(editor);

    const withOutputsP95 = percentile(withOutputs, 0.95);
    const withoutOutputsP95 = percentile(withoutOutputs, 0.95);
    const result = {
      cells: 1000,
      logicalOutputMegabytes: 50,
      medianMs: Number(percentile(withOutputs, 0.5).toFixed(2)),
      p95Ms: Number(withOutputsP95.toFixed(2)),
      zeroOutputP95Ms: Number(withoutOutputsP95.toFixed(2)),
      outputDeltaMs: Number((withOutputsP95 - withoutOutputsP95).toFixed(2)),
      runtimeSourceSnapshots: runtimeSnapshots,
    };
    console.log("[jupyter-view benchmark]", JSON.stringify(result));
    expect(runtimeSnapshots).toBe(0);
    editor.destroy();
  });
});
