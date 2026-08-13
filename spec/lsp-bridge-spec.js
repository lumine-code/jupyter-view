const { Emitter } = require("lumine");
const { LspBridgeManager } = require("../lib/lsp-bridge");
const main = require("../lib/main");

// The language-server bridge against fakes: a fake ide-client records the
// hub-bridge calls, fake documents speak the document-model event vocabulary.
// The contract under test is event names and payload shapes.

function fakeDocument({ filePath = null, cells = [] } = {}) {
  const emitter = new Emitter();
  return {
    filePath,
    cells,
    emitter,
    onDidChange: (fn) => emitter.on("did-change", fn),
    onDidReload: (fn) => emitter.on("did-reload", fn),
    onDidSave: (fn) => emitter.on("did-save", fn),
    onDidChangePath: (fn) => emitter.on("did-change-path", fn),
    onDidDestroy: (fn) => emitter.on("did-destroy", fn),
  };
}

function fakeClient() {
  const opened = [];
  return {
    opened,
    openNotebookDocument(descriptor) {
      const bridge = {
        descriptor,
        updates: [],
        saves: 0,
        disposed: false,
        updateCells(cells) {
          this.updates.push(cells);
        },
        didSave() {
          this.saves++;
        },
        dispose() {
          this.disposed = true;
        },
      };
      opened.push(bridge);
      return bridge;
    },
  };
}

function fakeHost(documents = []) {
  const registryEmitter = new Emitter();
  const registry = {
    documents: [...documents],
    observeDocuments(callback) {
      for (const document of this.documents) callback(document);
      return registryEmitter.on("did-add-document", callback);
    },
    add(document) {
      this.documents.push(document);
      registryEmitter.emit("did-add-document", document);
    },
  };
  return {
    registry,
    getDocumentRegistry: () => registry,
    getNotebookEditors: () => [],
  };
}

const flushFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

