const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("notebook atomic replacement under a Windows file lock", () => {
  let directory, editor, filePath;

  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    for (const name of ["language-json", "language-python", "language-text"])
      await (
        await lumine.packages.activatePackage(name)
      ).resourceLoadPromise;
    const pack = await lumine.packages.activatePackage("jupyter-view");
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "notebook-replace-owned-")));
    filePath = path.join(directory, "notebook.ipynb");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            id: "owned",
            cell_type: "code",
            source: ["original"],
            metadata: {},
            outputs: [],
            execution_count: null,
          },
        ],
      }),
    );
    editor = await pack.mainModule.openNotebook(filePath);
    await editor._sourceEditorSetupPromise;
  });

  afterEach(async () => {
    editor?.destroy();
    await lumine.packages.deactivatePackage("jupyter-view");
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync(os.tmpdir()), directory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Unsafe notebook replacement scratch");
    fs.rmSync(directory, { recursive: true, force: true });
    directory = editor = filePath = null;
  });

  function ownedRename(behavior) {
    const rename = fs.promises.rename.bind(fs.promises);
    const calls = [];
    spyOn(fs.promises, "rename").and.callFake(async (from, to) => {
      if (to !== filePath || path.dirname(from) !== directory) return rename(from, to);
      calls.push({ from, to });
      return behavior(calls.length, () => rename(from, to));
    });
    return calls;
  }

  function locked(code, message) {
    return Object.assign(new Error(message), { code });
  }

  it("finishes the captured save after a transient Windows replacement lock", async () => {
    const calls = ownedRename((attempt, rename) => {
      if (attempt <= 2) throw locked("EPERM", "Owned transient replacement lock");
      return rename();
    });
    editor.document.updateCellSource(0, "accepted snapshot", editor);
    const saving = editor.save();
    editor.document.updateCellSource(0, "later unsaved edit", editor);
    const saved = await saving;
    if (process.platform === "win32") {
      expect(saved).toBe(true);
      expect(JSON.parse(fs.readFileSync(filePath, "utf8")).cells[0].source).toEqual([
        "accepted snapshot",
      ]);
      expect(new Set(calls.map(({ from }) => from)).size).toBe(1);
      expect(calls.every(({ to }) => to === filePath)).toBe(true);
    } else {
      expect(saved).toBe(false);
      expect(calls.length).toBe(1);
      expect(JSON.parse(fs.readFileSync(filePath, "utf8")).cells[0].source).toEqual(["original"]);
    }
    expect(editor.document.getCell(0).source).toBe("later unsaved edit");
    expect(editor.document.isModified()).toBe(true);
    expect(fs.readdirSync(directory)).toEqual(["notebook.ipynb"]);
  });

  it("preserves the target and reports the first error after a permanent lock", async () => {
    const original = fs.readFileSync(filePath);
    const errors = spyOn(lumine.notifications, "addError").and.callThrough();
    const calls = ownedRename((attempt) => {
      throw locked(
        attempt === 1 ? "EACCES" : "EBUSY",
        attempt === 1 ? "Owned first lock" : "Owned later lock",
      );
    });
    editor.document.updateCellSource(0, "unsaved replacement", editor);
    expect(await editor.save()).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThanOrEqual(5);
    expect(new Set(calls.map(({ from }) => from)).size).toBe(1);
    expect(fs.readFileSync(filePath)).toEqual(original);
    expect(fs.readdirSync(directory)).toEqual(["notebook.ipynb"]);
    expect(editor.document.isModified()).toBe(true);
    expect(errors.calls.mostRecent().args[1].detail).toBe("Owned first lock");
  });

  it("keeps the ordinary native atomic save path", async () => {
    const calls = ownedRename((_attempt, rename) => rename());
    editor.document.updateCellSource(0, "ordinary snapshot", editor);
    expect(await editor.save()).toBe(true);
    expect(calls.length).toBe(1);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).cells[0].source).toEqual([
      "ordinary snapshot",
    ]);
    expect(fs.readdirSync(directory)).toEqual(["notebook.ipynb"]);
    expect(editor.document.isModified()).toBe(false);
  });
});
