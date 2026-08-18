const {
  createAutocompleteWatch,
  consumeAutocompleteWatchEditor,
  watchCellEditor,
} = require("../lib/autocomplete-watch");

// Cell editors are not workspace pane items, so autocomplete never finds them
// on its own; this watcher hands them over through the
// `autocomplete.watch-editor` service. Editors and the service arrive in either
// order, and each side can go away first.
describe("lib/autocomplete-watch", () => {
  let watches;
  let serviceDisposable;
  let ownership;

  const watchEditor = (editor, labels) => {
    const entry = { editor, labels, disposed: false };
    watches.push(entry);
    return {
      dispose() {
        entry.disposed = true;
      },
    };
  };

  const buildEditor = () => lumine.workspace.buildTextEditor();

  beforeEach(() => {
    watches = [];
    serviceDisposable = null;
    // The watcher belongs to whoever owns this activation of the package, so
    // each case takes it for itself rather than inheriting whatever cell
    // editors another spec file left open.
    ownership = createAutocompleteWatch();
  });

  afterEach(() => {
    serviceDisposable?.dispose();
    ownership.dispose();
  });

  it("watches an editor added after the service connected", () => {
    serviceDisposable = consumeAutocompleteWatchEditor(watchEditor);
    const editor = buildEditor();

    const watched = watchCellEditor(editor);

    expect(watches.map((entry) => entry.editor)).toEqual([editor]);
    expect(watches[0].labels).toEqual(["default", "workspace-center"]);
    watched.dispose();
    expect(watches[0].disposed).toBe(true);
    editor.destroy();
  });

  it("replays an editor added before the service connected", () => {
    const editor = buildEditor();
    const watched = watchCellEditor(editor);
    expect(watches).toEqual([]);

    serviceDisposable = consumeAutocompleteWatchEditor(watchEditor);

    expect(watches.map((entry) => entry.editor)).toEqual([editor]);
    watched.dispose();
    editor.destroy();
  });

  it("drops its watches when the service goes away, and replays on return", () => {
    serviceDisposable = consumeAutocompleteWatchEditor(watchEditor);
    const editor = buildEditor();
    const watched = watchCellEditor(editor);

    serviceDisposable.dispose();
    expect(watches[0].disposed).toBe(true);

    serviceDisposable = consumeAutocompleteWatchEditor(watchEditor);
    expect(watches.length).toBe(2);
    expect(watches[1].editor).toBe(editor);
    expect(watches[1].disposed).toBe(false);

    watched.dispose();
    editor.destroy();
  });

  it("forgets an editor that is destroyed without its watch disposed", () => {
    serviceDisposable = consumeAutocompleteWatchEditor(watchEditor);
    const editor = buildEditor();
    watchCellEditor(editor);

    editor.destroy();

    expect(watches[0].disposed).toBe(true);
    serviceDisposable.dispose();
    serviceDisposable = consumeAutocompleteWatchEditor(watchEditor);
    expect(watches.length).toBe(1);
  });

  it("leaves the first watch alone when an editor is watched twice", () => {
    serviceDisposable = consumeAutocompleteWatchEditor(watchEditor);
    const editor = buildEditor();

    const first = watchCellEditor(editor);
    watchCellEditor(editor);

    expect(watches.length).toBe(1);
    expect(watches[0].disposed).toBe(false);
    first.dispose();
    editor.destroy();
  });

  it("disposes what it was holding when the package gives the watcher up", () => {
    serviceDisposable = consumeAutocompleteWatchEditor(watchEditor);
    const editor = buildEditor();
    watchCellEditor(editor);
    expect(watches[0].disposed).toBe(false);

    ownership.dispose();

    expect(watches[0].disposed).toBe(true);
    ownership = createAutocompleteWatch();
    editor.destroy();
  });

  it("hands nothing on to the next owner of the watcher", () => {
    const editor = buildEditor();
    watchCellEditor(editor);

    ownership.dispose();
    ownership = createAutocompleteWatch();
    serviceDisposable = consumeAutocompleteWatchEditor(watchEditor);

    expect(watches).toEqual([]);
    editor.destroy();
  });
});
