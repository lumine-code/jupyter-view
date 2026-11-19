const path = require("node:path");

async function waitFor(predicate, message, timeout = 5000) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("notebook navigation-panel integration", () => {
  let editor, notebook, navigation;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    for (const name of ["language-json", "language-python", "language-gfm", "language-text"]) {
      const grammarPackage = await lumine.packages.activatePackage(name);
      await grammarPackage.resourceLoadPromise;
    }
    await lumine.packages.deactivatePackage("navigation-panel");
    navigation = (await lumine.packages.activatePackage("navigation-panel")).mainModule;
    await lumine.packages.activatePackage(path.resolve(__dirname, ".."));
    const NotebookDocument = require("../lib/notebook-document");
    const JupyterNotebookEditor = require("../lib/jupyter-notebook-editor");
    notebook = new NotebookDocument();
    await notebook.initializeFromData({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { id: "chapter", cell_type: "markdown", source: "# Chapter", metadata: {} },
        { id: "detail", cell_type: "markdown", source: "## Detail", metadata: {} },
        {
          id: "body",
          cell_type: "markdown",
          source: Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n"),
          metadata: {},
        },
        { id: "last", cell_type: "markdown", source: "# Last section", metadata: {} },
      ],
    });
    editor = new JupyterNotebookEditor(notebook);
    editor.getElement().style.cssText = "position:absolute;width:800px;height:400px;top:0;left:0";
    await editor._sourceEditorSetupPromise;
    await lumine.workspace.open(editor);
    lumine.commands.dispatch(editor.getElement(), "navigation-panel:open");
    await waitFor(
      () =>
        navigation.provideNavigationHeaders().getEditor() === editor &&
        navigation.navigationTree?.element.querySelectorAll(".navigation-text").length === 3,
      "notebook outline in navigation-panel",
      10000,
    );
    await lumine.views.getNextUpdatePromise();
    await new Promise((resolve) => setImmediate(resolve));
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("navigation-panel");
    editor?.destroy();
    notebook?.destroy();
    editor = null;
    notebook = null;
    await lumine.fileWatchClient.settlePendingTeardown();
  });

  it("tracks the active and visible sections without rescanning or replacing panel rows", async () => {
    const service = navigation.provideNavigationHeaders();
    const tree = navigation.navigationTree;
    const headers = navigation.headers;
    const rows = [...tree.element.querySelectorAll(".navigation-block")];
    const scan = spyOn(require("../lib/notebook-headings"), "collectHeadings").and.callThrough();
    const build = spyOn(navigation.adapterManager, "buildHeaders").and.callThrough();
    const update = spyOn(tree, "update").and.callThrough();

    editor.setActiveCell(1);
    await waitFor(
      () =>
        service.getFlattenHeaders().find((header) => header.text === "Detail")?.currentCount === 1,
      "active notebook detail",
    );
    expect(navigation.headers[0].currentCount).toBe(0);
    expect(navigation.headers[0].stackCount).toBe(1);

    const container = editor.view.cellsContainer;
    container.scrollTop = container.scrollHeight;
    container.dispatchEvent(new Event("scroll"));
    await waitFor(
      () =>
        service.getFlattenHeaders().find((header) => header.text === "Last section")?.visibility ===
        1,
      "visible final notebook section",
    );
    expect(scan).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(navigation.headers).toBe(headers);
    expect([...tree.element.querySelectorAll(".navigation-block")]).toEqual(rows);
  }, 15000);

  it("replaces a changed outline completely and tracks the new nested paths", async () => {
    const service = navigation.provideNavigationHeaders();
    const previous = navigation.headers;
    notebook.updateCellSource(0, "# Renamed chapter\n## New detail");
    await waitFor(
      () =>
        service
          .getFlattenHeaders()
          .map((header) => header.text)
          .join("|") === "Renamed chapter|New detail|Detail|Last section",
      "updated notebook outline",
    );
    await waitFor(
      () => navigation.navigationTree.element.querySelectorAll(".navigation-text").length === 4,
      "updated notebook outline rows",
    );
    expect(navigation.headers).not.toBe(previous);
    const headers = navigation.headers;
    const build = spyOn(navigation.adapterManager, "buildHeaders").and.callThrough();
    editor.setActiveCell(1);
    await waitFor(
      () =>
        service.getFlattenHeaders().find((header) => header.text === "Detail")?.currentCount === 1,
      "active heading at the updated path",
    );
    expect(navigation.headers).toBe(headers);
    expect(headers[0].children[0].currentCount).toBe(0);
    expect(headers[0].children[1].currentCount).toBe(1);
    expect(headers[0].stackCount).toBe(1);
    expect(build).not.toHaveBeenCalled();
  }, 15000);
});
