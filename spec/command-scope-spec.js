const fs = require("fs");
const path = require("path");
const NotebookDocument = require("../lib/notebook-document");
const JupyterNotebookEditor = require("../lib/jupyter-notebook-editor");
const main = require("../lib/main");

async function buildNotebook() {
  const document_ = new NotebookDocument(null);
  await document_.initialize();
  const editor = new JupyterNotebookEditor(document_);
  await editor._sourceEditorSetupPromise;
  return editor;
}

function activatePackage() {
  // The package activates on core:loaded-shell-environment, which no spec
  // window ever reaches on its own.
  lumine.packages.triggerDeferredActivationHooks();
  lumine.packages.triggerActivationHook("core:loaded-shell-environment");
  return lumine.packages.activatePackage("jupyter-view");
}

// Every notebook command was registered on `lumine-workspace`. That listed all
// forty in the command palette from anywhere, and let each one act on whichever
// notebook happened to be the active center pane item, however far focus had moved
// from it — clear-output from the tree view cleared a cell you were not looking
// at. They belong on the notebook, and only what needs no notebook stays global.
describe("jupyter-view command scope", () => {
  let workspaceElement;

  const GLOBAL_COMMANDS = [
    "jupyter-view:new-notebook",
    "jupyter-view:open-source",
    "jupyter-view:toggle",
  ];

  const ownCommandsFor = (target) =>
    lumine.commands
      .findCommands({ target })
      .map((command) => command.name)
      .filter((name) => name.startsWith("jupyter-view:"))
      .sort();

  beforeEach(async () => {
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    await activatePackage();
  });

  it("reaches only the commands that need no notebook from the workspace", () => {
    expect(ownCommandsFor(workspaceElement)).toEqual(GLOBAL_COMMANDS);
  });

  it("reaches the notebook's own commands from inside a notebook", () => {
    const container = document.createElement("div");
    container.className = "jupyter-view jupyter-notebook-container";
    workspaceElement.appendChild(container);

    const names = ownCommandsFor(container);
    // The walk up does not stop at the container, so the global tier is
    // reachable from inside a notebook as well.
    for (const name of GLOBAL_COMMANDS) expect(names).toContain(name);
    for (const name of [
      "jupyter-view:clear-output",
      "jupyter-view:clear-all-outputs",
      "jupyter-view:run-cell",
      "jupyter-view:delete-cell",
      "jupyter-view:export-to-html",
      "jupyter-view:scroll-down",
    ]) {
      expect(names).toContain(name);
    }
  });

  // The application menu dispatches at whatever holds focus, not at the file
  // the command is about, so an item naming a notebook-scoped command would
  // silently do nothing whenever focus had left the notebook.
  it("names in the application menu only what dispatches from anywhere", () => {
    const menu = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "menus", "main.json")));
    const commands = [];
    const walk = (items) => {
      for (const item of items || []) {
        if (item.command) commands.push(item.command);
        walk(item.submenu);
      }
    };
    walk(menu.menu);

    const own = commands.filter((name) => name.startsWith("jupyter-view:"));
    expect(own.length).toBeGreaterThan(0);
    for (const name of own) expect(GLOBAL_COMMANDS).toContain(name);
  });
});

// Scoping the commands to the notebook is only half of it: the handlers used to
// ask the workspace which notebook to act on, and the workspace only ever
// answers with the center pane's item. A notebook in a dock, or in an inactive
// split, dispatched its own commands and had them land somewhere else.
describe("jupyter-view notebook resolution", () => {
  let workspaceElement;
  let dispatched;
  let active;

  beforeEach(async () => {
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    await activatePackage();

    dispatched = await buildNotebook();
    active = await buildNotebook();
    workspaceElement.appendChild(dispatched._containerElement);
    // Stands in for the notebook being anywhere the center pane is not.
    spyOn(main, "getActiveNotebook").and.returnValue(active);
  });

  afterEach(() => {
    for (const editor of [dispatched, active]) {
      const document_ = editor.document;
      // One case below fakes the destroyed flag rather than destroying. Clear
      // it so the real teardown still runs: the source editor each notebook
      // hands to linter-editors sits in a module-level registry, and a notebook
      // left undestroyed replays into every spec file that runs after this one.
      editor._destroyed = false;
      editor.destroy();
      if (document_ && document_.refCount <= 0) document_.destroy();
    }
  });

  it("acts on the notebook a command was dispatched at, not the active one", () => {
    const before = dispatched.document.getCellCount();
    const untouched = active.document.getCellCount();

    lumine.commands.dispatch(dispatched._containerElement, "jupyter-view:insert-cell-below");

    expect(dispatched.document.getCellCount()).toBe(before + 1);
    expect(active.document.getCellCount()).toBe(untouched);
  });

  it("finds the notebook from a descendant, which is where a keystroke lands", () => {
    const cellTarget = document.createElement("div");
    dispatched._containerElement.appendChild(cellTarget);
    const before = dispatched.document.getCellCount();

    lumine.commands.dispatch(cellTarget, "jupyter-view:insert-cell-above");

    expect(dispatched.document.getCellCount()).toBe(before + 1);
    expect(active.document.getCellCount()).toBe(before);
  });

  it("falls back to the active notebook when nothing names one", () => {
    const before = active.document.getCellCount();

    main.insertCellBelow();

    expect(active.document.getCellCount()).toBe(before + 1);
    expect(dispatched.document.getCellCount()).toBe(before);
  });

  it("does not hand a command to a destroyed notebook", () => {
    dispatched._destroyed = true;
    const before = active.document.getCellCount();

    lumine.commands.dispatch(dispatched._containerElement, "jupyter-view:insert-cell-below");

    expect(active.document.getCellCount()).toBe(before + 1);
  });
});
