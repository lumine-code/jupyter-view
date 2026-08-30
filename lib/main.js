const { CompositeDisposable, Disposable } = require("lumine");
const path = require("path");
const etch = require("@lumine-code/etch");

// Etch holds its scheduler per copy of the library, and this package resolves
// its own copy — so the assignment the editor makes on core's copy never
// reaches it. Point it at the view registry before anything renders, or this
// package's DOM writes land on an animation frame of their own alongside the
// editor's and force a synchronous reflow.
etch.setScheduler(lumine.views);

/**
 * jupyter-view
 * Provides notebook UI, navigation, and cell model editing within Lumine.
 */

// Lazy-loaded modules
let NotebookDocumentRegistry = null;
let NotebookScrollmap = null;
let JupyterAdapterService = null;
let NotebookSearchAdapter = null;

function getNotebookDocumentRegistry() {
  if (!NotebookDocumentRegistry) {
    NotebookDocumentRegistry = require("./notebook-document-registry");
  }
  return NotebookDocumentRegistry;
}

function getNotebookScrollmap() {
  if (!NotebookScrollmap) {
    NotebookScrollmap = require("./scrollmap-integration");
  }
  return NotebookScrollmap;
}

function getJupyterAdapterService() {
  if (!JupyterAdapterService) {
    JupyterAdapterService = require("./jupyter-adapter");
  }
  return JupyterAdapterService;
}

function getNotebookSearchAdapter() {
  if (!NotebookSearchAdapter) {
    NotebookSearchAdapter = require("./notebook-search");
  }
  return NotebookSearchAdapter;
}

/**
 * Resolve the notebook a command was dispatched at, falling back to the active
 * one. The notebook's commands are registered on `.jupyter-notebook-container`,
 * so the event always starts inside the notebook it means, while
 * getActiveNotebook only ever answers with the center pane's item — a different
 * notebook, or none, whenever this one sits in a dock or an inactive split.
 * @param {Object} context - The module context (this)
 * @param {Event} [event] - The dispatched command event
 */
function notebookForEvent(context, event) {
  const container = event?.target?.closest?.(".jupyter-notebook-container");
  const notebook = container?._jupyterNotebookEditor;
  if (notebook && !notebook._destroyed) return notebook;
  return context.getActiveNotebook();
}

/**
 * Helper to delegate a method call to the dispatched-at notebook or its view
 * @param {Object} context - The module context (this)
 * @param {string} methodName - Method name to call
 * @param {Event} [event] - The command event naming the notebook to act on
 * @param {boolean} useView - If true, delegate to notebook.view instead
 * @param {...any} args - Arguments to pass to the method
 */
function delegateToNotebook(context, methodName, event, useView = false, ...args) {
  const notebook = notebookForEvent(context, event);
  if (!notebook) return;

  const target = useView ? notebook.view : notebook;
  if (target && typeof target[methodName] === "function") {
    return target[methodName](...args);
  }
}

function getOutputContainerForNode(node) {
  if (!node) return null;

  const element = node.nodeType === 1 ? node : node.parentElement;
  return element?.closest?.(".jupyter-output-container") || null;
}

function getSelectedOutputText(event) {
  const selection = window.getSelection?.();
  const text = selection?.toString();
  if (!text) return "";

  if (event?.target?.closest?.(".jupyter-output-container")) return text;

  const anchorOutput = getOutputContainerForNode(selection.anchorNode);
  const focusOutput = getOutputContainerForNode(selection.focusNode);
  return anchorOutput || focusOutput ? text : "";
}

function copyOutputSelection(event) {
  const text = getSelectedOutputText(event);
  if (!text) return false;

  lumine.clipboard.write(text);
  event?.preventDefault?.();
  event?.stopPropagation?.();
  event?.stopImmediatePropagation?.();
  return true;
}

