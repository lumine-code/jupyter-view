const { Disposable } = require("lumine");

// Bridges the `linter.editors` service to the notebook's editors. Only pane
// items are linted on their own; the hidden source editor is registered for
// real linting (its diagnostics reach the cells through the `linter.adapter`
// this package also provides), and each cell editor is registered render-only
// ({ lint: false }) so projected messages have marker layers to land on. The
// service connects whenever the linter package activates, before or after a
// notebook opens, so registrations made early are kept and replayed when it
// arrives.

const registered = new Map(); // editor -> { disposable: Disposable|null, options }
let register = null;

function consumeLinterEditors(service) {
  register = service;
  for (const [editor, entry] of registered) {
    if (entry.disposable === null) {
      entry.disposable = register(editor, entry.options);
    }
  }
  return new Disposable(() => {
    register = null;
    for (const entry of registered.values()) {
      entry.disposable?.dispose();
      entry.disposable = null;
    }
  });
}

function addLinterEditor(editor, options = {}) {
  registered.set(editor, { disposable: register ? register(editor, options) : null, options });
  return new Disposable(() => {
    registered.get(editor)?.disposable?.dispose();
    registered.delete(editor);
  });
}

module.exports = { consumeLinterEditors, addLinterEditor };
