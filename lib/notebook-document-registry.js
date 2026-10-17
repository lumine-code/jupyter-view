const { Disposable, Emitter } = require("lumine");

function createDocument(filePath) {
  const NotebookDocument = require("./notebook-document");
  return new NotebookDocument(filePath);
}

function createEditor(document) {
  const JupyterNotebookEditor = require("./jupyter-notebook-editor");
  return new JupyterNotebookEditor(document);
}

/**
 * NotebookDocumentRegistry manages the mapping between file paths and NotebookDocuments.
 * This ensures that multiple editors opening the same file share the same document
 * (like Lumine's TextBuffer registry).
 */
class NotebookDocumentRegistry {
  constructor(serializedDocuments = {}) {
    this.emitter = new Emitter();
    this.documents = new Map(); // filePath -> NotebookDocument (fully loaded)
    this.documentsById = new Map();
    this.serializedDocuments = new Map(Object.entries(serializedDocuments || {}));
    this._loadingPromises = new Map(); // filePath -> Promise<NotebookDocument> (in progress)
    this._loadingPromisesById = new Map();
    this._pendingViews = new Set();
    this._destroyed = false;
    this.untitledCounter = 0;
  }

  restoreSessionState(serializedDocuments = {}) {
    this.serializedDocuments = new Map(Object.entries(serializedDocuments || {}));
  }

  _registerDocument(document) {
    this.documentsById.set(document.id, document);
    if (document.filePath) this.documents.set(document.filePath, document);
    document.onDidDestroy(() => {
      this.documentsById.delete(document.id);
      for (const [filePath, candidate] of this.documents) {
        if (candidate === document) this.documents.delete(filePath);
      }
      this.emitter.emit("did-remove-document", document);
    });
    document.onDidChangePath((newPath) => {
      for (const [filePath, candidate] of this.documents) {
        if (candidate === document && filePath !== newPath) this.documents.delete(filePath);
      }
      if (newPath) this.documents.set(newPath, document);
    });
    // Registration precedes loading, so a subscriber may see a document whose
    // cells and metadata are still empty — treat the document as live and
    // follow its own events (onDidLoad, onDidReload, onDidChange) for content.
    this.emitter.emit("did-add-document", document);
    return document;
  }

  /**
   * Invoke the callback with every open document, now and in the future.
   */
  observeDocuments(callback) {
    for (const document of this.documentsById.values()) callback(document);
    return this.onDidAddDocument(callback);
  }

  onDidAddDocument(callback) {
    return this.emitter.on("did-add-document", callback);
  }

  onDidRemoveDocument(callback) {
    return this.emitter.on("did-remove-document", callback);
  }

  reserveDocumentView({ documentId = null, filePath = null } = {}) {
    const reservation = {
      documentId,
      filePath:
        filePath ||
        this.documentsById.get(documentId)?.filePath ||
        this.serializedDocuments.get(documentId)?.filePath ||
        null,
    };
    this._pendingViews.add(reservation);
    return new Disposable(() => {
      if (!this._pendingViews.delete(reservation)) return;
      const document =
        this.documentsById.get(documentId) ||
        (reservation.filePath ? this.documents.get(reservation.filePath) : null);
      if (!document || document.refCount > 0) return;
      // A closed placeholder never retained its document. Keep it only while
      // another pending split or file opener can still attach to this load.
      const stillAwaited = [...this._pendingViews].some(
        (candidate) =>
          candidate.documentId === document.id ||
          (candidate.filePath && candidate.filePath === document.filePath),
      );
      if (!stillAwaited) document.destroy();
    });
  }

  async getOrCreateDocumentById(documentId) {
    if (this._loadingPromisesById.has(documentId)) return this._loadingPromisesById.get(documentId);
    if (this.documentsById.has(documentId)) return this.documentsById.get(documentId);
    const state = this.serializedDocuments.get(documentId);
    if (!state) return null;

    const document = createDocument(state.filePath || null);
    document.id = documentId;
    await this._loadDocument(document, async () => {
      if (state.notebookData) {
        await document.initializeFromData(state.notebookData);
        document.restoreState({ ...state, documentId });
        await document.reconcileRestoredFileState();
        if (document.filePath) document._watchFile();
      } else {
        await document.load();
        document.restoreState({ ...state, documentId }, { preserveLoadedRevision: true });
      }
    });
    this.serializedDocuments.delete(documentId);
    return document;
  }