module.exports = {
  config: require("../package.json").configSchema,

  /**
   * Restore document state before workspace pane items are deserialized.
   * Lumine calls initialize() before invoking package deserializers, while
   * activate() may run only after the workspace has already requested them.
   */
  initialize(state = {}) {
    const RegistryClass = getNotebookDocumentRegistry();
    this.documentRegistry = new RegistryClass(state?.documents || {});
    // Owned from here rather than from activate() for the same reason the
    // document registry is: a restored notebook registers its editors with the
    // linter while deserializing, which can be before activate() has run.
    this.linterEditors = require("./linter-editors").createLinterEditors();
    this.autocompleteWatch = require("./autocomplete-watch").createAutocompleteWatch();
  },

  /**
   * Activates the package and registers notebook commands.
   * @param {Object} state - Serialized state from previous session
   */
  activate(state = {}) {
    this.disposables = new CompositeDisposable();
    if (!this.documentRegistry) this.initialize(state);
    this.notebookEditors = this.notebookEditors || new Set();
    this.notebookScrollmaps = this.notebookScrollmaps || new Map();
    this.Simplemap = this.Simplemap || null;
    this.workspaceOpenerDisposable = null;
    this.lastTreeViewContextPath = null;
    this.treeViewService = null;

    // The global tier: the three commands that need no notebook open, and so
    // are the only ones the application menu can name. Everything the notebook
    // itself does is registered on the notebook, further down.
    this.disposables.add(
      lumine.commands.add("lumine-workspace", {
        "jupyter-view:toggle": {
          description: "Hide or show the active notebook, or start a new one.",
          didDispatch: () => this.toggle(),
        },
        "jupyter-view:new-notebook": {
          description: "Create an empty notebook and open it.",
          didDispatch: () => this.newNotebook(),
        },
        "jupyter-view:open-source": {
          description: "Open the notebook's underlying ipynb file as text.",
          didDispatch: () => this.openSource(),
        },
      }),
      // A `vscode-notebook-cell:` location — a definition or reference inside
      // a notebook — opens the notebook and reveals the cell. Independent of
      // the .ipynb opener setting: a cell URI is notebook-addressed by nature.
      lumine.workspace.addOpener((uri, options) => {
        const parsed = require("./cell-uri").parseCellUri(uri);
        if (parsed) return this.openCell(parsed, options);
      }),
      // The setting is the off switch for language servers in notebooks; the
      // service may arrive before or after either flip.
      lumine.config.onDidChange("jupyter-view.lsp.enabled", ({ newValue }) => {
        if (newValue === false) this.teardownLspBridge();
        else this.setupLspBridge();
      }),
    );

    // The notebook's own commands, scoped to the notebook. At lumine-workspace
    // all forty were listed in the command palette from anywhere and acted on
    // whatever notebook was the active center pane item, however far focus had
    // moved from it. The container is the pane item's root element, so the walk
    // up from the dispatch target reaches these only from inside a notebook.
    this.disposables.add(
      lumine.commands.add(".jupyter-notebook-container", {
        // The run commands route through jupyter-repl's execution service,
        // whose adapter member drives this package's own notebook adapter —
        // the same path the old jupyter-repl:run-cell dispatches took. They are
        // the three that cannot name their notebook from the event: the service
        // resolves the active adapter on its own side of the contract.
        "jupyter-view:run-cell": {
          description: "Run the selected cell in the notebook's kernel.",
          didDispatch: () => this.runAdapterCell("active", false),
        },
        "jupyter-view:run-cell-and-move-down": {
          description: "Run the selected cell and move on to the next.",
          didDispatch: () => this.runAdapterCell("active", true),
        },
        "jupyter-view:run-all": {
          description: "Run every cell in the notebook, from the top.",
          didDispatch: () => this.runAdapterCell("all", false),
        },
        "jupyter-view:clear-output": {
          description: "Remove the output of the selected cell.",
          didDispatch: (event) => this.clearOutput(event),
        },
        "jupyter-view:clear-all-outputs": {
          description: "Remove the output of every cell in the notebook.",
          didDispatch: (event) => this.clearAllOutputs(event),
        },
        "jupyter-view:insert-cell-above": {
          description: "Add an empty cell above the selected one.",
          didDispatch: (event) => this.insertCellAbove(event),
        },
        "jupyter-view:insert-cell-below": {
          description: "Add an empty cell below the selected one.",
          didDispatch: (event) => this.insertCellBelow(event),
        },
        "jupyter-view:insert-cell-below-and-edit": {
          description: "Add a cell below the selection and start typing in it.",
          didDispatch: (event) => this.insertCellBelowAndEdit(event),
        },
        "jupyter-view:insert-cell-below-and-extend-selection": {
          description: "Add a cell below and take it into the selection.",
          didDispatch: (event) => this.insertCellBelowAndExtendSelection(event),
        },
        "jupyter-view:insert-cell-above-and-extend-selection": {
          description: "Add a cell above and take it into the selection.",
          didDispatch: (event) => this.insertCellAboveAndExtendSelection(event),
        },
        "jupyter-view:delete-cell": {
          description: "Remove the selected cells from the notebook.",
          didDispatch: (event) => this.deleteCell(event),
        },
        "jupyter-view:move-cell-up": {
          description: "Swap the selected cell with the one above it.",
          didDispatch: (event) => this.moveCellUp(event),
        },
        "jupyter-view:move-cell-down": {
          description: "Swap the selected cell with the one below it.",
          didDispatch: (event) => this.moveCellDown(event),
        },
        "jupyter-view:change-cell-to-code": {
          description: "Turn the selected cell into a code cell.",
          didDispatch: (event) => this.changeCellType("code", event),
        },
        "jupyter-view:change-cell-to-markdown": {
          description: "Turn the selected cell into a Markdown cell.",
          didDispatch: (event) => this.changeCellType("markdown", event),
        },
        "jupyter-view:change-cell-to-raw": {
          description: "Turn the selected cell into a raw, unrendered cell.",
          didDispatch: (event) => this.changeCellType("raw", event),
        },
        "jupyter-view:toggle-cell-output": {
          description: "Show or hide the output of the selected cell.",
          didDispatch: (event) => this.toggleCellOutput(event),
        },
        "jupyter-view:toggle-cell-input": {
          description: "Show or hide the source of the selected cell.",
          didDispatch: (event) => this.toggleCellInput(event),
        },
        "jupyter-view:export-to-python": {
          description: "Write the notebook's code out as a Python file.",
          didDispatch: (event) => this.exportToPython(event),
        },
        "jupyter-view:export-to-html": {
          description: "Write the notebook out as a rendered HTML file.",
          didDispatch: (event) => this.exportToHtml(event),
        },
        // Mode switching
        "jupyter-view:enter-edit-mode": {
          description: "Start typing inside the selected cell.",
          didDispatch: (event) => this.enterEditMode(event),
        },
        "jupyter-view:enter-command-mode": {
          description: "Leave the cell, so the keys act on the notebook.",
          didDispatch: (event) => this.enterCommandMode(event),
        },
        // Navigation
        "jupyter-view:focus-previous-cell": {
          description: "Select the cell above without entering it.",
          didDispatch: (event) => this.focusPreviousCell(event),
        },
        "jupyter-view:focus-next-cell": {
          description: "Select the cell below without entering it.",
          didDispatch: (event) => this.focusNextCell(event),
        },
        "jupyter-view:focus-first-cell": {
          description: "Select the first cell of the notebook.",
          didDispatch: (event) => this.focusFirstCell(event),
        },
        "jupyter-view:focus-last-cell": {
          description: "Select the last cell of the notebook.",
          didDispatch: (event) => this.focusLastCell(event),
        },
        "jupyter-view:select-previous-cell": {
          description: "Extend the selection to the cell above.",
          didDispatch: (event) => this.selectPreviousCell(event),
        },
        "jupyter-view:select-next-cell": {
          description: "Extend the selection to the cell below.",
          didDispatch: (event) => this.selectNextCell(event),
        },
        // Save
        "jupyter-view:save": (event) => this.save(event),
        "jupyter-view:save-as": (event) => this.saveAs(event),
        // Undo/Redo notebook edits
        "jupyter-view:undo-cell-operation": {
          description: "Undo the last change to the notebook's cells.",
          didDispatch: (event) => this.undoCellOperation(event),
        },
        "jupyter-view:redo-cell-operation": {
          description: "Redo the last undone change to the cells.",
          didDispatch: (event) => this.redoCellOperation(event),
        },
        // Cut/Copy/Paste cells
        "jupyter-view:cut-cell": {
          description: "Cut the selected cells to the notebook clipboard.",
          didDispatch: (event) => this.cutCell(event),
        },
        "jupyter-view:copy-cell": {
          description: "Copy the selected cells to the notebook clipboard.",
          didDispatch: (event) => this.copyCell(event),
        },
        "jupyter-view:paste-cell-below": {
          description: "Paste the copied cells below the selection.",
          didDispatch: (event) => this.pasteCellBelow(event),
        },
        "jupyter-view:paste-cell-above": {
          description: "Paste the copied cells above the selection.",
          didDispatch: (event) => this.pasteCellAbove(event),
        },
        // Duplicate cell
        "jupyter-view:duplicate-cell": {
          description: "Add a copy of the selected cell below it.",
          didDispatch: (event) => this.duplicateCell(event),
        },
        // Merge cells
        "jupyter-view:merge-cell-below": {
          description: "Join the selected cell with the one below it.",
          didDispatch: (event) => this.mergeCellBelow(event),
        },
        // Scrolling the notebook itself, as opposed to a cell's editor. These
        // were named smooth-scroll:* after a package that does not exist in
        // this ecosystem, which put two commands in a namespace nothing owns
        // and listed them in the palette under a package nobody could find.
        "jupyter-view:scroll-up": {
          description: "Scroll the notebook up by one page.",
          didDispatch: (event) => delegateToNotebook(this, "scrollUp", event, true),
        },
        "jupyter-view:scroll-down": {
          description: "Scroll the notebook down by one page.",
          didDispatch: (event) => delegateToNotebook(this, "scrollDown", event, true),
        },
      }),
    );

    // Copy selected text from cell output
    this.disposables.add(
      lumine.commands.add(".jupyter-output-container", {
        "jupyter-view:copy-output-selection": {
          description: "Copy what is selected in a cell's output.",
          didDispatch: (event) => copyOutputSelection(event),
        },
        "core:copy": (event) => copyOutputSelection(event),
      }),
    );

    this.disposables.add(
      lumine.contextMenu.add({
        ".jupyter-output-container": [
          {
            label: "Copy",
            command: "jupyter-view:copy-output-selection",
            shouldDisplay: () => !!getSelectedOutputText(),
          },
        ],
      }),
    );

    // Map core:save and core:save-as to notebook save when a notebook is active
    // Use .jupyter-notebook-container selector to only handle saves within notebooks
    this.disposables.add(
      lumine.commands.add(".jupyter-notebook-container", {
        "core:save": (event) => {
          event.stopPropagation();
          this.save(event);
        },
        "core:save-as": (event) => {
          event.stopPropagation();
          this.saveAs(event);
        },
        "core:undo": (event) => {
          event.stopPropagation();
          this.undoCellOperation(event);
        },
        "core:redo": (event) => {
          event.stopPropagation();
          this.redoCellOperation(event);
        },
        "core:copy": (event) => {
          if (event?.target?.closest?.("lumine-text-editor")) return;
          copyOutputSelection(event);
        },
      }),
    );

    this.disposables.add(
      lumine.commands.add("lumine-text-editor.jupyter-cell-editor", {
        "core:undo": (event) => {
          event.preventDefault?.();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          this.undoCellOperation(event);
        },
        "core:redo": (event) => {
          event.preventDefault?.();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          this.redoCellOperation(event);
        },
      }),
    );

    this.disposables.add(
      lumine.commands.add(".tree-view", {
        "jupyter-view:open-notebook": {
          description: "Open this ipynb file in the notebook view.",
          didDispatch: (event) => {
            event.stopPropagation();
            this.openSelectedTreeViewNotebook(event);
          },
        },
        "jupyter-view:open-source": (event) => {
          event.stopPropagation();
          this.openSelectedTreeViewSource(event);
        },
      }),
    );

    const rememberTreeViewContextPath = (event) => {
      const fileEntry = event.target?.closest?.('.tree-view [is="tree-view-file"]');
      if (!fileEntry) return;
      this.lastTreeViewContextPath = fileEntry.getPath?.() ?? null;
    };
    document.addEventListener("contextmenu", rememberTreeViewContextPath, true);
    this.disposables.add(
      new Disposable(() => {
        document.removeEventListener("contextmenu", rememberTreeViewContextPath, true);
      }),
    );

    // Clear cell timers when the active notebook's kernel is shut down.  Use
    // onWillDispatch so we fire regardless of which package's handler ends
    // up calling stopPropagation on the shutdown command.
    this.disposables.add(
      lumine.commands.onWillDispatch((event) => {
        if (event?.type !== "jupyter-repl:shutdown-kernel") return;
        const notebook = notebookForEvent(this, event);
        notebook?.document?.clearAllCellTimers?.();
      }),
    );

    this.disposables.add(
      lumine.config.onDidChange("jupyter-view.notebook.useOpener", ({ newValue }) => {
        if (newValue !== false) {
          this.registerWorkspaceOpener();
        } else {
          this.unregisterWorkspaceOpener();
        }
      }),
    );

    // Register opener for .ipynb files
    this.registerWorkspaceOpener();

    this.disposables.add(
      lumine.workspace.onDidAddPaneItem(({ item }) => {
        this.trackNotebookEditor(item);
      }),
    );

    // Note: Notebook restoration is handled by Lumine's workspace via the
    // JupyterNotebookEditor deserializer. We don't need to manually re-open
    // notebooks here as that would cause duplicate tabs.
    this.discoverNotebookEditors();
    requestAnimationFrame(() => this.discoverNotebookEditors());
  },

  deactivate() {
    try {
      // Close the notebooks on the language servers while the connections
      // still exist, before the editors and documents go away.
      this.teardownLspBridge();
      // First, destroy notebook editors (this will trigger document cleanup)
      this.destroyNotebookScrollmaps();
      this.notebookEditors.forEach((editor) => {
        try {
          if (editor.destroy) {
            editor.destroy();
          }
        } catch (e) {
          console.error("[jupyter-view] Error destroying editor:", e);
        }
      });
      this.notebookEditors.clear();

      // Then destroy document registry
      if (this.documentRegistry) {
        try {
          this.documentRegistry.destroy();
        } catch (e) {
          console.error("[jupyter-view] Error destroying document registry:", e);
        }
        this.documentRegistry = null;
      }

      this.linterEditors?.dispose();
      this.linterEditors = null;
      this.autocompleteWatch?.dispose();
      this.autocompleteWatch = null;

      this.disposables.dispose();
      this.workspaceOpenerDisposable = null;
    } catch (e) {
      console.error("[jupyter-view] Error during deactivation:", e);
    }
  },

  serialize() {
    for (const editor of this.notebookEditors || []) {
      editor.sourceController?.flushPendingChanges?.(editor);
    }
    return { documents: this.documentRegistry?.serialize?.() || {} };
  },

  // Deserializer for notebook editors
  deserializeNotebookEditor(state) {
    // Ensure notebookEditors set exists
    if (!this.notebookEditors) {
      this.notebookEditors = new Set();
    }
    if (!this.notebookScrollmaps) {
      this.notebookScrollmaps = new Map();
    }

    if (!state?.documentId) {
      return null;
    }

    // Use JupyterNotebookEditor's static deserialize method
    // This checks for existing editors first (to prevent reload when moving panes)
    // and returns a placeholder that loads async if creating new
    const JupyterNotebookEditor = require("./jupyter-notebook-editor");
    const editor = JupyterNotebookEditor.deserialize(state, {
      documentRegistry: this.getDocumentRegistry(),
    });

    this.trackNotebookEditor(editor);

    return editor;
  },

  // Service providers
  provideJupyterNotebook() {
    return {
      getActiveNotebook: () => this.getActiveNotebook(),
      getDocumentRegistry: () => this.getDocumentRegistry(),
      getNotebookEditors: (document) => this.getNotebookEditors(document),
    };
  },

  provideJupyterAdapter() {
    const AdapterService = getJupyterAdapterService();
    return new AdapterService();
  },

  provideSearchAdapter() {
    const SearchAdapter = getNotebookSearchAdapter();
    return {
      handlesItem: (item) => this.isNotebookEditor(item),
      getAdapterForItem: (item) => {
        if (!this.isNotebookEditor(item) || item._destroyed) return null;
        if (!item._searchAdapter) {
          item._searchAdapter = new SearchAdapter(item);
        }
        return item._searchAdapter;
      },
    };
  },

  provideLinterUI() {
    return {
      name: "jupyter-view",
      render: ({ messages }) => {
        this.linterMessages = messages || [];
        this.broadcastLinterMessages();
      },
    };
  },

  broadcastLinterMessages() {
    if (!this.notebookScrollmaps) return;
    for (const scrollmap of this.notebookScrollmaps.values()) {
      scrollmap.setLinterMessages?.(this.linterMessages || []);
    }
  },

  provideLinterAdapter() {
    return {
      handlesItem: (item) => item?.constructor?.name === "JupyterNotebookEditor",
      getMarkerLocationsForMessage: (message) => this.getLinterMarkerLocations(message),
      getMessagesForItem: (item, messages) => {
        return messages.filter((message) => item.ownsLinterMessage?.(message));
      },
      getTextEditorForItem: (item) => item.getSourceEditor(),
      getCurrentMessage: (item, messages) => item.getCurrentLinterMessage(messages),
      getNextMessage: (item, messages) => item.getNextLinterMessage(messages),
      getPreviousMessage: (item, messages) => item.getPreviousLinterMessage(messages),
      revealMessage: (item, message) => item.revealLinterMessage(message),
    };
  },

  getLinterMarkerLocations(message) {
    const locations = [];
    const buffers = new Set();
    let ownsMessage = false;
    let hasCellLocation = false;

    for (const editor of this.notebookEditors || []) {
      if (!editor || editor._destroyed || editor.isDestroyed?.()) continue;
      if (!editor.ownsLinterMessage?.(message)) continue;
      ownsMessage = true;

      const cellIndex = editor.getLinterMessageCellIndex?.(message) ?? -1;
      if (cellIndex < 0) continue;
      hasCellLocation = true;

      const cellEditor = editor.getCellEditor?.(cellIndex + 1);
      const buffer = cellEditor?.getBuffer?.();
      if (!buffer || buffers.has(buffer)) continue;
      buffers.add(buffer);
      locations.push({ buffer, cell: cellIndex + 1 });
    }

    if (!ownsMessage || !hasCellLocation) return undefined;
    return locations;
  },

  provideNavigationAdapter() {
    return {
      handlesItem: (item) => item?.constructor?.name === "JupyterNotebookEditor",
      observeHeaders: (item, callback) => item.observeNavigationHeaders(callback),
      navigateTo: (item, header) => item.revealNavigationHeader(header),
    };
  },

  consumeTreeViewSelection(service) {
    this.treeViewService = service;
    return new Disposable(() => {
      this.treeViewService = null;
    });
  },

  consumeAutocompleteWatchEditor(watchEditor) {
    return require("./autocomplete-watch").consumeAutocompleteWatchEditor(watchEditor);
  },

  consumeLinterEditors(register) {
    return require("./linter-editors").consumeLinterEditors(register);
  },

  /**
   * ide-client's language-server hub. With it, every open notebook is fed to
   * the servers that understand notebooks — each code cell becomes its own
   * document with cross-cell context — and completions, hover, diagnostics,
   * and navigation work inside cells. Optional, like every service here, and
   * gated by the `lsp.enabled` setting.
   */
  consumeIdeClient(client) {
    this.ideClient = client;
    this.setupLspBridge();
    return new Disposable(() => {
      this.ideClient = null;
      this.teardownLspBridge();
    });
  },

  setupLspBridge() {
    if (!this.ideClient || this.lspBridgeManager) return;
    if (lumine.config.get("jupyter-view.lsp.enabled") === false) return;
    const { LspBridgeManager } = require("./lsp-bridge");
    this.lspBridgeManager = new LspBridgeManager(this.ideClient, this);
  },

  teardownLspBridge() {
    this.lspBridgeManager?.dispose();
    this.lspBridgeManager = null;
  },

  getNotebookEditors(document) {
    return [...(this.notebookEditors || [])].filter(
      (editor) => editor.document === document && !editor._destroyed,
    );
  },

  async openCell({ notebookPath, cellId }, options = {}) {
    const item = await this.openNotebook(notebookPath);
    if (typeof item?.revealCell === "function") {
      const index = item.document?.cells?.findIndex((cell) => cell.id === cellId) ?? -1;
      if (index >= 0) {
        await item.revealCell(index, {
          row: options.initialLine || 0,
          column: options.initialColumn || 0,
        });
      }
    }
    return item;
  },

  useWorkspaceOpener() {
    return lumine.config.get("jupyter-view.notebook.useOpener") !== false;
  },

  registerWorkspaceOpener() {
    if (!this.useWorkspaceOpener() || this.workspaceOpenerDisposable) return;

    this.workspaceOpenerDisposable = lumine.workspace.addOpener((uri, options = {}) => {
      if (options.skipJupyterViewOpener) return;
      if (uri && uri.toLowerCase().endsWith(".ipynb")) {
        return this.openNotebook(uri);
      }
    });
    this.disposables.add(this.workspaceOpenerDisposable);
  },

  unregisterWorkspaceOpener() {
    if (!this.workspaceOpenerDisposable) return;
    this.workspaceOpenerDisposable.dispose();
    this.workspaceOpenerDisposable = null;
  },

  /**
   * jupyter-repl's renderers, through which stored outputs render with full
   * fidelity. Optional: without it the views fall back to text and images.
   */
  consumeJupyterOutput(service) {
    const outputRenderer = require("./output-renderer");
    outputRenderer.set(service);
    return new Disposable(() => outputRenderer.set(null));
  },

  consumeJupyterExecution(execution) {
    this.executionService = execution;
    return new Disposable(() => {
      this.executionService = null;
    });
  },

  // Run through the execution service's adapter routing, which lands back on
  // this package's own jupyter.adapter provider for the active notebook.
  runAdapterCell(scope, moveDown) {
    if (!this.executionService) {
      lumine.notifications.addWarning("Running notebook cells needs the jupyter-repl package", {
        description:
          "jupyter-view renders the notebook; the jupyter-repl package owns the kernels that run its cells. Install it to run cells.",
      });
      return;
    }
    this.executionService.runAdapter(scope, moveDown);
  },

  consumeScrollmapWidget(Simplemap) {
    this.Simplemap = Simplemap;
    this.discoverNotebookEditors();
    for (const editor of this.notebookEditors || []) {
      this.setupNotebookScrollmap(editor);
    }
    return new Disposable(() => {
      this.Simplemap = null;
      this.destroyNotebookScrollmaps();
    });
  },

  isNotebookEditor(item) {
    return item?.constructor?.name === "JupyterNotebookEditor";
  },

  discoverNotebookEditors() {
    for (const item of lumine.workspace.getPaneItems()) {
      this.trackNotebookEditor(item);
    }
  },

  trackNotebookEditor(editor) {
    if (!this.isNotebookEditor(editor) || editor._destroyed) return;
    this.notebookEditors = this.notebookEditors || new Set();
    this.notebookScrollmaps = this.notebookScrollmaps || new Map();

    if (!this.notebookEditors.has(editor)) {
      this.notebookEditors.add(editor);
      editor.onDidDestroy(() => {
        this.notebookEditors.delete(editor);
        this.destroyNotebookScrollmap(editor);
      });
      // A split view or restored pane brings its own cell editors; the
      // language-server bridge re-sends the cell list with them. A restored
      // item is tracked before its document loads, so the announcement waits
      // for the attach — without it the bridge never learns this editor
      // belongs to its document and the servers idle until the first edit.
      if (editor.document) {
        this.lspBridgeManager?.editorTracked(editor);
      } else {
        const attachSubscription = editor.onDidAttachDocument?.(() => {
          attachSubscription?.dispose();
          if (!editor._destroyed) this.lspBridgeManager?.editorTracked(editor);
        });
      }
    }

    this.setupNotebookScrollmap(editor);
  },

  setupNotebookScrollmap(editor) {
    this.notebookScrollmaps = this.notebookScrollmaps || new Map();
    if (!this.Simplemap || !editor || this.notebookScrollmaps?.has(editor)) return;
    const ScrollmapClass = getNotebookScrollmap();
    const scrollmap = new ScrollmapClass(editor, this.Simplemap);
    this.notebookScrollmaps.set(editor, scrollmap);
    if (this.linterMessages?.length) {
      scrollmap.setLinterMessages(this.linterMessages);
    }
  },

  destroyNotebookScrollmap(editor) {
    const scrollmap = this.notebookScrollmaps?.get(editor);
    if (!scrollmap) return;
    scrollmap.destroy();
    this.notebookScrollmaps.delete(editor);
  },

  destroyNotebookScrollmaps() {
    for (const scrollmap of this.notebookScrollmaps?.values() || []) {
      scrollmap.destroy();
    }
    this.notebookScrollmaps?.clear();
  },

  // Core functionality
  getDocumentRegistry() {
    if (!this.documentRegistry) {
      const RegistryClass = getNotebookDocumentRegistry();
      this.documentRegistry = new RegistryClass();
    }
    return this.documentRegistry;
  },

  getActiveNotebook() {
    const item = lumine.workspace.getCenter().getActivePaneItem();
    if (item && item.constructor.name === "JupyterNotebookEditor") {
      return item;
    }
    return null;
  },

  async openNotebook(uri) {
    // Check if there's already an open editor for this file
    // If so, create a copy (like split pane) to share the same document
    const normalizedUri = uri ? path.normalize(uri).toLowerCase() : null;

    if (normalizedUri) {
      // Search all pane items for an existing editor with this path
      // This includes deserialized editors that might not be in notebookEditors yet
      const JupyterNotebookEditor = require("./jupyter-notebook-editor");

      for (const paneContainer of [
        lumine.workspace.getCenter(),
        lumine.workspace.getLeftDock(),
        lumine.workspace.getRightDock(),
        lumine.workspace.getBottomDock(),
      ]) {
        if (!paneContainer) continue;
        for (const pane of paneContainer.getPanes()) {
          for (const item of pane.getItems()) {
            if (!(item instanceof JupyterNotebookEditor)) continue;
            if (item._destroyed) continue;

            const existingPath = item.getPath();
            if (existingPath && path.normalize(existingPath).toLowerCase() === normalizedUri) {
              // Found matching editor - wait for it to finish loading if needed
              if (item._loadingPromise) {
                await item._loadingPromise;
              }

              // After loading, verify editor is ready and not destroyed
              if (item._destroyed || !item.document || !item.view) {
                continue;
              }

              // Ensure it's tracked in notebookEditors
              this.trackNotebookEditor(item);

              // Create a copy that shares the document
              const editor = item.copy();
              this.trackNotebookEditor(editor);

              return editor;
            }
          }
        }
      }
    }

    // No existing ready editor found - create new one via registry
    // The registry handles document sharing at the document level
    const registry = this.getDocumentRegistry();
    const editor = await registry.buildEditor(uri);
    this.trackNotebookEditor(editor);

    return editor;
  },

  async openSource(filePath = null) {
    const sourcePath = filePath || this.getActiveNotebook()?.getPath?.();
    if (!sourcePath) return;

    if (!sourcePath.toLowerCase().endsWith(".ipynb")) {
      lumine.notifications.addWarning("Can only open notebook source for .ipynb files", {
        detail: sourcePath,
        dismissable: true,
      });
      return;
    }

    const existingEditor = lumine.workspace
      .getTextEditors()
      .find((editor) => editor.getPath && editor.getPath() === sourcePath);

    if (existingEditor) {
      return lumine.workspace.open(existingEditor);
    }

    const editor = await lumine.workspace.createItemForURI(sourcePath, {
      skipJupyterViewOpener: true,
    });
    return lumine.workspace.open(editor);
  },

  async openSelectedTreeViewSource(event = null) {
    const selectedPath = this.getSelectedTreeViewNotebookPath(event);
    if (!selectedPath) return;
    return this.openSource(selectedPath);
  },

  async openSelectedTreeViewNotebook(event = null) {
    const selectedPath = this.getSelectedTreeViewNotebookPath(event);
    if (!selectedPath) return;

    const editor = await this.openNotebook(selectedPath);
    return lumine.workspace.open(editor);
  },

  getSelectedTreeViewNotebookPath(event = null) {
    const clickedEntry = event?.target?.closest?.('[is="tree-view-file"]');
    const clickedPath = clickedEntry?.getPath?.() || clickedEntry?.fileName?.dataset?.path;
    if (clickedPath?.toLowerCase?.().endsWith(".ipynb")) {
      return clickedPath;
    }

    if (this.lastTreeViewContextPath?.toLowerCase?.().endsWith(".ipynb")) {
      return this.lastTreeViewContextPath;
    }

    const selectedPaths = this.treeViewService?.selectedPaths?.() || [];
    const selectedPath = selectedPaths.find((entryPath) =>
      entryPath.toLowerCase().endsWith(".ipynb"),
    );

    if (!selectedPath) {
      lumine.notifications.addWarning("Select a .ipynb file", {
        dismissable: true,
      });
    }

    return selectedPath;
  },

  async newNotebook() {
    const registry = this.getDocumentRegistry();
    const editor = await registry.buildEditor(null);
    this.trackNotebookEditor(editor);

    return lumine.workspace.open(editor);
  },

  toggle() {
    const notebook = this.getActiveNotebook();
    if (notebook) {
      lumine.workspace.toggle(notebook);
    } else {
      this.newNotebook();
    }
  },

  // Output operations
  clearOutput(event) {
    delegateToNotebook(this, "clearOutput", event);
  },
  clearAllOutputs(event) {
    delegateToNotebook(this, "clearAllOutputs", event);
  },

  // Cell insertion
  insertCellAbove(event) {
    delegateToNotebook(this, "insertCellAbove", event);
  },
  insertCellBelow(event) {
    delegateToNotebook(this, "insertCellBelow", event);
  },
  insertCellBelowAndEdit(event) {
    delegateToNotebook(this, "insertCellBelowAndEdit", event);
  },
  insertCellBelowAndExtendSelection(event) {
    delegateToNotebook(this, "insertCellBelowAndExtendSelection", event);
  },
  insertCellAboveAndExtendSelection(event) {
    delegateToNotebook(this, "insertCellAboveAndExtendSelection", event);
  },

  // Cell manipulation
  deleteCell(event) {
    delegateToNotebook(this, "deleteCell", event);
  },
  moveCellUp(event) {
    delegateToNotebook(this, "moveCellUp", event);
  },
  moveCellDown(event) {
    delegateToNotebook(this, "moveCellDown", event);
  },
  changeCellType(type, event) {
    delegateToNotebook(this, "changeCellType", event, false, type);
  },
  toggleCellOutput(event) {
    delegateToNotebook(this, "toggleCellOutput", event);
  },
  toggleCellInput(event) {
    delegateToNotebook(this, "toggleCellInput", event);
  },

  // Export functions
  exportToPython(event) {
    delegateToNotebook(this, "exportToPython", event);
  },
  exportToHtml(event) {
    delegateToNotebook(this, "exportToHtml", event);
  },

  // Mode switching (delegate to view)
  enterEditMode(event) {
    delegateToNotebook(this, "enterEditMode", event, true);
  },
  enterCommandMode(event) {
    if (this.shouldLetEscapeReduceCursors(event)) {
      event.abortKeyBinding();
      return;
    }
    delegateToNotebook(this, "enterCommandMode", event, true);
  },

  shouldLetEscapeReduceCursors(event) {
    const target = event?.target;
    const editorElement =
      target?.closest?.("lumine-text-editor.jupyter-cell-editor") ||
      (target?.matches?.("lumine-text-editor.jupyter-cell-editor") ? target : null);
    const editor = editorElement?.getModel?.();
    return (editor?.getCursors?.().length || 0) > 1;
  },

  // Navigation (delegate to view)
  focusPreviousCell(event) {
    delegateToNotebook(this, "focusPreviousCell", event, true);
  },
  focusNextCell(event) {
    delegateToNotebook(this, "focusNextCell", event, true);
  },
  focusFirstCell(event) {
    delegateToNotebook(this, "focusFirstCell", event, true);
  },
  focusLastCell(event) {
    delegateToNotebook(this, "focusLastCell", event, true);
  },
  selectPreviousCell(event) {
    delegateToNotebook(this, "selectPreviousCell", event, true);
  },
  selectNextCell(event) {
    delegateToNotebook(this, "selectNextCell", event, true);
  },

  // Save
  save(event) {
    delegateToNotebook(this, "save", event);
  },

  saveAs(event) {
    const notebook = notebookForEvent(this, event);
    if (notebook) {
      // Use Lumine's pane to show save dialog properly
      const pane = lumine.workspace.paneForItem(notebook);
      if (pane) {
        pane.saveItemAs(notebook);
      }
    }
  },

  // Undo/Redo notebook edits
  undoCellOperation(event) {
    delegateToNotebook(this, "undoCellOperation", event);
  },
  redoCellOperation(event) {
    delegateToNotebook(this, "redoCellOperation", event);
  },

  // Cut/Copy/Paste cells
  cutCell(event) {
    delegateToNotebook(this, "cutCell", event);
  },
  copyCell(event) {
    delegateToNotebook(this, "copyCell", event);
  },
  pasteCellBelow(event) {
    delegateToNotebook(this, "pasteCellBelow", event);
  },
  pasteCellAbove(event) {
    delegateToNotebook(this, "pasteCellAbove", event);
  },
  duplicateCell(event) {
    delegateToNotebook(this, "duplicateCell", event);
  },

  // Merge cells
  mergeCellBelow(event) {
    delegateToNotebook(this, "mergeCellBelow", event);
  },
};
