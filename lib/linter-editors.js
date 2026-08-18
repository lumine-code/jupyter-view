const { Disposable } = require("lumine");

// Bridges the `linter.editors` service to the notebook's editors. Only pane
// items are linted on their own; the hidden source editor is registered for
// real linting (its diagnostics reach the cells through the `linter.adapter`
// this package also provides), and each cell editor is registered render-only
// ({ lint: false }) so projected messages have marker layers to land on. The
// service connects whenever the linter package activates, before or after a
// notebook opens, so registrations made early are kept and replayed when it
// arrives.

class LinterEditors {
  constructor() {
    // editor -> { options, disposable, destroySubscription }. A null disposable
    // marks an editor waiting for the service to arrive.
    this.editors = new Map();
    this.register = null;
  }

  /**
   * Consume the `linter.editors` service. Registers every editor that was
   * added before it arrived; returns a Disposable revoking it again.
   */
  consume(register) {
    this.register = register;
    for (const entry of this.editors.values()) {
      if (entry.disposable === null) entry.disposable = this.register(entry.editor, entry.options);
    }
    return new Disposable(() => this.disable());
  }

  /**
   * Stand down while the service is away, keeping every editor so the next
   * connection replays them.
   */
  disable() {
    this.register = null;
    for (const entry of this.editors.values()) {
      entry.disposable?.dispose();
      entry.disposable = null;
    }
  }

  add(editor, options = {}) {
    if (!editor) return new Disposable();
    // Registering the same editor twice would otherwise strand the first
    // registration in the service with nothing left holding its disposable.
    this.remove(editor);
    this.editors.set(editor, {
      editor,
      options,
      disposable: this.register ? this.register(editor, options) : null,
      // The map holds the editor strongly, so a registration must not be able
      // to outlive it even when whatever made it forgets to dispose.
      destroySubscription: editor.onDidDestroy?.(() => this.remove(editor)) ?? null,
    });
    return new Disposable(() => this.remove(editor));
  }

  remove(editor) {
    const entry = this.editors.get(editor);
    if (!entry) return;
    entry.disposable?.dispose();
    entry.destroySubscription?.dispose();
    this.editors.delete(editor);
  }

  destroy() {
    for (const editor of [...this.editors.keys()]) this.remove(editor);
    this.register = null;
  }
}

// One registry per activation of the package. main.js creates it in
// initialize() — which runs before the workspace asks for this package's
// deserializers, so a restored notebook already has one to register with — and
// disposes it in deactivate(). Nothing a notebook registers outlives the
// package that owns it, and the next activation starts from an empty registry
// rather than inheriting the editors of the last.
let registry = null;

function linterEditors() {
  if (!registry) registry = new LinterEditors();
  return registry;
}

function createLinterEditors() {
  registry?.destroy();
  registry = new LinterEditors();
  return new Disposable(() => {
    registry?.destroy();
    registry = null;
  });
}

function consumeLinterEditors(register) {
  return linterEditors().consume(register);
}

function addLinterEditor(editor, options = {}) {
  return linterEditors().add(editor, options);
}

module.exports = { LinterEditors, createLinterEditors, consumeLinterEditors, addLinterEditor };
