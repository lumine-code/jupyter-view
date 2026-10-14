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
