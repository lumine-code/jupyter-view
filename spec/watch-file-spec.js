const { watchFile } = require("lumine");
const fs = require("fs");
const os = require("os");
const path = require("path");

// NotebookDocument used the removed synchronous lumine File API to watch the
// backing .ipynb (and to read/write it). Lumine replaced File with the async
// watchFile (reads/writes now go through fs). These specs pin the parts of the
// watchFile contract the document relies on. The handle exposes its emitter so
// events can be synthesized without depending on filesystem timing.
describe("watchFile (notebook document watcher migration)", () => {
  let dir, file, handle;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jupyter-view-watch-")));
    file = path.join(dir, "notebook.ipynb");
    fs.writeFileSync(file, "{}\n");
  });

  afterEach(() => {
    if (handle) {
      handle.dispose();
      handle = null;
    }
    // Retries because Windows keeps a directory non-empty until the last handle on a child
    // closes, and `force` swallows only ENOENT.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("is exported from the lumine module as a function", () => {
    expect(typeof watchFile).toBe("function");
  });

  it("returns a handle with onDidChange/onDidRename/onDidDelete and dispose", () => {
    handle = watchFile(file);
    expect(typeof handle.onDidChange).toBe("function");
    expect(typeof handle.onDidRename).toBe("function");
    expect(typeof handle.onDidDelete).toBe("function");
    expect(typeof handle.dispose).toBe("function");
    expect(typeof handle.getStartPromise).toBe("function");
  });

  it("fires onDidChange and onDidDelete via its emitter", () => {
    handle = watchFile(file);
    let changed = 0;
    let deleted = 0;
    handle.onDidChange(() => {
      changed += 1;
    });
    handle.onDidDelete(() => {
      deleted += 1;
    });

    handle.emitter.emit("did-change");
    handle.emitter.emit("did-delete");
    expect(changed).toBe(1);
    expect(deleted).toBe(1);
  });

  // The only spec here that waits on the real watcher. Arming goes through the
  // @parcel/watcher worker and its cost varies with what else the suite has
  // been doing, so it gets its own headroom rather than jasmine's default.
  it("arms without throwing and resolves its start promise", async () => {
    handle = watchFile(file);
    await handle.getStartPromise();
  }, 20000);
});
