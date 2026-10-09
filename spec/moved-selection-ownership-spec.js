describe("notebook moved cell selection ownership", () => {
  let editor;

  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    for (const name of ["language-json", "language-python", "language-text"])
      await (
        await lumine.packages.activatePackage(name)
      ).resourceLoadPromise;
    const pack = await lumine.packages.activatePackage("jupyter-view");
    editor = await pack.mainModule.getDocumentRegistry().buildEditorFromData({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: ["a", "b", "c", "d", "e"].map((id) => ({
        id,
        cell_type: "code",
        source: [id],
        metadata: {},
        outputs: [],
        execution_count: null,
      })),
    });
    await lumine.workspace.open(editor);
    await editor._sourceEditorSetupPromise;
    jasmine.attachToDOM(lumine.workspace.getElement());
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });

  afterEach(async () => {
    editor?.destroy();
    await lumine.packages.deactivatePackage("jupyter-view");
    editor = null;
  });

  async function move(indices, command, expectedOrder) {
    editor.setActiveCell(indices.at(-1));
    editor.view.replaceSelection(indices);
    const selectedIds = indices.map((index) => editor.document.cells[index].id);
    lumine.commands.dispatch(editor.getElement(), command);
    for (let frame = 0; frame < 2; frame++)
      await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(editor.document.cells.map((cell) => cell.id)).toEqual(expectedOrder);
    expect(editor.view.getSelectedCells().map((index) => editor.document.cells[index].id)).toEqual(
      selectedIds,
    );
    expect(
      Array.from(editor.view.element.querySelectorAll(".jupyter-cell.selected"), (element) =>
        element.getAttribute("data-cell-id"),
      ),
    ).toEqual(selectedIds);
  }

  it("keeps the two chosen cells selected after moving a disjoint selection up", async () => {
    await move([1, 3], "jupyter-view:move-cell-up", ["b", "d", "a", "c", "e"]);
  });

  it("keeps the two chosen cells selected after moving a disjoint selection down", async () => {
    await move([1, 3], "jupyter-view:move-cell-down", ["a", "c", "e", "b", "d"]);
  });

  it("keeps the ordinary contiguous selection when moving it up", async () => {
    await move([1, 2], "jupyter-view:move-cell-up", ["b", "c", "a", "d", "e"]);
  });
});
