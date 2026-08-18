/**
 * Wires the `autocomplete.watch-editor` service into notebook cell editors.
 *
 * Cell editors are not workspace pane items, so the autocomplete package does
 * not watch them on its own. Labels select which providers serve a watched
 * editor: "workspace-center" matches the kernel provider (and any provider
 * without explicit labels), "default" matches the editor's built-in word
 * provider.
 */

const { Disposable } = require("lumine");

const CELL_EDITOR_LABELS = ["default", "workspace-center"];

class AutocompleteWatch {
  constructor() {
    // editor -> { editor, disposable, destroySubscription }. A null disposable
    // marks an editor waiting for the service to arrive.
    this.editors = new Map();
    this.watchEditor = null;
  }

  get isEnabled() {
    return this.watchEditor != null;
  }

  /**
   * Consume the `autocomplete.watch-editor` service. Watches every editor that
   * was added before it arrived; returns a Disposable revoking it again.
   */
  consume(watchEditor) {
    this.watchEditor = watchEditor;
    for (const entry of this.editors.values()) {
      if (entry.disposable === null) entry.disposable = this.registerEditor(entry.editor);
    }
    return new Disposable(() => this.disable());
  }

  /**
   * Stand down while the service is away, keeping every editor so the next
   * connection replays them.
   */
  disable() {
    this.watchEditor = null;
    for (const entry of this.editors.values()) {
      entry.disposable?.dispose();
      entry.disposable = null;
    }
  }

  registerEditor(editor) {
    return this.watchEditor(editor, CELL_EDITOR_LABELS) ?? null;
  }

  /**
   * Keep autocomplete active in a cell editor. Effective immediately when the
   * service is present, or as soon as it arrives.
   */
  watch(editor) {
    if (!editor) return new Disposable();
    // A watch carries no options, so a second call is the same request as the
    // first: leave the registration it made alone rather than cycling it.
    if (this.editors.has(editor)) return new Disposable();
    this.editors.set(editor, {
      editor,
      disposable: this.isEnabled ? this.registerEditor(editor) : null,
      // The map holds the editor strongly, so a watch must not be able to
      // outlive it even when whatever asked for it forgets to dispose.
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
    this.watchEditor = null;
  }
}

// One watcher per activation of the package, on the same terms as the
// linter-editors registry beside it: main.js creates it in initialize() — early
// enough for a notebook the workspace deserializes before activate() — and
// disposes it in deactivate().
let watcher = null;

function autocompleteWatch() {
  if (!watcher) watcher = new AutocompleteWatch();
  return watcher;
}

function createAutocompleteWatch() {
  watcher?.destroy();
  watcher = new AutocompleteWatch();
  return new Disposable(() => {
    watcher?.destroy();
    watcher = null;
  });
}

function consumeAutocompleteWatchEditor(watchEditor) {
  return autocompleteWatch().consume(watchEditor);
}

function watchCellEditor(editor) {
  return autocompleteWatch().watch(editor);
}

module.exports = {
  AutocompleteWatch,
  createAutocompleteWatch,
  consumeAutocompleteWatchEditor,
  watchCellEditor,
};
