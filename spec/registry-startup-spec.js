const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

describe("the notebook document registry bootstrap", () => {
  it("keeps document models and views unloaded until a notebook is requested", async () => {
    const filename = path.join(__dirname, "../lib/notebook-document-registry.js");
    const isolatedModule = { exports: {} };
    const requested = [];
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
      module: isolatedModule,
      require: (request) => {
        requested.push(request);
        if (request !== "lumine") throw new Error(`Unexpected module: ${request}`);
        return require("lumine");
      },
    });
    const Registry = isolatedModule.exports;
    const registry = new Registry({
      saved: { filePath: "/notebook.ipynb", notebookData: { cells: [] } },
    });
    const observed = jasmine.createSpy();
    const subscription = registry.observeDocuments(observed);
    const reservation = registry.reserveDocumentView({ documentId: "saved" });
    expect(registry.getDocuments()).toEqual([]);
    expect(registry.serializedDocuments.size).toBe(1);
    expect(await registry.whenDocumentReady("saved")).toBeNull();
    expect(registry.serialize()).toEqual({});
    expect(observed).not.toHaveBeenCalled();
    reservation.dispose();
    subscription.dispose();
    registry.destroy();
    registry.destroy();
    expect(requested).toEqual(["lumine"]);
  });
});

describe("the notebook execution service bootstrap", () => {
  let service, requested, Editor, ExecutionAdapter;

  beforeEach(() => {
    Editor = class JupyterNotebookEditor {
      getCellEditor() {}
    };
    ExecutionAdapter = class {
      constructor(editor) {
        this.editor = editor;
      }
    };
    requested = [];
    const isolatedModule = { exports: {} };
    const isolatedRequire = (request) => {
      requested.push(request);
      if (request === "./jupyter-notebook-editor") return Editor;
      if (request === "./notebook-execution-adapter") return ExecutionAdapter;
      throw new Error(`Unexpected module: ${request}`);
    };
    isolatedRequire.resolve = (request) => request;
    isolatedRequire.cache = { "./jupyter-notebook-editor": { exports: Editor } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../lib/jupyter-adapter.js"), "utf8"), {
      module: isolatedModule,
      lumine: { workspace: { getCenter: () => ({ getActivePaneItem: () => null }) } },
      require: isolatedRequire,
    });
    service = new isolatedModule.exports();
  });

  it("rejects ordinary items without loading notebook models or execution", () => {
    expect(service.handlesItem(null)).toBe(false);
    expect(service.handlesItem({ getBuffer() {} })).toBe(false);
    expect(service.handlesItem({ getCellEditor() {} })).toBe(false);
    expect(service.getAdapterForItem({ getPath: () => "/source.py" })).toBeNull();
    expect(service.getActiveAdapter()).toBeNull();
    expect(requested).toEqual([]);
  });

  it("keeps notebook and subclass handling synchronous", () => {
    const notebook = new Editor();
    const Split = class extends Editor {};
    const split = new Split();
    expect(service.handlesItem(notebook)).toBe(true);
    expect(requested).toEqual([]);
    expect(service.handlesItem(split)).toBe(true);
    expect(requested).toEqual([]);
    const adapter = service.getAdapterForItem(notebook);
    expect(adapter).toBeInstanceOf(ExecutionAdapter);
    expect(adapter.editor).toBe(notebook);
    expect(requested).toEqual(["./notebook-execution-adapter"]);
  });
});
