const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("jupyter-view workspace opening", () => {
  let main;

  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("jupyter-view")).mainModule;
  });

  it("keeps notebook viewing available when automatic opening is disabled", async () => {
    lumine.config.set("jupyter-view.notebook.useOpener", false);
    const choice = lumine.workspace
      .getAvailablePathOpeners("C:/project/notebook.ipynb")
      .find(({ id }) => id === "jupyter-view");
    expect(choice).toBeDefined();
    expect(choice.label).toBe("Jupyter View");
    expect(choice.isDefault).toBe(false);
    lumine.config.set("jupyter-view.notebook.useOpener", true);
    expect(
      lumine.workspace
        .getAvailablePathOpeners("C:/project/notebook.ipynb")
        .find(({ id }) => id === "jupyter-view").isDefault,
    ).toBe(true);
  });

  it("opens notebooks by default and keeps an explicitly chosen source editor separate", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jupyter-launcher-"));
    const filePath = path.join(directory, "notebook.ipynb");
    fs.writeFileSync(
      filePath,
      JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }),
    );
    try {
      const notebook = await lumine.workspace.open(filePath);
      expect(notebook.constructor.name).toBe("JupyterNotebookEditor");
      expect(lumine.workspace.getAvailablePathOpeners(filePath)[0]).toEqual(
        jasmine.objectContaining({ id: "jupyter-view", isDefault: true }),
      );
      const editor = await lumine.workspace.open(filePath, { opener: "text-editor" });
      expect(lumine.workspace.isTextEditor(editor)).toBe(true);
      expect(await lumine.workspace.open(filePath, { opener: "text-editor" })).toBe(editor);
      lumine.config.set("jupyter-view.notebook.useOpener", false);
      expect(await lumine.workspace.open(filePath)).toBe(editor);
      expect(await lumine.workspace.open(filePath, { opener: "jupyter-view" })).toBe(notebook);
    } finally {
      for (const item of lumine.workspace.getPaneItems()) {
        if (item.getPath?.() === filePath)
          await lumine.workspace.paneForItem(item).destroyItem(item, true);
      }
      await lumine.fileWatchClient.settlePendingTeardown();
      fs.unlinkSync(filePath);
      fs.rmdirSync(directory);
    }
  });

  it("opens a new notebook through the workspace", async () => {
    const editor = {};
    spyOn(main, "getDocumentRegistry").and.returnValue({
      buildEditor: jasmine.createSpy("buildEditor").and.resolveTo(editor),
    });
    spyOn(main, "trackNotebookEditor");
    const open = spyOn(lumine.workspace, "open").and.resolveTo(editor);

    expect(await main.newNotebook()).toBe(editor);
    expect(open).toHaveBeenCalledWith(editor);
  });
});
