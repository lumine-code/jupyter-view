const { Emitter } = require("lumine");
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

  async getOrCreateDocumentById(documentId) {
    if (this.documentsById.has(documentId)) return this.documentsById.get(documentId);
    const state = this.serializedDocuments.get(documentId);
    if (!state) return null;

    const document = new NotebookDocument(state.filePath || null);
    document.id = documentId;
    this._registerDocument(document);
    if (state.notebookData) {
      await document.initializeFromData(state.notebookData);
      document.restoreState({ ...state, documentId });
      await document.reconcileRestoredFileState();
      if (document.filePath) document._watchFile();
    } else {
      await document.load();
      document.restoreState({ ...state, documentId }, { preserveLoadedRevision: true });
    }
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
    if (filePath && this.documents.has(filePath)) {
      return this.documents.get(filePath);
    }

    if (filePath && this._loadingPromises.has(filePath)) {
      return this._loadingPromises.get(filePath);
    }

    const loadPromise = (async () => {
      const document = this._registerDocument(new NotebookDocument(filePath));

      await document.load();

      if (filePath) {
        this.documents.set(filePath, document);
        this._loadingPromises.delete(filePath);
      }

      return document;
    })();

    if (filePath) {
      this._loadingPromises.set(filePath, loadPromise);
    }

    return loadPromise;
  }

  /**
   * Restore a file-backed document from serialized workspace state.
   * Multiple panes for the same file must share the same restored document;
   * otherwise edits in one split view stop propagating after restart.
   */
  async getOrCreateDocumentFromData(filePath, notebookData, options = {}) {
    if (!filePath) return null;

    if (this.documents.has(filePath)) {
      return this.documents.get(filePath);
    }

    if (this._loadingPromises.has(filePath)) {
      return this._loadingPromises.get(filePath);
    }

    const loadPromise = (async () => {
      const document = this._registerDocument(new NotebookDocument(filePath));

      await document.initializeFromData(notebookData);
      if (options.fileState) document.setFileState(options.fileState);

      this.documents.set(filePath, document);
      this._loadingPromises.delete(filePath);
      return document;
    })();

    this._loadingPromises.set(filePath, loadPromise);
    return loadPromise;
  }

  /**
   * Create a new untitled document.
   */
  async createUntitledDocument() {
    this.untitledCounter++;
    const document = this._registerDocument(new NotebookDocument(null));
    await document.initialize();
    return document;
  }

  /**
   * Build an editor for a file path.
   * This is the main entry point for opening notebooks.
   */
  async buildEditor(filePath) {
    const document = filePath
      ? await this.getOrCreateDocument(filePath)
      : await this.createUntitledDocument();

    return new JupyterNotebookEditor(document);
  }

  /**
   * Build an editor from serialized notebook data (for restoring unsaved notebooks).
   */
  async buildEditorFromData(notebookData, activeCellIndex = 0) {
    this.untitledCounter++;
    const document = this._registerDocument(new NotebookDocument(null));
    await document.initializeFromData(notebookData);

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
    for (const document of this.documentsById.values()) {
      document.destroy();
    }
    this.documents.clear();
    this.documentsById.clear();
    this.serializedDocuments.clear();
    this.emitter.dispose();
  }
}

module.exports = NotebookDocumentRegistry;