describe("the language-server bridge", () => {
  let manager;

  afterEach(() => {
    manager?.dispose();
    manager = null;
  });

  it("opens pre-existing and later documents, and skips untitled ones", () => {
    const untitled = fakeDocument({ filePath: null });
    const host = fakeHost([fakeDocument({ filePath: "C:\\proj\\a.ipynb" }), untitled]);
    const client = fakeClient();
    manager = new LspBridgeManager(client, host);

    // The untitled document produced no hub call.
    expect(client.opened.length).toBe(1);
    expect(client.opened[0].descriptor.filePath).toBe("C:\\proj\\a.ipynb");

    host.registry.add(fakeDocument({ filePath: "C:\\proj\\b.ipynb" }));
    expect(client.opened.length).toBe(2);

    // The untitled notebook attaches once its first save names it.
    untitled.filePath = "C:\\proj\\c.ipynb";
    untitled.emitter.emit("did-change-path", untitled.filePath);
    expect(client.opened.length).toBe(3);
  });

  it("translates document events into hub-bridge calls", async () => {
    const cells = [
      { id: "c1", type: "code", source: "x = 1\n" },
      { id: "m1", type: "markdown", source: "# hi\n" },
      { id: "r1", type: "raw", source: "raw\n" },
    ];
    const document = fakeDocument({ filePath: "C:\\proj\\nb.ipynb", cells });
    const host = fakeHost([document]);
    const client = fakeClient();
    manager = new LspBridgeManager(client, host);
    const bridge = client.opened[0];

    // The descriptor carries the full list: code as code, markdown and raw as
    // markup, model text standing in while no editor exists.
    expect(bridge.descriptor.cells.map((cell) => cell.kind)).toEqual(["code", "markup", "markup"]);
    expect(bridge.descriptor.cells[0].text).toBe("x = 1\n");

    document.emitter.emit("did-change", { affectsSource: true });
    // A runtime-only event schedules nothing.
    document.emitter.emit("did-change", { affectsSource: false, category: "runtime" });
    await flushFrame();
    expect(bridge.updates.length).toBe(1);

    // Coalescing: a burst of structural events is one reconciliation.
    document.emitter.emit("did-change", { affectsSource: true });
    document.emitter.emit("did-change", { affectsSource: true });
    document.emitter.emit("did-reload");
    await flushFrame();
    expect(bridge.updates.length).toBe(2);

    document.emitter.emit("did-save");
    expect(bridge.saves).toBe(1);

    // A path change is a dispose and a fresh open under the new URI.
    document.filePath = "C:\\proj\\renamed.ipynb";
    document.emitter.emit("did-change-path", document.filePath);
    expect(bridge.disposed).toBe(true);
    expect(client.opened.length).toBe(2);
    expect(client.opened[1].descriptor.filePath).toBe("C:\\proj\\renamed.ipynb");

    document.emitter.emit("did-destroy");
    expect(client.opened[1].disposed).toBe(true);
  });

  it("reveals a cell through the notebook editor for server-initiated shows", () => {
    const cells = [
      { id: "m1", type: "markdown", source: "" },
      { id: "c1", type: "code", source: "x\n" },
    ];
    const document = fakeDocument({ filePath: "C:\\proj\\nb.ipynb", cells });
    const host = fakeHost([document]);
    const revealed = [];
    host.getNotebookEditors = () => [
      {
        getCellEditorById: () => null,
        onDidChangeCellEditors: () => ({ dispose() {} }),
        revealCell: (index, position) => revealed.push({ index, position }),
      },
    ];
    const client = fakeClient();
    manager = new LspBridgeManager(client, host);

    client.opened[0].descriptor.show({
      cellId: "c1",
      range: [
        [2, 4],
        [2, 9],
      ],
    });
    expect(revealed).toEqual([{ index: 1, position: { row: 2, column: 4 } }]);
  });

  it("borrows a sibling's grammar scope for a cell whose editor is not built", () => {
    const cells = [
      { id: "c1", type: "code", source: "a\n" },
      { id: "c2", type: "code", source: "b\n" },
    ];
    const document = fakeDocument({ filePath: "C:\\proj\\nb.ipynb", cells });
    const host = fakeHost([document]);
    const editorForC1 = { getGrammar: () => ({ scopeName: "source.python.ipy" }) };
    host.getNotebookEditors = () => [
      {
        getCellEditorById: (id) => (id === "c1" ? editorForC1 : null),
        onDidChangeCellEditors: () => ({ dispose() {} }),
      },
    ];
    const client = fakeClient();
    manager = new LspBridgeManager(client, host);

    const described = client.opened[0].descriptor.cells;
    expect(described[0].scopeName).toBe("source.python.ipy");
    expect(described[1].scopeName).toBe("source.python.ipy");
    expect(described[1].editors).toEqual([]);
    expect(described[1].text).toBe("b\n");
  });
});

describe("the ide-client service consumption", () => {
  afterEach(() => {
    main.teardownLspBridge();
    main.ideClient = null;
    lumine.config.unset("jupyter-view.lsp.enabled");
  });

  it("bridges while the service is present and stands down when it goes", () => {
    const disposable = main.consumeIdeClient(fakeClient());
    expect(main.lspBridgeManager).toBeDefined();
    disposable.dispose();
    expect(main.lspBridgeManager).toBeNull();
  });

  it("honours the lsp.enabled setting as the off switch", () => {
    lumine.config.set("jupyter-view.lsp.enabled", false);
    const disposable = main.consumeIdeClient(fakeClient());
    expect(main.lspBridgeManager || null).toBeNull();
    // Flipping it back on connects with the stashed service; the config
    // observer wiring itself lives in activate().
    lumine.config.set("jupyter-view.lsp.enabled", true);
    main.setupLspBridge();
    expect(main.lspBridgeManager).toBeDefined();
    disposable.dispose();
  });

  it("opens a cell location by revealing the addressed cell", async () => {
    const item = {
      revealCell: jasmine.createSpy("revealCell"),
      document: { cells: [{ id: "a" }, { id: "b" }] },
    };
    spyOn(main, "openNotebook").and.returnValue(Promise.resolve(item));

    await main.openCell(
      { notebookPath: "C:\\proj\\nb.ipynb", cellId: "b" },
      { initialLine: 3, initialColumn: 1 },
    );

    expect(main.openNotebook).toHaveBeenCalledWith("C:\\proj\\nb.ipynb");
    expect(item.revealCell).toHaveBeenCalledWith(1, { row: 3, column: 1 });
  });
});
