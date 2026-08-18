const fs = require("fs");
const path = require("path");

// Every notebook command was registered on `lumine-workspace`. That listed all
// forty in the command palette from anywhere, and let each one act on whichever
// notebook happened to be the active centre item, however far focus had moved
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
    // The package activates on core:loaded-shell-environment, which no spec
    // window ever reaches on its own.
    lumine.packages.triggerDeferredActivationHooks();
    lumine.packages.triggerActivationHook("core:loaded-shell-environment");
    await lumine.packages.activatePackage("jupyter-view");
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
