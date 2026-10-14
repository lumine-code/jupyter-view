describe("notebook output selections across documents", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("jupyter-view");
  });
  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
    await lumine.packages.deactivatePackage("jupyter-view");
  });
  it("copies the selection from the output's document", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const document = extra.getDocument();
    const output = document.createElement("div");
    output.className = "jupyter-output-container";
    output.textContent = "auxiliary notebook selection";
    output.style.cssText = "position:fixed;left:0;top:0;width:400px;user-select:text";
    extra.getElement().appendChild(output);
    const range = document.createRange();
    range.selectNodeContents(output);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    expect(document.getSelection().toString()).toBe(output.textContent);
    const copy = spyOn(lumine.clipboard, "write");
    lumine.commands.dispatch(output, "core:copy");
    expect(copy).toHaveBeenCalledOnceWith("auxiliary notebook selection");
  });
});
