const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("notebook export destinations", () => {
  let main, directory, editors;
  beforeEach(async () => {
    for (const method of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    for (const name of ["language-json", "language-python", "language-gfm", "language-text"])
      await (
        await lumine.packages.activatePackage(name)
      ).resourceLoadPromise;
    main = (await lumine.packages.activatePackage("jupyter-view")).mainModule;
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notebook-export-owned-")));
    editors = [];
  });
  afterEach(async () => {
    for (const editor of editors) editor.destroy();
    await lumine.packages.deactivatePackage("jupyter-view");
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync(os.tmpdir()), directory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Unsafe notebook export scratch");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function open(file) {
    const source = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 0,
      metadata: {},
      cells: [
        {
          id: "owned",
          cell_type: "code",
          source: ["print('owned')"],
          outputs: [],
          metadata: {},
          execution_count: null,
        },
      ],
    });
    fs.writeFileSync(file, source);
    const editor = await main.openNotebook(file);
    editors.push(editor);
    await editor._sourceEditorSetupPromise;
    return { editor, source };
  }
  const formats = [
    ["exportToPython", ".py"],
    ["exportToHtml", ".html"],
  ];
  it("suggests a different sibling output for an uppercase notebook extension", async () => {
    const file = path.join(directory, "notebook.IPYNB");
    const { editor, source } = await open(file);
    const defaults = [];
    let index = 0;
    spyOn(lumine.window, "showSaveDialog").and.callFake((options) => {
      defaults.push(options.defaultPath);
      // Always choose the safe sibling, even when the original suggestion is
      // wrong. This proves the default without overwriting the source fixture.
      return Promise.resolve({ filePath: path.join(directory, "notebook" + formats[index++][1]) });
    });
    for (const [method, extension] of formats) {
      await editor[method]();
      expect(defaults.at(-1)).toBe(path.join(directory, "notebook" + extension));
      expect(fs.existsSync(path.join(directory, "notebook" + extension))).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toBe(source);
    }
  });
  it("replaces only the filename suffix when a parent directory contains ipynb", async () => {
    const folder = path.join(directory, "catalog.ipynb.examples");
    fs.mkdirSync(folder);
    const file = path.join(folder, "notebook.ipynb");
    const { editor, source } = await open(file);
    let index = 0;
    const defaults = [];
    spyOn(lumine.window, "showSaveDialog").and.callFake((options) => {
      defaults.push(options.defaultPath);
      return Promise.resolve({ filePath: path.join(folder, "notebook" + formats[index++][1]) });
    });
    for (const [method, extension] of formats) {
      await editor[method]();
      expect(defaults.at(-1)).toBe(path.join(folder, "notebook" + extension));
      expect(fs.readFileSync(file, "utf8")).toBe(source);
    }
  });
  it("exports the literal notebook filename in HTML title and heading", async () => {
    const file = path.join(directory, "notes&copy;.ipynb");
    const { editor } = await open(file);
    const output = path.join(directory, "literal.html");
    spyOn(lumine.window, "showSaveDialog").and.resolveTo({ filePath: output });
    await editor.exportToHtml();
    const exported = new DOMParser().parseFromString(fs.readFileSync(output, "utf8"), "text/html");
    expect(exported.querySelector("title").textContent).toBe(path.basename(file));
    expect(exported.querySelector("h1").textContent).toBe(path.basename(file));
  });
});
