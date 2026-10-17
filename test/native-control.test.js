"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { prepareNativeControl } = require("../script/prepare-native-control");

function checkout(t, name = "jupyter-view") {
  const base = fs.realpathSync.native(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(base, "notebook-native-control-"));
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name, main: "./main.js" }),
  );
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync.native(directory)), base);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test("bridges only cold lifecycle state and preserves the historical implementation and identity", (t) => {
  const directory = checkout(t);
  const source = `module.exports = {
    calls: [],
    initialize(state) { this.calls.push(["initialize", state]); },
    activate(state) { this.calls.push(["activate", state]); },
    serialize() { return { old: true }; },
    openNotebook(filePath) { return filePath; }
  };\n`;
  const originalPath = path.join(directory, "main.js");
  fs.writeFileSync(originalPath, source);
  prepareNativeControl(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  const bridged = require(path.join(directory, manifest.main));
  const original = require(originalPath);
  assert.equal(bridged, original);
  assert.equal(bridged.serialize, undefined);
  bridged.initialize({ workspaceState: "current context" });
  bridged.activate({ workspaceState: "current context" });
  assert.deepEqual(bridged.calls, [
    ["initialize", {}],
    ["activate", {}],
  ]);
  assert.equal(bridged.openNotebook("A.ipynb"), "A.ipynb");
  assert.equal(fs.readFileSync(originalPath, "utf8"), source);
});

test("refuses to prepare a different package", (t) => {
  const directory = checkout(t, "different-package");
  assert.throws(() => prepareNativeControl(directory), /Expected the historical Jupyter control/);
  assert.equal(fs.existsSync(path.join(directory, "native-control-entry.cjs")), false);
});
