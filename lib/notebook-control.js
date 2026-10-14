const { CompositeDisposable, Emitter } = require("lumine");
const { randomUUID } = require("node:crypto");

// Event tracking stays synchronous; request validation, snapshots and edits
// are loaded only when a service consumer performs an operation.
function requestRuntime() {
  return require("./notebook-control-requests");
}

function outputSnapshot(...args) {
  return requestRuntime().outputSnapshot(...args);
}

class NotebookControl {
  constructor(host) {
    this.host = host;
    this.registry = host.getDocumentRegistry();
    this.generation = randomUUID();
    this.records = new Map();
    this.operations = new Map();
    this.waits = new Set();
    this.emitter = new Emitter();
    this.disposed = false;
    this.subscriptions = new CompositeDisposable(
      this.registry.observeDocuments((document) => this.track(document)),
      this.registry.onDidRemoveDocument((document) => this.remove(document)),
    );
  }

  track(document) {
    if (this.records.has(document.id)) return;
    const record = {
      document,
      epoch: randomUUID(),
      source: 0,
      change: 0,
      operations: new Map(),
      tail: Promise.resolve(),
      subscriptions: new CompositeDisposable(),
    };
    this.records.set(document.id, record);
    const changed = (kind, source = false, cellIds = []) => {
      if (source) record.source++;
      record.change++;
      this.emitter.emit("did-change-notebook", this.event(record, kind, cellIds));
    };
    record.subscriptions.add(
      document.onDidChange((event) =>
        changed(event.reason || event.category, event.category === "history", event.cellIds),
      ),
      document.onDidLoad(() => changed("loaded", true)),
      document.onDidReload(() => changed("reloaded", true)),
      document.onDidSave(() => changed("saved")),
      document.onDidChangePath(() => changed("path")),
      document.onDidChangeFileState(() => changed("file-state")),
    );
  }

  revision(record) {
    return `${record.epoch}:source:${record.source}`;
  }
  changeRevision(record) {
    return `${record.epoch}:change:${record.change}`;
  }
  event(record, kind, cellIds = []) {
    return {
      notebookId: record.document.id,
      revision: this.revision(record),
      changeRevision: this.changeRevision(record),
      kind,
      cellIds: [...cellIds],
    };
  }

  remove(document) {
    const record = this.records.get(document.id);
    if (!record || record.document !== document) return;
    record.change++;
    this.emitter.emit("did-change-notebook", { ...this.event(record, "closed"), closed: true });
    record.subscriptions.dispose();
    record.operations.clear();
    this.records.delete(document.id);
  }

  record(notebookId) {
    if (this.disposed) throw new Error("The notebook provider was unloaded.");
    if (typeof notebookId !== "string" || !notebookId)
      throw new Error("An explicit notebookId is required.");
    const record = this.records.get(notebookId);
    if (!record || record.document.isDestroyed())
      throw new Error("The notebook is closed or its generation is unknown. List notebooks again.");
    return record;
  }

  getNotebookRevision = (...args) => requestRuntime().getNotebookRevision.apply(this, args);

  flush(...args) {
    return requestRuntime().flush.apply(this, args);
  }

  async ready(...args) {
    return requestRuntime().ready.apply(this, args);
  }

  summary(...args) {
    return requestRuntime().summary.apply(this, args);
  }

  listNotebooks = (...args) => requestRuntime().listNotebooks.apply(this, args);

  cellSnapshot(...args) {
    return requestRuntime().cellSnapshot.apply(this, args);
  }

  getNotebookSnapshot = async (...args) => requestRuntime().getNotebookSnapshot.apply(this, args);

  getCellSnapshot = async (...args) => requestRuntime().getCellSnapshot.apply(this, args);

  getExecutionAdapter = (...args) => requestRuntime().getExecutionAdapter.apply(this, args);

  getExecutionSnapshot = async (...args) => requestRuntime().getExecutionSnapshot.apply(this, args);

  assertRevision(...args) {
    return requestRuntime().assertRevision.apply(this, args);
  }

  operation(...args) {
    return requestRuntime().operation.apply(this, args);
  }

  enqueue(...args) {
    return requestRuntime().enqueue.apply(this, args);
  }

  editCell = (...args) => requestRuntime().editCell.apply(this, args);

  saveNotebook = (...args) => requestRuntime().saveNotebook.apply(this, args);

  validatePath(...args) {
    return requestRuntime().validatePath.apply(this, args);
  }

  openNotebook = (...args) => requestRuntime().openNotebook.apply(this, args);

  createNotebook = (...args) => requestRuntime().createNotebook.apply(this, args);

  onDidChangeNotebook = (callback) => this.emitter.on("did-change-notebook", callback);

  waitForNotebookChange = (...args) => requestRuntime().waitForNotebookChange.apply(this, args);

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const cancel of [...this.waits]) cancel();
    this.subscriptions.dispose();
    for (const record of this.records.values()) record.subscriptions.dispose();
    this.records.clear();
    this.operations.clear();
    this.emitter.dispose();
  }
}

module.exports = { NotebookControl, outputSnapshot };
