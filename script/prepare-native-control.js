"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

function prepareNativeControl(directory) {
  const root = path.resolve(directory);
  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "jupyter-view") throw new Error("Expected the historical Jupyter control");
  const original = createRequire(manifestPath).resolve(manifest.main);
  const relative = path.relative(root, original);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Historical control entry must belong to its checkout");
  const entry = "native-control-entry.cjs";
  const request = `./${relative.replaceAll(path.sep, "/")}`;
  fs.writeFileSync(
    path.join(root, entry),
    `"use strict";
// CI-only cold-start bridge for a pinned pre-context runtime. Native path and
// document implementations remain untouched; session recovery is not exercised
// by these controls. Preserve the original exports identity for its consumers.
const original = require(${JSON.stringify(request)});
const initialize = original.initialize;
const activate = original.activate;
if (typeof initialize !== "function" || typeof activate !== "function" || typeof original.serialize !== "function")
  throw new Error("Unexpected historical Jupyter lifecycle");
delete original.serialize;
original.initialize = function initializeControl(_context) { return initialize.call(this, {}); };
original.activate = function activateControl(_context) { return activate.call(this, {}); };
module.exports = original;
`,
    { flag: "wx" },
  );
  manifest.main = `./${entry}`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

if (require.main === module) prepareNativeControl(process.argv[2]);

module.exports = { prepareNativeControl };
