const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("notebook rendered HTML export", () => {
  let main, editor, directory;

  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    for (const name of ["language-json", "language-python", "language-gfm", "language-text"])
      await (
        await lumine.packages.activatePackage(name)
      ).resourceLoadPromise;
    const pack = await lumine.packages.activatePackage("jupyter-view");
    main = pack.mainModule;
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notebook-rendered-owned-")));
    editor = await main.newNotebook();
    await editor._sourceEditorSetupPromise;
  });

  afterEach(async () => {
    editor?.destroy();
    await lumine.packages.deactivatePackage("jupyter-view");
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync(os.tmpdir()), directory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Unsafe notebook HTML export scratch");
    fs.rmSync(directory, { recursive: true, force: true });
    main = editor = directory = null;
  });

  async function exportHtml() {
    const destination = path.join(directory, "notebook.html");
    spyOn(lumine.window, "showSaveDialog").and.resolveTo({ filePath: destination });
    await editor.exportToHtml();
    return new DOMParser().parseFromString(fs.readFileSync(destination, "utf8"), "text/html");
  }

  it("renders markdown headings and emphasis in the accepted HTML file", async () => {
    editor.document.changeCellType(0, "markdown");
    editor.document.updateCellSource(0, "# Notebook heading\n\nA **strong** paragraph.", editor);
    const exported = await exportHtml();
    const markdown = exported.querySelector(".cell-markdown");
    expect(markdown.querySelector("h1")?.textContent).toBe("Notebook heading");
    expect(markdown.querySelector("strong")?.textContent).toBe("strong");
    expect(markdown.querySelector("p")?.textContent).toBe("A strong paragraph.");
  });

  it("preserves literal code and stream text while exporting ordinary code cells", async () => {
    const source = "print('<owned>&')";
    editor.document.updateCellSource(0, source, editor);
    editor.document.getCell(0).addOutput({
      output_type: "stream",
      name: "stdout",
      text: "<owned>&\n",
    });
    const exported = await exportHtml();
    expect(exported.querySelector(".cell-code").textContent).toBe(source);
    expect(exported.querySelector(".cell-output pre").textContent).toBe("<owned>&\n");
    expect(exported.querySelector("owned")).toBeNull();
  });

  it("keeps cancellation free of destination writes", async () => {
    spyOn(lumine.window, "showSaveDialog").and.resolveTo({ canceled: true });
    await editor.exportToHtml();
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
