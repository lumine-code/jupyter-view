const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

describe("notebook pane copies", () => {
  let editor, items, main;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    for (const name of ["language-json", "language-python", "language-gfm", "language-text"])
      await (
        await lumine.packages.activatePackage(name)
      ).resourceLoadPromise;
    main = (await lumine.packages.activatePackage("jupyter-view")).mainModule;
    editor = await main.newNotebook();
    await editor._sourceEditorSetupPromise;
    items = [editor];
  });

  afterEach(() => {
    for (const item of items) if (!item._destroyed) item.destroy();
  });

  it("copies current cell edits and selection without deferred focus changes", async () => {
    const document = editor.document;
    document.insertCell(1);
    await frame();
    editor.activeCellIndex = 1;
    editor.updateView();
    await frame();
    editor.view.selectedCells = new Set([0, 1]);
    const source = editor.view.cellViews.get(document.cells[1].id).editor;
    source.setText("current unsaved text");
    source.setCursorBufferPosition([0, 4]);
    editor.view.setMode("command");
    const copy = editor.copy();
    items.push(copy);
    const other = window.document.createElement("button");
    jasmine.attachToDOM(other);
    other.focus();
    await copy._sourceEditorSetupPromise;
    for (let index = 0; index < 5; index++) await frame();
    expect(window.document.activeElement).toBe(other);
    expect(copy.document).toBe(document);
    expect(copy.getElement()).not.toBe(editor.getElement());
    expect(copy.activeCellIndex).toBe(1);
    expect([...copy.view.selectedCells]).toEqual([0, 1]);
    const copiedSource = copy.view.cellViews.get(document.cells[1].id).editor;
    expect(copiedSource).not.toBe(source);
    expect(copiedSource.getText()).toBe("current unsaved text");
    expect(copiedSource.getCursorBufferPosition().column).toBe(4);
    editor.destroy();
    expect(document.isDestroyed()).toBe(false);
    expect(copy.document).toBe(document);
  });

  it("cancels a copy waiting for document hydration without creating another editor", async () => {
    const Editor = require("../lib/jupyter-notebook-editor");
    let resolveDocument;
    const loading = new Promise((resolve) => {
      resolveDocument = resolve;
    });
    const placeholder = Editor.deserialize(
      { documentId: "pending-copy" },
      {
        documentRegistry: {
          reserveDocumentView: () => ({ dispose() {} }),
          getOrCreateDocumentById: () => loading,
        },
      },
    );
    items.push(placeholder);
    const controller = new AbortController();
    const copying = placeholder.copy({ signal: controller.signal });
    controller.abort();
    await expectAsync(copying).toBeRejected();
    resolveDocument(editor.document);
    await placeholder._loadingPromise;
    expect(placeholder.document).toBe(editor.document);
  });
});