  /**
   * Get or create a document for the given file path.
   * Returns an existing document if one is already open for this path.
   * Concurrent calls for the same path share one load promise, preventing
   * split-view restore from initializing a view with an empty document.
   */
  async getOrCreateDocument(filePath) {
    if (filePath && this._loadingPromises.has(filePath)) {
      return this._loadingPromises.get(filePath);
    }
    if (filePath && this.documents.has(filePath)) {
      return this.documents.get(filePath);
    }
    const document = createDocument(filePath);
    return this._loadDocument(document, () => document.load());
  }

  /**
   * Restore a file-backed document from serialized workspace state.
   * Multiple panes for the same file must share the same restored document;
   * otherwise edits in one split view stop propagating after restart.
   */
  async getOrCreateDocumentFromData(filePath, notebookData, options = {}) {
    if (!filePath) return null;

    if (this._loadingPromises.has(filePath)) {
      return this._loadingPromises.get(filePath);
    }
    if (this.documents.has(filePath)) {
      return this.documents.get(filePath);
    }
    const document = createDocument(filePath);
    return this._loadDocument(document, async () => {
      await document.initializeFromData(notebookData);
      if (options.fileState) document.setFileState(options.fileState);
    });
  }

  _loadDocument(document, load) {
    if (this._destroyed) {
      document.destroy();
      return Promise.reject(new Error("Notebook document registry is destroyed."));
    }
    const filePath = document.filePath;
    const loading = Promise.resolve()
      .then(() => {
        if (this._destroyed)
          throw new Error("Notebook document registry was destroyed while loading.");
        return load();
      })
      .then(() => {
        if (this._destroyed || document._destroyed) {
          throw new Error("Notebook document registry was destroyed while loading.");
        }
        return document;
      })
      .catch((error) => {
        document.destroy();
        throw error;
      })
      .finally(() => {
        if (this._loadingPromises.get(filePath) === loading) this._loadingPromises.delete(filePath);
        if (this._loadingPromisesById.get(document.id) === loading)
          this._loadingPromisesById.delete(document.id);
      });
    // Publish the in-progress handles before registration emits did-add: a
    // split opened by that event must join the load rather than get empty data.
    if (filePath) this._loadingPromises.set(filePath, loading);
    this._loadingPromisesById.set(document.id, loading);
    this._registerDocument(document);
    return loading;
  }

  /**
   * Create a new untitled document.
   */
  async createUntitledDocument() {
    this.untitledCounter++;
    const document = createDocument(null);
    return this._loadDocument(document, () => document.initialize());
  }

  /**
   * Build an editor for a file path.
   * This is the main entry point for opening notebooks.
   */
  async buildEditor(filePath) {
    const reservation = this.reserveDocumentView({ filePath });
    try {
      const document = filePath
        ? await this.getOrCreateDocument(filePath)
        : await this.createUntitledDocument();
      if (this._destroyed || document._destroyed)
        throw new Error("Notebook document registry is destroyed.");
      return createEditor(document);
    } finally {
      reservation.dispose();
    }
  }

  /**
   * Build an editor from serialized notebook data (for restoring unsaved notebooks).
   */
  async buildEditorFromData(notebookData, activeCellIndex = 0) {
    this.untitledCounter++;
    const document = createDocument(null);
    await this._loadDocument(document, () => document.initializeFromData(notebookData));
    if (this._destroyed || document._destroyed)
      throw new Error("Notebook document registry is destroyed.");

    const editor = createEditor(document);
    editor.setActiveCell(activeCellIndex);
    return editor;
  }

  /**
   * Get the document for a file path if it exists.
   */
  getDocument(filePath) {
    return this.documents.get(filePath);
  }

  /**
   * Check if a document exists for a file path.
   */
  hasDocument(filePath) {
    return this.documents.has(filePath);
  }

  /**
   * Get all open documents.
   */
  getDocuments() {
    return Array.from(this.documentsById.values());
  }

