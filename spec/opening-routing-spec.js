const main = require("../lib/main");

describe("jupyter-view workspace opening", () => {
  it("reopens an existing notebook source through the workspace", async () => {
    const sourcePath = "C:\\project\\notebook.ipynb";
    const editor = { getPath: () => sourcePath };
    spyOn(lumine.workspace, "getTextEditors").and.returnValue([editor]);
    const open = spyOn(lumine.workspace, "open").and.resolveTo(editor);

    expect(await main.openSource(sourcePath)).toBe(editor);
    expect(open).toHaveBeenCalledWith(editor);
  });

  it("opens a notebook selected in the tree through the workspace", async () => {
    const editor = {};
    spyOn(main, "getSelectedTreeViewNotebookPath").and.returnValue("notebook.ipynb");
    spyOn(main, "openNotebook").and.resolveTo(editor);
    const open = spyOn(lumine.workspace, "open").and.resolveTo(editor);

    expect(await main.openSelectedTreeViewNotebook()).toBe(editor);
    expect(open).toHaveBeenCalledWith(editor);
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
