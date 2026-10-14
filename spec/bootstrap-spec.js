const path = require("node:path");
const { Emitter } = require("lumine");

const packagePath = path.join(__dirname, "..");
function isLoaded(name) {
  return Object.values(require.cache).some(
    (entry) =>
      typeof entry?.filename === "string" &&
      entry.filename.startsWith(packagePath) &&
      entry.filename.endsWith(name),
  );
}

describe("notebook service bootstrap", () => {
  let pack, events;

  beforeEach(async () => {
    if (lumine.packages.isPackageLoaded("jupyter-view")) {
      await lumine.packages.unloadPackage("jupyter-view");
    }
    pack = await lumine.packages.startPackage(packagePath);
    events = new Emitter();
  });

  afterEach(async () => {
    if (lumine.packages.isPackageLoaded("jupyter-view")) {
      await lumine.packages.unloadPackage("jupyter-view");
    }
    events?.dispose();
  });

  it("publishes callable services and observes source changes before loading requests", async () => {
    const main = pack.mainModule;
    const service = main.provideJupyterNotebook();
    const tools = main.provideMcpTools();
    const list = tools.find((tool) => tool.name === "ListJupyterNotebooks").execute;
    expect(list).toBe(service.listNotebooks);
    expect(isLoaded("notebook-control-requests.js")).toBe(false);

    const changes = [];
    const subscription = service.onDidChangeNotebook((change) => changes.push(change));
    let destroyed = false;
    const document = {
      id: "bootstrap-document",
      filePath: null,
      cells: [],
      metadata: {},
      modified: true,
      isDestroyed: () => destroyed,
      getFileState: () => "ready",
      destroy() {
        if (destroyed) return;
        destroyed = true;
        events.emit("destroy");
      },
    };
    for (const [method, event] of [
      ["onDidChange", "change"],
      ["onDidLoad", "load"],
      ["onDidReload", "reload"],
      ["onDidSave", "save"],
      ["onDidChangePath", "path"],
      ["onDidChangeFileState", "file-state"],
      ["onDidDestroy", "destroy"],
    ]) {
      document[method] = (callback) => events.on(event, callback);
    }
    main.getDocumentRegistry()._registerDocument(document);
    events.emit("change", { category: "history", reason: "edit", cellIds: ["cell"] });
    expect(changes.length).toBe(1);
    expect(changes[0].kind).toBe("edit");
    expect(changes[0].revision).toMatch(/:source:1$/);
    expect(isLoaded("notebook-control-requests.js")).toBe(false);

    const result = list();
    expect(result.notebooks[0].revision).toBe(changes[0].revision);
    expect(isLoaded("notebook-control-requests.js")).toBe(true);
    document.destroy();
    expect(changes.at(-1).closed).toBe(true);
    await lumine.packages.unloadPackage("jupyter-view");
    expect(() => list()).toThrowError(/unloaded/);
    pack = await lumine.packages.startPackage(packagePath);
    expect(pack.mainModule.provideJupyterNotebook().listNotebooks().generation).not.toBe(
      result.generation,
    );
    subscription.dispose();
  });

  it("subscribes to notebook discovery while keeping the per-document LSP graph cold", () => {
    const main = pack.mainModule;
    const edge = main.consumeIde({ openNotebookDocument: jasmine.createSpy("open") });
    expect(main.lspBridgeManager).toBeTruthy();
    expect(isLoaded("notebook-lsp-bridge.js")).toBe(false);
    main.lspBridgeManager.attach({
      filePath: null,
      cells: [],
      onDidChange: (callback) => events.on("change", callback),
      onDidDestroy: (callback) => events.on("destroy", callback),
    });
    expect(isLoaded("notebook-lsp-bridge.js")).toBe(true);
    expect(main.lspBridgeManager.bridges.size).toBe(1);
    edge.dispose();
    expect(main.lspBridgeManager).toBeNull();
  });
});
