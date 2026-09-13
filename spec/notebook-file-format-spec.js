const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FileState } = require("lumine");
const NotebookDocument = require("../lib/notebook-document");
const JupyterNotebookEditor = require("../lib/jupyter-notebook-editor");

function notebook(source = "zażółć") {
  return {
    cells: [
      {
        cell_type: "code",
        id: "cell",
        metadata: {},
        source: [source],
        execution_count: null,
        outputs: [],
      },
    ],
    metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function withLineEndings(value, lineEnding) {
  return JSON.stringify(value, null, 2).replace(/\n/g, lineEnding);
}

describe("notebook file format identity", () => {
  let directory;
  let filePath;
  let document_;
  let editor;

  beforeEach(() => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "notebook-format-"));
    filePath = path.join(directory, "notebook.ipynb");
  });

  afterEach(async () => {
    const watchedFile = document_?.file;
    if (editor && !editor._destroyed) editor.destroy();
    if (document_ && document_.refCount <= 0) document_.destroy();
    await watchedFile?.closed;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function openFile(text) {
    fs.writeFileSync(filePath, text, "utf8");
    document_ = new NotebookDocument(filePath);
    await document_.load();
    editor = new JupyterNotebookEditor(document_);
    await editor._sourceEditorSetupPromise;
    return editor.getFileTextEditor();
  }

  it("exposes the ipynb source as read-only UTF-8", async () => {
    const sourceEditor = await openFile(withLineEndings(notebook(), "\n"));
    expect(sourceEditor.getEncoding()).toBe("utf8");
    expect(sourceEditor.isEncodingReadOnly()).toBe(true);
    expect(sourceEditor.setEncoding("utf16le")).toBe(false);
    expect(sourceEditor.getEncoding()).toBe("utf8");
  });

  it("detects, converts, saves, undoes, and redoes line endings through the source editor", async () => {
    const sourceEditor = await openFile(withLineEndings(notebook(), "\n"));
    const changes = [];
    sourceEditor.onDidChangeLineEndings((lineEndings) => changes.push(Array.from(lineEndings)));

    expect(Array.from(sourceEditor.getLineEndings())).toEqual(["\n"]);
    expect(sourceEditor.setLineEnding("\r\n")).toBe(true);
    expect(Array.from(sourceEditor.getLineEndings())).toEqual(["\r\n"]);
    expect(sourceEditor.getText()).toContain("\r\n");
    expect(document_.getFileState()).toBe(FileState.MODIFIED);

    editor.undoCellOperation();
    expect(Array.from(sourceEditor.getLineEndings())).toEqual(["\n"]);
    expect(document_.getFileState()).toBe(FileState.UNMODIFIED);

    editor.redoCellOperation();
    expect(Array.from(sourceEditor.getLineEndings())).toEqual(["\r\n"]);
    expect(document_.getFileState()).toBe(FileState.MODIFIED);
    expect(changes).toEqual([["\r\n"], ["\n"], ["\r\n"]]);

    expect(await editor.save()).toBe(true);
    const bytes = fs.readFileSync(filePath, "utf8");
    expect(bytes).toContain("\r\n");
    expect(bytes.replace(/\r\n/g, "")).not.toContain("\n");
    expect(JSON.parse(bytes).cells[0].source).toEqual(["zażółć"]);
  });

  it("reports mixed input and normalizes it to the first ending on save", async () => {
    const lines = JSON.stringify(notebook(), null, 2).split("\n");
    const mixed = lines
      .map((line, index) => line + (index === lines.length - 1 ? "" : index % 2 ? "\n" : "\r\n"))
      .join("");
    const sourceEditor = await openFile(mixed);

    expect(Array.from(sourceEditor.getLineEndings())).toEqual(["\r\n", "\n"]);
    expect(await editor.save()).toBe(true);
    const bytes = fs.readFileSync(filePath, "utf8");
    expect(bytes).toContain("\r\n");
    expect(bytes.replace(/\r\n/g, "")).not.toContain("\n");
    expect(Array.from(sourceEditor.getLineEndings())).toEqual(["\r\n"]);
    expect(document_.getFileState()).toBe(FileState.UNMODIFIED);
  });

  it("redetects line endings after an external reload", async () => {
    const sourceEditor = await openFile(withLineEndings(notebook(), "\n"));
    fs.writeFileSync(filePath, withLineEndings(notebook(), "\r\n"), "utf8");

    await document_._handleFileChange();

    expect(Array.from(sourceEditor.getLineEndings())).toEqual(["\r\n"]);
    expect(document_.getFileState()).toBe(FileState.UNMODIFIED);
  });

  it("uses the selected ending and UTF-8 when an untitled notebook is saved as", async () => {
    document_ = new NotebookDocument(null);
    await document_.initialize();
    document_.updateCellSource(0, "gęślą jaźń");
    editor = new JupyterNotebookEditor(document_);
    await editor._sourceEditorSetupPromise;
    const sourceEditor = editor.getFileTextEditor();
    sourceEditor.setLineEnding("\r\n");

    expect(await editor.saveAs(filePath)).toBe(true);

    const bytes = fs.readFileSync(filePath, "utf8");
    expect(bytes).toContain("\r\n");
    expect(bytes.replace(/\r\n/g, "")).not.toContain("\n");
    expect(JSON.parse(bytes).cells[0].source).toEqual(["gęślą jaźń"]);
    expect(sourceEditor.getPath()).toBe(filePath);
    expect(sourceEditor.getEncoding()).toBe("utf8");
  });

  it("rebuilds a clean restored source projection from the current disk revision", async () => {
    const sourceEditor = await openFile(withLineEndings(notebook("serialized"), "\n"));
    const documentId = document_.id;
    const state = document_.serializeState();
    expect(state.notebookData).toBeNull();
    expect(sourceEditor.getText()).not.toContain("\r\n");

    const oldFile = document_.file;
    editor.destroy();
    await oldFile.closed;

    fs.writeFileSync(filePath, withLineEndings(notebook("current disk"), "\r\n"), "utf8");
    document_ = new NotebookDocument(filePath);
    await document_.load();
    document_.restoreState({ ...state, documentId }, { preserveLoadedRevision: true });
    editor = new JupyterNotebookEditor(document_);
    await editor._sourceEditorSetupPromise;

    const restoredSourceEditor = editor.getFileTextEditor();
    expect(document_.getCell(0).source).toBe("current disk");
    expect(Array.from(restoredSourceEditor.getLineEndings())).toEqual(["\r\n"]);
    expect(restoredSourceEditor.getText()).toContain("\r\n");
    expect(restoredSourceEditor.getText().replace(/\r\n/g, "")).not.toContain("\n");
  });
});