  isDocumentLoading(documentId) {
    return this._loadingPromisesById.has(documentId);
  }

  whenDocumentReady(documentId) {
    return (
      this._loadingPromisesById.get(documentId) ||
      Promise.resolve(this.documentsById.get(documentId) || null)
    );
  }

  serialize() {
    const documents = {};
    for (const document of this.documentsById.values()) {
      // A restored document is registered before its asynchronous hydration.
      // Until that finishes, the recovery record owns the unsaved cells; the
      // live document may still be empty or have only part of its revision.
      const recovering =
        this._loadingPromisesById.has(document.id) && this.serializedDocuments.get(document.id);
      documents[document.id] = recovering ? structuredClone(recovering) : document.serializeState();
    }
    return documents;
  }

  /**
   * Destroy all documents and clean up.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const document of this.documentsById.values()) {
      document.destroy();
    }
    this.documents.clear();
    this.documentsById.clear();
    this.serializedDocuments.clear();
    this._loadingPromises.clear();
    this._loadingPromisesById.clear();
    this._pendingViews.clear();
    this.emitter.dispose();
  }
}

// Bridges the `linter.editors` service to the notebook's editors. Only pane
// items are linted on their own; the hidden source editor is registered for
// real linting (its diagnostics reach the cells through the `linter.adapter`
// this package also provides), and each cell editor is registered render-only
// ({ lint: false }) so projected messages have marker layers to land on. The
// service connects whenever the linter package activates, before or after a
// notebook opens, so registrations made early are kept and replayed when it
// arrives.

class LinterEditors {
  constructor() {
    // editor -> { options, disposable, destroySubscription }. A null disposable
    // marks an editor waiting for the service to arrive.
    this.editors = new Map();
    this.register = null;
    this.providerGeneration = 0;
  }

  /**
   * Consume the `linter.editors` service. Registers every editor that was
   * added before it arrived; returns a Disposable revoking it again.
   */
  consume(register) {
    this.disable();
    this.register = register;
    const generation = this.providerGeneration;
    for (const entry of this.editors.values()) {
      if (entry.disposable === null) entry.disposable = this.register(entry.editor, entry.options);
    }
    return new Disposable(() => {
      if (this.providerGeneration === generation) this.disable();
    });
  }

  /**
   * Stand down while the service is away, keeping every editor so the next
   * connection replays them.
   */
  disable() {
    this.providerGeneration++;
    this.register = null;
    for (const entry of this.editors.values()) {
      entry.disposable?.dispose();
      entry.disposable = null;
    }
  }

  add(editor, options = {}) {
    if (!editor) return new Disposable();
    // Registering the same editor twice would otherwise strand the first
    // registration in the service with nothing left holding its disposable.
    this.remove(editor);
    this.editors.set(editor, {
      editor,
      options,
      disposable: this.register ? this.register(editor, options) : null,
      // The map holds the editor strongly, so a registration must not be able
      // to outlive it even when whatever made it forgets to dispose.
      destroySubscription: editor.onDidDestroy?.(() => this.remove(editor)) ?? null,
    });
    return new Disposable(() => this.remove(editor));
  }

  remove(editor) {
    const entry = this.editors.get(editor);
    if (!entry) return;
    entry.disposable?.dispose();
    entry.destroySubscription?.dispose();
    this.editors.delete(editor);
  }

  destroy() {
    this.providerGeneration++;
    for (const editor of [...this.editors.keys()]) this.remove(editor);
    this.register = null;
  }
}

// One registry per activation of the package. main.js creates it in
// initialize() — which runs before the workspace asks for this package's
// deserializers, so a restored notebook already has one to register with — and
// disposes it in deactivate(). Nothing a notebook registers outlives the
// package that owns it, and the next activation starts from an empty registry
// rather than inheriting the editors of the last.
let registry = null;

function linterEditors() {
  if (!registry) registry = new LinterEditors();
  return registry;
}

function createLinterEditors() {
  registry?.destroy();
  const ownedRegistry = new LinterEditors();
  registry = ownedRegistry;
  return new Disposable(() => {
    ownedRegistry.destroy();
    if (registry === ownedRegistry) registry = null;
  });
}

function consumeLinterEditors(register) {
  return linterEditors().consume(register);
}

