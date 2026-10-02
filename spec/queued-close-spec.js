describe("queued notebook renders after closing", () => {
  it("does not recreate output subscriptions after its parent closes", async () => {
    jasmine.useRealClock();
    const python = await lumine.packages.activatePackage("language-python");
    await python.resourceLoadPromise;
    const NotebookView = require("../lib/notebook-view");
    const outputRenderer = require("../lib/output-renderer");
    const originalSubscribe = outputRenderer.onDidChange;
    const subscriptions = new Set();
    // Keep a transparent ownership ledger; spy call histories would retain
    // the callbacks this lifetime test is checking.
    outputRenderer.onDidChange = (callback) => {
      const subscription = originalSubscribe(callback);
      const owned = {
        dispose() {
          subscriptions.delete(owned);
          subscription.dispose();
        },
      };
      subscriptions.add(owned);
      return owned;
    };
    let view;
    try {
      const cell = { id: "cell", type: "code", source: "1", outputs: [], metadata: {} };
      view = new NotebookView({ cells: [cell], activeCellIndex: 0, editor: null });
      const cellView = view.cellViews.get("cell");
      expect(cellView).toBeDefined();
      cell.outputs = [{ output_type: "stream", name: "stdout", text: "late result" }];
      const pendingRender = cellView.update({ ...cellView.props, cell });
      view.destroy();
      await pendingRender;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(subscriptions.size).toBe(0);
    } finally {
      outputRenderer.onDidChange = originalSubscribe;
      for (const subscription of [...subscriptions]) subscription.dispose();
    }
  });
});
