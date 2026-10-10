const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("notebook exports with pending native input", () => {
  let notebook, main, directory, input;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    for (const name of ["language-json", "language-python", "language-gfm", "language-text"])
      await (
        await lumine.packages.activatePackage(name)
      ).resourceLoadPromise;
    const pack = await lumine.packages.activatePackage("jupyter-view");
    main = pack.mainModule;
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "notebook-export-")));
    jasmine.attachToDOM(lumine.workspace.getElement());
    notebook = await main.newNotebook();
    await notebook._sourceEditorSetupPromise;
    require(path.join(pack.path, "node_modules/@lumine-code/etch")).updateSync(notebook.view);
    input = notebook.view.cellViews.get(notebook.document.cells[0].id).editor;
    expect(input).toBeDefined();
  });

  afterEach(async () => {
    notebook?.destroy();
    if (lumine.packages.isPackageActive("jupyter-view"))
      await lumine.packages.deactivatePackage("jupyter-view");
    if (lumine.packages.isPackageLoaded("jupyter-view"))
      await lumine.packages.unloadPackage("jupyter-view");
    await lumine.fileWatchClient.settlePendingTeardown();
    if (directory) {
      const temporary = fs.realpathSync.native(os.tmpdir());
      const target = fs.realpathSync.native(directory);
      const relative = path.relative(temporary, target);
      if (
        !relative ||
        path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`)
      )
        throw new Error("Notebook export cleanup escaped its private temporary directory.");
      fs.rmSync(target, { recursive: true, force: true });
    }
    notebook = main = input = directory = null;
  });

  async function exportCommand(kind) {
    const method = kind === "python" ? "exportToPython" : "exportToHtml";
    const destination = path.join(directory, kind === "python" ? "owned.py" : "owned.html");
    spyOn(lumine.window, "showSaveDialog").and.resolveTo({ filePath: destination });
    spyOn(notebook, method).and.callThrough();
    lumine.commands.dispatch(notebook.getElement(), `jupyter-view:export-to-${kind}`);
    expect(notebook[method]).toHaveBeenCalledTimes(1);
    await notebook[method].calls.mostRecent().returnValue;
    return fs.readFileSync(destination, "utf8");
  }

  it("exports the current native input to Python before the source debounce settles", async () => {
    input.setText("print('latest python input')");
    expect(notebook.document.cells[0].source).toBe("");
    expect(await exportCommand("python")).toContain("print('latest python input')");
  });

  it("exports the current native input to HTML before the source debounce settles", async () => {
    input.setText("print('<latest>&')");
    expect(notebook.document.cells[0].source).toBe("");
    const document = new DOMParser().parseFromString(await exportCommand("html"), "text/html");
    expect(document.querySelector(".cell-code").textContent).toBe("print('<latest>&')");
  });

  it("preserves an ordinary already-synchronized Python export", async () => {
    input.setText("print('synchronized input')");
    notebook.flushPendingCellSourceChanges();
    expect(notebook.document.cells[0].source).toBe("print('synchronized input')");
    expect(await exportCommand("python")).toContain("print('synchronized input')");
  });
});
