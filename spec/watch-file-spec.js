const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const NotebookDocument = require("../lib/notebook-document");
const { FileState } = require("lumine");

describe("notebook file observation", () => {
  let directory, filePath, document;
  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "notebook-watch-"));
    filePath = path.join(directory, "notebook.ipynb");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            id: "cell",
            metadata: {},
            source: ["saved"],
            execution_count: null,
            outputs: [],
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
    );
    document = new NotebookDocument(filePath);
    await document.load();
    await document.file.ready;
  });
  afterEach(async () => {
    const file = document.file;
    document.destroy();
    await file.closed;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  it("keeps its original path after an external rename and sees recreation", async () => {
    fs.renameSync(filePath, path.join(directory, "external.ipynb"));
    await globalThis.conditionPromise(() => document.getFileState() === FileState.REMOVED);
    expect(document.getPath()).toBe(filePath);
    fs.copyFileSync(path.join(directory, "external.ipynb"), filePath);
    await globalThis.conditionPromise(() => document.getFileState() === FileState.UNMODIFIED);
  });
  it("reconciles an external write that arrives while save notifications are deferred", async () => {
    await document.save();
    const contents = JSON.parse(fs.readFileSync(filePath, "utf8"));
    contents.cells[0].source = ["external after save"];
    fs.writeFileSync(filePath, JSON.stringify(contents));
    await globalThis.conditionPromise(() => document.getCell(0).source === "external after save");
    expect(document.getFileState()).toBe(FileState.UNMODIFIED);
  });

  it("retargets an editor move without replacing unsaved cells or their history", async () => {
    document.updateCellSource(0, "local edit");
    const cell = document.getCell(0);
    const history = document.currentHistoryStateId;
    const target = path.join(directory, "moved.ipynb");
    const rename = { oldPath: filePath, newPath: target, isDirectory: false };
    const move = lumine.workspace.beginFileMove([rename]);
    fs.renameSync(filePath, target);
    await move.complete([rename]);
    expect(document.getPath()).toBe(target);
    expect(document.getCell(0)).toBe(cell);
    expect(cell.source).toBe("local edit");
    expect(document.currentHistoryStateId).toBe(history);
    expect(document.getFileState()).toBe(FileState.MODIFIED);
  });
});
