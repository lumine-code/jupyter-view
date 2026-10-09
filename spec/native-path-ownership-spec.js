const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("notebook native path ownership", () => {
  let main, directory, editors;

  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    for (const name of ["language-json", "language-python", "language-text"])
      await (
        await lumine.packages.activatePackage(name)
      ).resourceLoadPromise;
    main = (await lumine.packages.activatePackage("jupyter-view")).mainModule;
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notebook-path-owned-")));
    editors = [];
  });

  afterEach(async () => {
    for (const editor of editors) editor.destroy();
    await lumine.packages.deactivatePackage("jupyter-view");
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync(os.tmpdir()), directory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Unsafe notebook path scratch");
    fs.rmSync(directory, { recursive: true, force: true });
    main = directory = editors = null;
  });

  function notebook(name, source) {
    const file = path.join(directory, name);
    fs.writeFileSync(
      file,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            id: "owned",
            cell_type: "code",
            source: [source],
            metadata: {},
            outputs: [],
            execution_count: null,
          },
        ],
      }),
    );
    return file;
  }

  async function open(file) {
    const editor = await main.openNotebook(file);
    editors.push(editor);
    await lumine.workspace.open(editor);
    await editor._sourceEditorSetupPromise;
    return editor;
  }

  if (process.platform === "linux")
    it("keeps case-distinct native files in separate documents", async () => {
      const upper = notebook("A.ipynb", "upper source");
      const lower = notebook("a.ipynb", "lower source");
      expect(fs.statSync(upper).ino).not.toBe(fs.statSync(lower).ino);
      const first = await open(upper);
      const second = await open(lower);
      expect(second.getPath()).toBe(lower);
      expect(second.document).not.toBe(first.document);
      expect(second.document.getCell(0).source).toBe("lower source");
    });

  it("keeps reopening the same literal path on one shared document", async () => {
    const file = notebook("same.ipynb", "owned source");
    const first = await open(file);
    const second = await open(file);
    expect(second.document).toBe(first.document);
    expect(second.document.getCell(0).source).toBe("owned source");
  });

  it("keeps the native case alias when this filesystem accepts it", async () => {
    const file = notebook("alias.ipynb", "alias source");
    const alias = path.join(directory, "ALIAS.IPYNB");
    const first = await open(file);
    if (!fs.existsSync(alias)) {
      expect(main.getDocumentRegistry().getDocument(file)).toBe(first.document);
      return;
    }
    expect(fs.statSync(alias).ino).toBe(fs.statSync(file).ino);
    const second = await open(alias);
    expect(second.document).toBe(first.document);
    expect(second.document.getCell(0).source).toBe("alias source");
  });
});
