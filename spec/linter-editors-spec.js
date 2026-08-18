const {
  createLinterEditors,
  consumeLinterEditors,
  addLinterEditor,
} = require("../lib/linter-editors");

// The notebook's source editor is not a pane item, so the linter never
// discovers it on its own; this holder hands it over through the
// `linter.editors` service. Editors and the service arrive in either order,
// and each side can go away first.
describe("lib/linter-editors", () => {
  let registrations;
  let serviceDisposable;
  let ownership;

  const register = (editor) => {
    const entry = { editor, disposed: false };
    registrations.push(entry);
    return {
      dispose() {
        entry.disposed = true;
      },
    };
  };

  const buildEditor = () => lumine.workspace.buildTextEditor();

  beforeEach(() => {
    registrations = [];
    serviceDisposable = null;
    // The registry belongs to whoever owns this activation of the package, so
    // each case takes it for itself. Without that, a notebook another spec file
    // left open replays into the first expectation here.
    ownership = createLinterEditors();
  });

  afterEach(() => {
    serviceDisposable?.dispose();
    ownership.dispose();
  });

  it("registers an editor added after the service connected", () => {
    serviceDisposable = consumeLinterEditors(register);
    const editor = buildEditor();

    const added = addLinterEditor(editor);

    expect(registrations.map((entry) => entry.editor)).toEqual([editor]);
    added.dispose();
    expect(registrations[0].disposed).toBe(true);
    editor.destroy();
  });

  it("replays an editor added before the service connected", () => {
    const editor = buildEditor();
    const added = addLinterEditor(editor);
    expect(registrations).toEqual([]);

    serviceDisposable = consumeLinterEditors(register);

    expect(registrations.map((entry) => entry.editor)).toEqual([editor]);
    added.dispose();
    editor.destroy();
  });

  it("drops its registrations when the service goes away, and replays on return", () => {
    serviceDisposable = consumeLinterEditors(register);
    const editor = buildEditor();
    const added = addLinterEditor(editor);

    serviceDisposable.dispose();
    expect(registrations[0].disposed).toBe(true);

    serviceDisposable = consumeLinterEditors(register);
    expect(registrations.length).toBe(2);
    expect(registrations[1].editor).toBe(editor);
    expect(registrations[1].disposed).toBe(false);

    added.dispose();
    editor.destroy();
  });

  it("keeps an editor's registration options across a service reconnect", () => {
    const options = [];
    const registerWithOptions = (editor, opts) => {
      options.push(opts);
      return { dispose() {} };
    };

    const editor = buildEditor();
    const added = addLinterEditor(editor, { lint: false });

    serviceDisposable = consumeLinterEditors(registerWithOptions);
    expect(options).toEqual([{ lint: false }]);

    serviceDisposable.dispose();
    serviceDisposable = consumeLinterEditors(registerWithOptions);
    expect(options).toEqual([{ lint: false }, { lint: false }]);

    added.dispose();
    editor.destroy();
  });

  it("forgets an editor that is destroyed without its registration disposed", () => {
    serviceDisposable = consumeLinterEditors(register);
    const editor = buildEditor();
    addLinterEditor(editor);

    editor.destroy();

    expect(registrations[0].disposed).toBe(true);
    serviceDisposable.dispose();
    serviceDisposable = consumeLinterEditors(register);
    expect(registrations.length).toBe(1);
  });

  it("disposes the previous registration when an editor is added twice", () => {
    serviceDisposable = consumeLinterEditors(register);
    const editor = buildEditor();

    addLinterEditor(editor);
    const second = addLinterEditor(editor, { lint: false });

    expect(registrations.length).toBe(2);
    expect(registrations[0].disposed).toBe(true);
    expect(registrations[1].disposed).toBe(false);
    second.dispose();
    editor.destroy();
  });

  it("hands nothing on to the next owner of the registry", () => {
    const editor = buildEditor();
    addLinterEditor(editor);

    ownership.dispose();
    ownership = createLinterEditors();
    serviceDisposable = consumeLinterEditors(register);

    expect(registrations).toEqual([]);
    editor.destroy();
  });
});
