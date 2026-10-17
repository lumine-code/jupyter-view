describe("Jupyter View initialization cleanup", () => {
  it("releases bootstrap registries when unloaded before activation", async () => {
    const pack = lumine.packages.loadPackage("jupyter-view");
    pack.requireMainModule();
    pack.initializeForExternalUse("document restoration");
    const { documentRegistry, linterEditors, autocompleteWatch } = pack.mainModule;
    expect(pack.mainInitialized).toBe(true);
    expect(pack.mainActivated).toBe(false);
    spyOn(console, "error");

    await lumine.packages.unloadPackage("jupyter-view", { serialize: false });

    expect(documentRegistry._destroyed).toBe(true);
    expect(linterEditors.disposed).toBe(true);
    expect(autocompleteWatch.disposed).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });
});
