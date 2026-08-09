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
    this.watchEditor = null;
    // editor -> Disposable|null. A null value marks an editor waiting for the
    // service to arrive.
    this.editors = new Map();
  }

  get isEnabled() {
    return this.watchEditor != null;
  }

  /**
   * Consume the `autocomplete.watch-editor` service. Wires editors registered
   * before the service arrived; returns a Disposable revoking it again.
   */
  consume(watchEditor) {
    this.watchEditor = watchEditor;
    for (const [editor, disposable] of this.editors) {
      if (!disposable) {
        this.editors.set(editor, this.watchEditor(editor, CELL_EDITOR_LABELS) ?? null);
      }
    }
    return new Disposable(() => this.disable());
  }

  disable() {
    this.watchEditor = null;
    for (const [editor, disposable] of this.editors) {
      if (disposable) {
        disposable.dispose();
        this.editors.set(editor, null);
      }
    }
  }

  /**
   * Keep autocomplete active in a cell editor. Effective immediately when the
   * service is present, or as soon as it arrives; cleans up when the editor
   * is destroyed.
   */
  watchCellEditor(editor) {
    if (!editor || this.editors.has(editor)) return;
    this.editors.set(
      editor,
      this.isEnabled ? (this.watchEditor(editor, CELL_EDITOR_LABELS) ?? null) : null,
    );
    editor.onDidDestroy(() => {
      this.editors.get(editor)?.dispose();
      this.editors.delete(editor);
    });
  }
}

module.exports = new AutocompleteWatch();
