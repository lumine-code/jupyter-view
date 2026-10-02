const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function notebook(cycle) {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } },
    cells: [
      {
        id: "markdown",
        cell_type: "markdown",
        source: ["Saved attachment"],
        metadata: {},
        attachments: { "image.png": { "image/png": "aW1hZ2U=" } },
      },
      {
        id: "code",
        cell_type: "code",
        source: [`value = ${cycle}`],
        metadata: {},
        outputs: [],
        execution_count: null,
      },
    ],
  };
}

describe("notebook lifecycle under repeated use", () => {
  it("releases each cycle's editors, restored documents, render subscriptions and file watches", async () => {
    jasmine.useRealClock();
    for (const name of ["language-json", "language-python", "language-gfm", "language-text"]) {
      const pack = await lumine.packages.activatePackage(name);
      await pack.resourceLoadPromise;
    }
    // Earlier suites may unload the package. Resolve this generation after
    // resources are ready rather than keeping constructors from spec loading.
    const Registry = require("../lib/notebook-document-registry");
    const NotebookEditor = require("../lib/jupyter-notebook-editor");
    const NotebookView = require("../lib/notebook-view");
    const AdapterService = require("../lib/jupyter-adapter");
    const { LinterEditors } = require("../lib/linter-editors");
    const outputRenderer = require("../lib/output-renderer");
    const directory = await fs.promises.realpath(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), "notebook-lifecycle-soak-")),
    );
    const registries = new Set();
    const editors = new Set();
    const outputSubscriptions = new Set();
    const linterBaselines = new Map();
    const originalAdd = LinterEditors.prototype.add;
    const originalSubscribe = outputRenderer.onDidChange;
    // Transparent ownership ledgers avoid spy histories retaining callbacks
    // from the closed views whose lifecycle this test exercises.
    LinterEditors.prototype.add = function (...args) {
      if (!linterBaselines.has(this)) linterBaselines.set(this, this.editors.size);
      return originalAdd.apply(this, args);
    };
    outputRenderer.onDidChange = (callback) => {
      const subscription = originalSubscribe(callback);
      const owned = {
        dispose() {
          outputSubscriptions.delete(owned);
          subscription.dispose();
        },
      };
      outputSubscriptions.add(owned);
      return owned;
    };
    // useRealClock calls through the runner's timer spies. Remove their
    // tracking while this repeated-use test runs, then restore the spies.
    const timerSpies = [];
    for (const name of ["setTimeout", "clearTimeout", "setInterval", "clearInterval"]) {
      const spy = window[name];
      if (jasmine.isSpy(spy)) {
        timerSpies.push([name, spy]);
        window[name] = spy.and.originalFn;
        spy.calls.reset();
      }
    }
    const newRegistry = (state) => {
      const registry = new Registry(state);
      registries.add(registry);
      return registry;
    };
    const trackEditor = (editor) => {
      editors.add(editor);
      return editor;
    };
    const closeEditor = (editor) => {
      editor.destroy();
      editors.delete(editor);
    };
    const closeRegistry = (registry) => {
      expect(registry.documents.size).toBe(0);
      expect(registry.documentsById.size).toBe(0);
      expect(registry._loadingPromises.size).toBe(0);
      expect(registry._loadingPromisesById.size).toBe(0);
      expect(registry._pendingViews.size).toBe(0);
      registry.destroy();
      registries.delete(registry);
    };
    try {
      await frame();
      await lumine.fileWatchClient.settlePendingTeardown();
      const baselineEditors = lumine.textEditors.getEditors().length;
      const baselineDocuments = lumine.workspace.fileDocuments.documents.size;
      const baselineWatches = lumine.fileWatchClient.handles.size;
      const adapters = new AdapterService();
      const printed = "soak line\n".repeat(2048) + "123def";
      for (let cycle = 0; cycle < 24; cycle++) {
        const filePath = path.join(directory, `notebook-${cycle}.ipynb`);
        const savedPath = path.join(directory, `saved-${cycle}.ipynb`);
        await fs.promises.writeFile(filePath, JSON.stringify(notebook(cycle)));
        const registry = newRegistry();
        const [document, sameDocument] = await Promise.all([
          registry.getOrCreateDocument(filePath),
          registry.getOrCreateDocument(filePath),
        ]);
        expect(sameDocument).toBe(document);
        const first = trackEditor(new NotebookEditor(document));
        const split = trackEditor(first.copy());
        await Promise.all([first._sourceEditorSetupPromise, split._sourceEditorSetupPromise]);
        expect(first.getSourceEditor()).toBe(split.getSourceEditor());
        expect(document.refCount).toBe(2);
        document.updateCellSource(1, `changed = ${cycle}`, first);
        first.sourceController.commitSnapshot("soak-edit", first);
        split.undoCellOperation();
        expect(document.getCell(1).source).toBe(`value = ${cycle}`);
        split.redoCellOperation();
        expect(document.getCell(1).source).toBe(`changed = ${cycle}`);
        const adapter = adapters.getAdapterForItem(first);
        const target = adapter.getRunTarget("code");
        adapter.clearTargetOutputs(target);
        adapter.beginTargetExecution(target);
        for (let chunk = 0; chunk < 2048; chunk++) {
          adapter.appendTargetOutput(target, {
            output_type: "stream",
            name: "stdout",
            text: "soak line\n",
          });
        }
        for (const text of ["abcdef\r", "12", "3"]) {
          adapter.appendTargetOutput(target, { output_type: "stream", name: "stdout", text });
        }
        adapter.setTargetExecutionCount(target, cycle + 1);
        adapter.finishTargetExecution(target);
        expect(document.getCell(1).outputs[0].text).toBe(printed);
        const firstSave = first.save();
        document.updateCellSource(1, `latest = ${cycle}`, split);
        const secondSave = split.save();
        expect(await firstSave).toBe(true);
        expect(await secondSave).toBe(true);
        expect(await first.saveAs(savedPath)).toBe(true);
        expect(split.getPath()).toBe(savedPath);
        const saved = JSON.parse(await fs.promises.readFile(savedPath, "utf8"));
        expect(saved.cells[0].attachments).toEqual(notebook(cycle).cells[0].attachments);
        expect(saved.cells[1].source).toEqual([`latest = ${cycle}`]);
        expect(saved.cells[1].outputs[0].text).toBe(printed);
        expect(saved.cells[1].execution_count).toBe(cycle + 1);
        document.updateCellSource(1, `restored = ${cycle}`, first);
        first.sourceController.commitSnapshot("soak-restore", first);
        const state = registry.serialize();
        const documentId = document.id;
        closeEditor(first);
        closeEditor(split);
        closeRegistry(registry);

        // Closing before the real disk reconciliation completes must leave
        // no cached document, but a concurrent surviving split must still load.
        const cancelledRegistry = newRegistry(state);
        const cancelled = trackEditor(
          NotebookEditor.deserialize({ documentId }, { documentRegistry: cancelledRegistry }),
        );
        const cancelledLoad = cancelled._loadingPromise;
        closeEditor(cancelled);
        await cancelledLoad;
        expect(cancelled.document).toBeNull();
        closeRegistry(cancelledRegistry);
        const restoredRegistry = newRegistry(state);
        const closedSplit = trackEditor(
          NotebookEditor.deserialize({ documentId }, { documentRegistry: restoredRegistry }),
        );
        const survivingSplit = trackEditor(
          NotebookEditor.deserialize({ documentId }, { documentRegistry: restoredRegistry }),
        );
        const loading = Promise.all([closedSplit._loadingPromise, survivingSplit._loadingPromise]);
        closeEditor(closedSplit);
        await loading;
        expect(survivingSplit.document.refCount).toBe(1);
        expect(survivingSplit.document.getCell(1).source).toBe(`restored = ${cycle}`);
        expect(survivingSplit.document.getCell(1).outputs[0].text).toBe(printed);
        expect(survivingSplit.document.getCell(0).attachments).toEqual(saved.cells[0].attachments);
        closeEditor(survivingSplit);
        closeRegistry(restoredRegistry);

        // A queued child render must not recreate an OutputView after its
        // parent synchronously closes, even when this repeats many times.
        const cell = { id: "queued", type: "code", source: "1", outputs: [], metadata: {} };
        const view = new NotebookView({ cells: [cell], activeCellIndex: 0, editor: null });
        const cellView = view.cellViews.get("queued");
        cell.outputs = [{ output_type: "stream", name: "stdout", text: "queued output" }];
        const pendingRender = cellView.update({ ...cellView.props, cell });
        view.destroy();
        await pendingRender;
        await frame();
        await lumine.fileWatchClient.settlePendingTeardown();
        expect(outputSubscriptions.size).withContext(`cycle ${cycle}`).toBe(0);
        for (const [linter, baseline] of linterBaselines) {
          expect(linter.editors.size).withContext(`cycle ${cycle}`).toBe(baseline);
        }
        expect(lumine.textEditors.getEditors().length)
          .withContext(`cycle ${cycle}`)
          .toBe(baselineEditors);
        expect(lumine.workspace.fileDocuments.documents.size)
          .withContext(`cycle ${cycle}`)
          .toBe(baselineDocuments);
        expect(lumine.fileWatchClient.handles.size)
          .withContext(`cycle ${cycle}`)
          .toBe(baselineWatches);
      }
    } finally {
      for (const editor of editors) editor.destroy();
      for (const registry of registries) registry.destroy();
      await frame();
      await lumine.fileWatchClient.settlePendingTeardown();
      for (const subscription of [...outputSubscriptions]) subscription.dispose();
      outputRenderer.onDidChange = originalSubscribe;
      LinterEditors.prototype.add = originalAdd;
      for (const [name, spy] of timerSpies) window[name] = spy;
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }, 20000);
});
