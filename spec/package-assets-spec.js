const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));

// Guards for the CSON -> JSON and Less -> CSS modernization and the jupyter.*
// service rebrand.
describe("jupyter-view package assets", () => {
  it("ships keymaps and menus as JSON, not CSON", () => {
    expect(exists("keymaps/main.json")).toBe(true);
    expect(exists("menus/main.json")).toBe(true);
    expect(exists("keymaps/jupyter-next.cson")).toBe(false);
    expect(exists("menus/jupyter-next.cson")).toBe(false);
  });

  it("parses the keymap and menu, and every menu entry uses `command`", () => {
    // The editor loads keymaps through season, which tolerates comments, so
    // JSON.parse alone is the wrong reader.
    const keymap = JSON.parse(read("keymaps/main.json").replace(/^\s*\/\/.*$/gm, ""));
    expect(keymap[".jupyter-notebook"]).toBeDefined();
    // alt-j is the Jupyter family's chord prefix. ctrl-shift-n is core's
    // application:new-window and this binding, being deeper, took it.
    expect(keymap["lumine-workspace"]["alt-j n"]).toBe("jupyter-view:new-notebook");
    // The run bindings are this package's own commands, which route through
    // jupyter-repl's execution service and its adapter integration.
    expect(keymap[".jupyter-notebook"]["ctrl-enter"]).toBe("jupyter-view:run-cell");
    expect(keymap[".jupyter-notebook"]["shift-enter"]).toBe("jupyter-view:run-cell-and-move-down");

    const menu = JSON.parse(read("menus/main.json"));
    expect(Array.isArray(menu.menu)).toBe(true);
    expect(JSON.stringify(menu)).not.toContain('"commands"');
  });

  it("leaves notebook source grammar ownership to language-json", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.files).not.toContain("grammars");
    expect(exists("grammars/jupyter.json")).toBe(false);
  });

  it("ships a CSS stylesheet built on custom properties, not Less", () => {
    expect(exists("styles/main.css")).toBe(true);
    expect(exists("styles/jupyter-next.less")).toBe(false);
    const css = read("styles/main.css");
    expect(css).toContain("var(--");
    expect(css).not.toContain('@import "ui-variables"');
    const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(cssWithoutComments).not.toMatch(/\bfade\(|\baverage\(|\blighten\(/);
  });

  it("provides the jupyter.* services and keeps keywords clear of the name", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("jupyter-view");
    expect(pkg.providedServices["jupyter.adapter"]).toBeDefined();
    expect(pkg.providedServices["jupyter.notebook"]).toBeDefined();
    expect(pkg.providedServices["hydrogen-adapter"]).toBeUndefined();
    expect(pkg.providedServices["jupyter"]).toBeUndefined();
    // "jupyter" is a substring of the package name, so it is not a keyword.
    expect(pkg.keywords).not.toContain("jupyter");
  });
});
