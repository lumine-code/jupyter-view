const { Disposable } = require("lumine");

// Bridges the `linter.editors` service to the notebook's source editor. Only
// pane items are linted on their own, and the source editor is a background
// editor — so it is handed to the linter here, and its diagnostics reach the
// cells through the `linter.adapter` this package also provides. The service
// connects whenever the linter package activates, before or after a notebook
// opens, so registrations made early are kept and replayed when it arrives.

const registered = new Map(); // editor -> Disposable, or null while unconnected
let register = null;

function consumeLinterEditors(service) {
  register = service;
  for (const [editor, disposable] of registered) {
    if (disposable === null) {
      registered.set(editor, register(editor));
    }
  }
  return new Disposable(() => {
    register = null;
    for (const [editor, disposable] of registered) {
      disposable?.dispose();
      registered.set(editor, null);
    }
  });
}

function addLinterEditor(editor) {
  registered.set(editor, register ? register(editor) : null);
  return new Disposable(() => {
    registered.get(editor)?.dispose();
    registered.delete(editor);
  });
}

module.exports = { consumeLinterEditors, addLinterEditor };
