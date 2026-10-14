const { CompositeDisposable } = require("lumine");

// One bridge per open document, replayed for the notebooks already open when
// the ide service arrives.
class LspBridgeManager {
  constructor(ide, host) {
    this.ide = ide;
    this.host = host;
    this.bridges = new Map();
    this.subscriptions = new CompositeDisposable(
      this.host.getDocumentRegistry().observeDocuments((document) => this.attach(document)),
    );
  }

  attach(document) {
    if (this.bridges.has(document)) return;
    const { NotebookLspBridge } = require("./notebook-lsp-bridge");
    const bridge = new NotebookLspBridge(this.ide, this.host, document, () =>
      this.bridges.delete(document),
    );
    this.bridges.set(document, bridge);
  }

  // Called by trackNotebookEditor: a notebook editor that just appeared — a
  // split view, a restored pane — carries its own cell editors.
  editorTracked(editor) {
    const bridge = editor?.document && this.bridges.get(editor.document);
    if (bridge) bridge.editorJoined(editor);
  }

  dispose() {
    for (const bridge of [...this.bridges.values()]) bridge.dispose();
    this.bridges.clear();
    this.subscriptions.dispose();
  }
}

module.exports = {
  LspBridgeManager,
  get NotebookLspBridge() {
    return require("./notebook-lsp-bridge").NotebookLspBridge;
  },
};
