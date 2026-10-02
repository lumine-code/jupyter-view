const { Disposable, Emitter } = require("lumine");
const NotebookDocument = require("./notebook-document");
const JupyterNotebookEditor = require("./jupyter-notebook-editor");

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

    const document = new NotebookDocument(state.filePath || null);
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
    const document = new NotebookDocument(filePath);
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
    const document = new NotebookDocument(filePath);
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
    const document = new NotebookDocument(null);
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
      return new JupyterNotebookEditor(document);
    } finally {
      reservation.dispose();
    }
  }

  /**
   * Build an editor from serialized notebook data (for restoring unsaved notebooks).
   */
  async buildEditorFromData(notebookData, activeCellIndex = 0) {
    this.untitledCounter++;
    const document = new NotebookDocument(null);
    await this._loadDocument(document, () => document.initializeFromData(notebookData));
    if (this._destroyed || document._destroyed)
      throw new Error("Notebook document registry is destroyed.");

    const editor = new JupyterNotebookEditor(document);
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

  serialize() {
    const documents = {};
    for (const document of this.documentsById.values()) {
      documents[document.id] = document.serializeState();
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

module.exports = NotebookDocumentRegistry;
