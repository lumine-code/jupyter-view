describe("jupyter-view Launcher provider", () => {
  let main, provider, consumer, items;

  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("jupyter-view")).mainModule;
    items = [];
    consumer = lumine.packages.serviceHub.consume("launcher.provider", "^1.0.0", (value) => {
      if (value.id === "jupyter-view") provider = value;
    });
  });

  afterEach(() => {
    consumer.dispose();
    for (const item of items) item.destroy();
  });

  it("publishes a synchronous provider that creates fresh unattached notebooks", async () => {
    expect(provider).toEqual(
      jasmine.objectContaining({ id: "jupyter-view", label: "Jupyter Notebook" }),
    );
    const open = spyOn(lumine.workspace, "open").and.callThrough();
    const pane = lumine.workspace.getCenter().getActivePane();
    const activeItem = pane.getActiveItem();
    const first = await provider.create({ pane });
    const second = await provider.create({ pane });
    items.push(first, second);
    await Promise.all([first._sourceEditorSetupPromise, second._sourceEditorSetupPromise]);

    expect(first.constructor.name).toBe("JupyterNotebookEditor");
    expect(first._destroyed).toBe(false);
    expect(first.getPath()).toBeFalsy();
    expect(first.document).not.toBe(second.document);
    expect(first.getFileState()).toBe("unmodified");
    expect(second.getFileState()).toBe("unmodified");
    expect(main.notebookEditors.has(first)).toBe(true);
    expect(lumine.workspace.paneForItem(first)).toBeFalsy();
    expect(lumine.workspace.paneForItem(second)).toBeFalsy();
    expect(pane.getActiveItem()).toBe(activeItem);
    expect(open).not.toHaveBeenCalled();
  });

  it("opens a clean notebook through the package command", async () => {
    const editor = await main.newNotebook();
    items.push(editor);
    await editor._sourceEditorSetupPromise;

    expect(lumine.workspace.getActivePaneItem()).toBe(editor);
    expect(editor.getFileState()).toBe("unmodified");
    expect(editor.document.isModified()).toBe(false);
    expect(editor.shouldPromptToSave({ lastView: true })).toBe(false);
  });

  it("shares notebook creation with the package command", async () => {
    const editor = await provider.create();
    items.push(editor);
    const create = spyOn(main, "createNotebook").and.resolveTo(editor);
    const open = spyOn(lumine.workspace, "open").and.resolveTo(editor);

    expect(await main.newNotebook()).toBe(editor);
    expect(create).toHaveBeenCalledOnceWith();
    expect(open).toHaveBeenCalledOnceWith(editor);
  });

  it("does not allocate a notebook for an aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const build = spyOn(main.getDocumentRegistry(), "buildEditor").and.callThrough();

    await expectAsync(provider.create({ signal: controller.signal })).toBeRejected();
    expect(build).not.toHaveBeenCalled();
  });

  it("destroys the notebook when cancellation arrives during creation", async () => {
    const controller = new AbortController();
    const registry = main.getDocumentRegistry();
    const build = registry.buildEditor.bind(registry);
    let created;
    spyOn(registry, "buildEditor").and.callFake(async (...args) => {
      created = await build(...args);
      controller.abort();
      return created;
    });

    await expectAsync(provider.create({ signal: controller.signal })).toBeRejected();
    expect(created._destroyed).toBe(true);
    expect(main.notebookEditors.has(created)).toBe(false);
  });

  it("rejects a retained provider after the package generation retires", async () => {
    const retained = provider;
    await lumine.packages.deactivatePackage("jupyter-view");
    main = (await lumine.packages.activatePackage("jupyter-view")).mainModule;
    const build = spyOn(main.getDocumentRegistry(), "buildEditor").and.callThrough();

    await expectAsync(retained.create()).toBeRejectedWithError("Jupyter View is no longer active.");
    expect(build).not.toHaveBeenCalled();
  });
});
