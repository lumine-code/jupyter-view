const path = require("node:path");
const { createRequire } = require("node:module");
const { Disposable } = require("lumine");

describe("Notebook registration helper ownership", () => {
  afterEach(async () => {
    if (lumine.packages.isPackageLoaded("jupyter-view"))
      await lumine.packages.unloadPackage("jupyter-view");
  });

  it("shares cold helper objects with synchronous initialization and replaces them on reload", async () => {
    const packagePath = lumine.packages.resolvePackagePath("jupyter-view");
    if (lumine.packages.isPackageLoaded("jupyter-view"))
      await lumine.packages.unloadPackage("jupyter-view");
    const firstRequire = createRequire(path.join(packagePath, "package.json"));
    const linter = firstRequire("./lib/linter-editors");
    const autocomplete = firstRequire("./lib/autocomplete-watch");
    const Registry = firstRequire("./lib/notebook-document-registry");
    expect(linter).toBe(Registry.linterEditors);
    expect(autocomplete).toBe(Registry.autocompleteWatch);
    expect(Object.keys(Registry)).toEqual([]);
    const createLinter = spyOn(linter, "createLinterEditors").and.callThrough();
    const createWatch = spyOn(autocomplete, "createAutocompleteWatch").and.callThrough();
    const pack = await lumine.packages.activatePackage("jupyter-view");
    expect(createLinter).toHaveBeenCalledTimes(1);
    expect(createWatch).toHaveBeenCalledTimes(1);
    const editor = { onDidDestroy: () => new Disposable() };
    const register = jasmine.createSpy("register editor").and.returnValue(new Disposable());
    const watch = jasmine.createSpy("watch editor").and.returnValue(new Disposable());
    const linterEdge = pack.mainModule.consumeLinterEditors(register);
    const watchEdge = pack.mainModule.consumeAutocompleteWatchEditor(watch);
    const added = linter.addLinterEditor(editor, { lint: false });
    const watched = autocomplete.watchCellEditor(editor);
    expect(register).toHaveBeenCalledOnceWith(editor, { lint: false });
    expect(watch).toHaveBeenCalledOnceWith(editor, ["default", "workspace-center"]);
    added.dispose();
    watched.dispose();
    linterEdge.dispose();
    watchEdge.dispose();
    await lumine.packages.unloadPackage("jupyter-view");
    const current = await lumine.packages.activatePackage("jupyter-view");
    const currentRequire = createRequire(path.join(current.path, "package.json"));
    const CurrentRegistry = currentRequire("./lib/notebook-document-registry");
    expect(currentRequire("./lib/linter-editors")).toBe(CurrentRegistry.linterEditors);
    expect(currentRequire("./lib/autocomplete-watch")).toBe(CurrentRegistry.autocompleteWatch);
    expect(CurrentRegistry).not.toBe(Registry);
    expect(CurrentRegistry.linterEditors.LinterEditors).not.toBe(linter.LinterEditors);
    expect(CurrentRegistry.autocompleteWatch.AutocompleteWatch).not.toBe(
      autocomplete.AutocompleteWatch,
    );
  });
});
