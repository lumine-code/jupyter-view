const { CompositeDisposable, Disposable } = require("lumine");

const noop = new Disposable(() => {});

function nextFrame(callback) {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(callback, 0);
}

// Feeds the open notebooks to the language servers through ide-client's
// notebook bridge (`openNotebookDocument`). Nothing here speaks LSP: the hub
// owns the protocol, this package owns the notebook, and this file translates
// between their vocabularies. One NotebookLspBridge per document; the manager
// follows the registry. Content sync is not this file's job — the hub follows
// each cell's buffer on its own; what flows through here is structure.
class NotebookLspBridge {
  constructor(client, host, document, onDispose) {
    this.client = client;
    // The main module: getNotebookEditors(document) and the tracked editors.
    this.host = host;
    this.document = document;
    this.onDispose = onDispose;
    this.bridge = null;
    this.disposed = false;
    this.updateScheduled = null;
    this.lintScheduled = null;
    this.subscribedEditors = new WeakSet();
    this.subscribedCellEditors = new WeakSet();
    this.subscriptions = new CompositeDisposable(
      // affectsSource covers cell edits, type flips and metadata; the hub
      // diffs, so over-reporting costs one cheap reconciliation.
      this.document.onDidChange?.((event) => {
        if (event?.affectsSource) this.scheduleUpdate();
      }) ?? noop,
      // A restored document registers before its content loads, so the bridge
      // can open against an empty cell list; the load completion is the only
      // signal that the real cells arrived.
      this.document.onDidLoad?.(() => this.scheduleUpdate()) ?? noop,
      this.document.onDidReload?.(() => this.scheduleUpdate()) ?? noop,
      this.document.onDidSave?.(() => this.bridge?.didSave()) ?? noop,
      // Cell URIs embed the notebook's path, so a rename is a close and a
      // fresh open — which is also how servers expect it.
      this.document.onDidChangePath?.(() => this.reopen()) ?? noop,
      this.document.onDidDestroy?.(() => this.dispose()) ?? noop,
    );
    this.open();
  }

  open() {
    if (this.disposed || this.bridge) return;
    // An untitled notebook has no URI to give a server; onDidChangePath
    // reopens once the first save names it.
    if (!this.document.filePath) return;
    this.bridge = this.client.openNotebookDocument({
      filePath: this.document.filePath,
      notebookType: "jupyter-notebook",
      cells: this.buildCells(),
      show: ({ cellId, range }) => this.revealCell(cellId, range),
    });
    this.requestLint();
    this.watchAttach(this.bridge?.attached);
  }

  // Adapter attach settles asynchronously — after sessions spawn, initialize
  // and accept the notebook — and the CLI linters' stand-down answer flips
  // exactly then, not at open. The nudge waits for each update's attach and
  // fires only when the serving-adapter set actually changed, so the CLI
  // route re-asks at the right moment and typing does not re-lint anything.
  watchAttach(attached) {
    if (!attached?.then) return;
    attached.then(() => {
      if (this.disposed || !this.document.filePath) return;
      const adapters = (this.client.adaptersForNotebook?.(this.document.filePath) || [])
        .map((adapter) => adapter.id)
        .sort()
        .join(",");
      if (adapters === this.lastAdapters) return;
      this.lastAdapters = adapters;
      this.requestLint();
    });
  }

  reopen() {
    this.bridge?.dispose();
    this.bridge = null;
    this.open();
  }

  // The full ordered cell list, with every split view's live editor per code
  // cell. A cell whose editor etch has not built yet ships its model text; the
  // editor arrives through a later update via onDidChangeCellEditors.
  buildCells() {
    const editors = this.host.getNotebookEditors(this.document);
    for (const editor of editors) this.subscribeEditor(editor);
    let notebookScope = null;
    const cells = (this.document.cells || []).map((cell) => {
      const kind = cell.type === "code" ? "code" : "markup";
      const cellEditors =
        kind === "code"
          ? editors.map((editor) => editor.getCellEditorById?.(cell.id)).filter(Boolean)
          : [];
      for (const cellEditor of cellEditors) this.subscribeCellEditor(cellEditor);
      const scopeName = cellEditors[0]?.getGrammar?.()?.scopeName;
      if (scopeName && !notebookScope) notebookScope = scopeName;
      return { id: cell.id, kind, editors: cellEditors, scopeName, text: cell.source };
    });
    // Sibling cells share the notebook's language, so an editor-less cell
    // borrows a sibling's scope rather than opening as plain text.
    for (const cell of cells) {
      if (cell.kind === "code" && !cell.scopeName) cell.scopeName = notebookScope;
    }
    return cells;
  }

  subscribeEditor(editor) {
    if (!editor || this.subscribedEditors.has(editor)) return;
    this.subscribedEditors.add(editor);
    const subscription = editor.onDidChangeCellEditors?.(() => this.scheduleUpdate());
    if (subscription) this.subscriptions.add(subscription);
  }

  // A cell editor's grammar arrives asynchronously — text.plain until the
  // language package loads — and adapter matching reads the grammar, so the
  // resolution has to re-send the cells or the servers never attach.
  subscribeCellEditor(cellEditor) {
    if (!cellEditor || this.subscribedCellEditors.has(cellEditor)) return;
    this.subscribedCellEditors.add(cellEditor);
    const subscription = cellEditor.onDidChangeGrammar?.(() => this.scheduleUpdate());
    if (subscription) this.subscriptions.add(subscription);
  }

  // A split view opened after the bridge did brings its own cell editors.
  editorJoined(editor) {
    this.subscribeEditor(editor);
    this.scheduleUpdate();
  }

  scheduleUpdate() {
    if (this.disposed || this.updateScheduled) return;
    const token = {};
    this.updateScheduled = token;
    nextFrame(() => {
      if (this.updateScheduled !== token || this.disposed) return;
      this.updateScheduled = null;
      this.watchAttach(this.bridge?.updateCells(this.buildCells()));
    });
  }

  revealCell(cellId, range) {
    const editor = this.host.getNotebookEditors(this.document)[0];
    const index = (this.document.cells || []).findIndex((cell) => cell.id === cellId);
    if (!editor || index < 0) return;
    const position = range?.[0] ? { row: range[0][0], column: range[0][1] } : undefined;
    editor.revealCell?.(index, position);
  }

  // A pass over the CLI linters after coverage changes, so linter-ruff's
  // stand-down and the first server diagnostics never leave a stale duplicate
  // set on screen — the same nudge linter-ruff gives itself on adapter changes.
  requestLint() {
    if (this.lintScheduled) return;
    const token = {};
    this.lintScheduled = token;
    nextFrame(() => {
      if (this.lintScheduled !== token) return;
      this.lintScheduled = null;
      const workspaceElement = lumine.views.getView(lumine.workspace);
      if (workspaceElement) lumine.commands.dispatch(workspaceElement, "linter:lint");
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.bridge?.dispose();
    this.bridge = null;
    this.subscriptions.dispose();
    this.requestLint();
    this.onDispose?.();
  }
}

// One bridge per open document, replayed for the notebooks already open when
// the ide-client service arrives.
class LspBridgeManager {
  constructor(client, host) {
    this.client = client;
    this.host = host;
    this.bridges = new Map();
    this.subscriptions = new CompositeDisposable(
      this.host.getDocumentRegistry().observeDocuments((document) => this.attach(document)),
    );
  }

  attach(document) {
    if (this.bridges.has(document)) return;
    const bridge = new NotebookLspBridge(this.client, this.host, document, () =>
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

module.exports = { LspBridgeManager, NotebookLspBridge };