function addLinterEditor(editor, options = {}) {
  return linterEditors().add(editor, options);
}

/**
 * Wires the `autocomplete.watch-editor` service into notebook cell editors.
 *
 * Cell editors are not workspace pane items, so the autocomplete package does
 * not watch them on its own. Labels select which providers serve a watched
 * editor: "workspace-center" matches the kernel provider (and any provider
 * without explicit labels), "default" matches the editor's built-in word
 * provider.
 */

const CELL_EDITOR_LABELS = ["default", "workspace-center"];

class AutocompleteWatch {
  constructor() {
    // editor -> { editor, disposable, destroySubscription }. A null disposable
    // marks an editor waiting for the service to arrive.
    this.editors = new Map();
    this.watchEditor = null;
    this.providerGeneration = 0;
  }

  get isEnabled() {
    return this.watchEditor != null;
  }

  /**
   * Consume the `autocomplete.watch-editor` service. Watches every editor that
   * was added before it arrived; returns a Disposable revoking it again.
   */
  consume(watchEditor) {
    this.disable();
    const generation = this.providerGeneration;
    this.watchEditor = watchEditor;
    for (const entry of this.editors.values()) {
      if (entry.disposable === null) entry.disposable = this.registerEditor(entry.editor);
    }
    return new Disposable(() => {
      if (this.providerGeneration === generation) this.disable();
    });
  }

  /**
   * Stand down while the service is away, keeping every editor so the next
   * connection replays them.
   */
  disable() {
    this.providerGeneration++;
    this.watchEditor = null;
    for (const entry of this.editors.values()) {
      entry.disposable?.dispose();
      entry.disposable = null;
    }
  }

  registerEditor(editor) {
    return this.watchEditor(editor, CELL_EDITOR_LABELS) ?? null;
  }

  /**
   * Keep autocomplete active in a cell editor. Effective immediately when the
   * service is present, or as soon as it arrives.
   */
  watch(editor) {
    if (!editor) return new Disposable();
    // A watch carries no options, so a second call is the same request as the
    // first: leave the registration it made alone rather than cycling it.
    if (this.editors.has(editor)) return new Disposable();
    this.editors.set(editor, {
      editor,
      disposable: this.isEnabled ? this.registerEditor(editor) : null,
      // The map holds the editor strongly, so a watch must not be able to
      // outlive it even when whatever asked for it forgets to dispose.
      destroySubscription: editor.onDidDestroy?.(() => this.remove(editor)) ?? null,
    });
    return new Disposable(() => this.remove(editor));
  }

  remove(editor) {
    const entry = this.editors.get(editor);
    if (!entry) return;
    entry.disposable?.dispose();
    entry.destroySubscription?.dispose();
    this.editors.delete(editor);
  }

  destroy() {
    this.providerGeneration++;
    for (const editor of [...this.editors.keys()]) this.remove(editor);
    this.watchEditor = null;
  }
}

// One watcher per activation of the package, on the same terms as the
// linter-editors registry beside it: main.js creates it in initialize() — early
// enough for a notebook the workspace deserializes before activate() — and
// disposes it in deactivate().
let watcher = null;

function autocompleteWatch() {
  if (!watcher) watcher = new AutocompleteWatch();
  return watcher;
}

function createAutocompleteWatch() {
  watcher?.destroy();
  const ownedWatcher = new AutocompleteWatch();
  watcher = ownedWatcher;
  return new Disposable(() => {
    ownedWatcher.destroy();
    if (watcher === ownedWatcher) watcher = null;
  });
}

function consumeAutocompleteWatchEditor(watchEditor) {
  return autocompleteWatch().consume(watchEditor);
}

function watchCellEditor(editor) {
  return autocompleteWatch().watch(editor);
}

module.exports = NotebookDocumentRegistry;

Object.defineProperties(module.exports, {
  linterEditors: {
    value: { LinterEditors, createLinterEditors, consumeLinterEditors, addLinterEditor },
  },
  autocompleteWatch: {
    value: {
      AutocompleteWatch,
      createAutocompleteWatch,
      consumeAutocompleteWatchEditor,
      watchCellEditor,
    },
  },
});
