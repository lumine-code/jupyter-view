/* global conditionPromise */
describe("notebook Markdown spelling", () => {
  let editor, document_, main, spelling, hub;
  const messages = () =>
    hub.getMessages().filter((message) => message.linterName === "Spell Check");
  const cellEditor = () => editor.getCellEditorById(document_.cells[1].id);
  const words = () =>
    messages().map((message) => message.location.buffer.getTextInRange(message.location.position));

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const name of ["language-gfm", "language-json", "language-python", "language-text"])
      await lumine.packages.activatePackage(name);
    lumine.config.unset("spell-check.grammars");
    lumine.config.unset("spell-check.excludedScopes");
    lumine.config.set("spell-check.useSystem", false);
    lumine.config.set("spell-check.useLocales", true);
    lumine.config.set("spell-check.locales", ["en-US"]);
    lumine.config.set("spell-check.knownWords", []);
    lumine.config.set("linter.lintOnOpen", true);
    lumine.config.set("linter.lintOnChangeInterval", 10);
    const linter = (await lumine.packages.activatePackage("linter")).mainModule;
    hub = linter.provideLinterHub();
    spelling = (await lumine.packages.activatePackage("spell-check")).mainModule;
    main = (await lumine.packages.activatePackage("jupyter-view")).mainModule;
    const NotebookDocument = require("../lib/notebook-document");
    const NotebookEditor = require("../lib/jupyter-notebook-editor");
    document_ = new NotebookDocument(null);
    await document_.initialize();
    document_.updateCellSource(0, "pythonmistak = 1");
    document_.insertCell(1, "markdown");
    document_.updateCellSource(
      1,
      "# documnet\n\nprosemistak `inlinemistak`\n\n" +
        '[labelmistak](folder/pathmistak "titlemistak")\n\n' +
        "```python\nfencedmistak = 1\n```\n",
    );
    document_.insertCell(2, "raw");
    document_.updateCellSource(2, "rawmistak");
    editor = new NotebookEditor(document_);
    main.trackNotebookEditor(editor);
    await editor._sourceEditorSetupPromise;
    await lumine.workspace.open(editor);
    jasmine.attachToDOM(lumine.workspace.getElement());
    editor.setActiveCell(1);
    editor.view.setMode("edit");
    await conditionPromise(() => messages().length === 4, "Markdown spelling diagnostics");
  });

  afterEach(async () => {
    editor?.destroy();
    if (document_ && !document_.isDestroyed()) document_.destroy();
    for (const name of ["jupyter-view", "spell-check", "linter"])
      await lumine.packages.deactivatePackage(name);
  });

  it("automatically checks Markdown prose and projects diagnostics onto its cell", () => {
    expect(words()).toEqual(["documnet", "prosemistak", "labelmistak", "titlemistak"]);
    const [message] = messages();
    expect(editor.ownsLinterMessage(message)).toBe(true);
    expect(editor.getLinterMessageEditor(message)).toBe(cellEditor());
    expect(main.getLinterMarkerLocations(message)).toEqual([
      { buffer: cellEditor().getBuffer(), cell: 2 },
    ]);
    cellEditor().setCursorBufferPosition([0, 4], { autoscroll: false });
    expect(editor.getCurrentLinterMessage(messages())).toBe(message);
    expect(editor.getNextLinterMessage(messages())).toBe(messages()[1]);
    cellEditor().setCursorBufferPosition([2, 0], { autoscroll: false });
    expect(editor.getPreviousLinterMessage(messages())).toBe(message);
  });

  it("reveals a spelling diagnostic at its Markdown position", async () => {
    const message = messages()[1];
    await editor.revealCell(1, message.location.position.start);
    await conditionPromise(
      () => cellEditor().getCursorBufferPosition().isEqual(message.location.position.start),
      "Markdown diagnostic position revealed",
    );
  });

  it("offers corrections in the Markdown editor and removes corrected diagnostics", async () => {
    const suggestions = spelling.provideAutocomplete().getSuggestions({
      editor: cellEditor(),
      bufferPosition: [0, 4],
      activatedManually: true,
    });
    expect(suggestions.map((suggestion) => suggestion.text)).toContain("document");
    const correction = spelling
      .provideIntentionsList()
      .getIntentions({
        textEditor: cellEditor(),
        bufferPosition: [0, 4],
      })
      .find((intention) => intention.title === "document");
    expect(correction).toBeDefined();
    correction.selected();
    expect(cellEditor().lineTextForBufferRow(0)).toBe("# document");
    await conditionPromise(() => messages().length === 3, "corrected spelling diagnostic removed");
  });

  it("retires diagnostics on render and type changes and checks a recreated Markdown editor", async () => {
    const previous = cellEditor();
    editor.view.setMode("command");
    expect(previous.isDestroyed()).toBe(true);
    await conditionPromise(() => messages().length === 0, "rendered Markdown diagnostics retired");
    editor.view.setMode("edit");
    expect(cellEditor()).not.toBe(previous);
    await conditionPromise(
      () => messages().length === 4,
      "recreated Markdown spelling diagnostics",
    );

    editor.changeCellType("code");
    await conditionPromise(
      () => cellEditor()?.getGrammar().scopeName === "source.python" && messages().length === 0,
      "code cell keeps notebook diagnostic ownership",
    );
    editor.changeCellType("raw");
    await conditionPromise(
      () => cellEditor()?.getGrammar().scopeName === "text.plain" && messages().length === 0,
      "raw cell keeps notebook diagnostic ownership",
    );
    editor.changeCellType("markdown");
    await conditionPromise(() => messages().length === 4, "Markdown spelling restored");
  });
});
