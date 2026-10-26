const { TextBuffer } = require("lumine");

describe("snapshot notebook search", () => {
  let adapter, document, editors;
  function setup(sources, mounted = true) {
    const CellModel = require("../lib/cell-model"),
      Document = require("../lib/notebook-document");
    document = new Document();
    document.cells = sources.map(
      (source, index) => new CellModel({ id: `search-${index}`, type: "code", source }),
    );
    editors = [];
    const cellViews = new Map();
    if (mounted)
      document.cells.forEach((cell) => {
        const buffer = new TextBuffer();
        buffer.setTextInRange(buffer.getRange(), cell.getSourceSnapshot(), {
          normalizeLineEndings: false,
        });
        buffer.clearUndoStack();
        const editor = lumine.workspace.buildTextEditor({ buffer, autoHeight: false });
        editors.push(editor);
        cellViews.set(cell.id, { editor, focus() {} });
      });
    const notebook = {
      document,
      activeCellIndex: 0,
      setActiveCell(index) {
        this.activeCellIndex = index;
      },
      view: { cellViews, setMode() {}, scrollToCell() {} },
    };
    adapter = new (require("../lib/notebook-search"))(notebook);
    return notebook;
  }
  const query = (regex) => ({
    findPattern: regex.source,
    useRegex: true,
    getFindPatternRegex: () => regex,
  });
  afterEach(() => {
    adapter?.destroy();
    for (const editor of editors ?? []) editor.destroy();
    document?.destroy();
  });

  it("counts dense sources exactly without retaining one match per occurrence", async () => {
    setup(["x ".repeat(100000)]);
    spyOn(editors[0], "getText").and.throwError("Whole cell string");
    spyOnProperty(document.cells[0], "source", "get").and.throwError("Whole model string");
    await adapter.search(query(/x/g));
    expect(adapter.getResultCount()).toBe(100000);
    expect(adapter.matches.length).toBeLessThanOrEqual(1);
    editors[0].setCursorBufferPosition([0, 199990]);
    expect((await adapter.selectNext()).found).toBe(true);
    expect(adapter.getCurrentResultIndex()).toBe(99996);
  });

  it("searches unmounted cells larger than a runtime string without materialization", async () => {
    jasmine.useRealClock();
    const buffer = new TextBuffer("x".repeat(32768));
    let source = buffer.getTextSnapshot();
    while (source.length <= require("node:buffer").constants.MAX_STRING_LENGTH)
      source = source.replace(source.length, source.length, source);
    source = source.replace(source.length, source.length, "\nneedle");
    buffer.destroy();
    setup([source], false);
    spyOnProperty(document.cells[0], "source", "get").and.throwError("Whole model string");
    await adapter.search(query(/needle/g));
    expect(adapter.getResultCount()).toBe(1);
    expect((await adapter.selectFirstFromCursor()).found).toBe(true);
    expect(adapter.currentResult.start).toBe(source.length - 6);
  });

  it("atomically replaces every cell with exact mounted markers and coherent model events", async () => {
    setup(["x gap x", "x tail"]);
    const marker = editors[0].getBuffer().markRange(
      [
        [0, 2],
        [0, 5],
      ],
      { invalidate: "never" },
    );
    const seen = [];
    editors[0]
      .getBuffer()
      .onDidChangeText(() =>
        seen.push(document.cells.map((cell) => cell.getSourceSnapshot().toString())),
      );
    await adapter.search(query(/x/g));
    expect(await adapter.replaceAll("long")).toBe(3);
    expect(seen).toEqual([["long gap long", "long tail"]]);
    expect(marker.getRange().serialize()).toEqual([
      [0, 5],
      [0, 8],
    ]);
    expect(editors[1].getBuffer().getText()).toBe("long tail");
    await adapter.scanPromise;
    expect(adapter.getResultCount()).toBe(0);
  });

  it("preserves full regex replacement context and zero-width matches", async () => {
    setup(["abc\nabc"]);
    await adapter.search(query(/(?<=a)(b)(?=c)/g));
    expect(await adapter.replaceAll("[$1]")).toBe(2);
    expect(document.cells[0].getSourceSnapshot().toString()).toBe("a[b]c\na[b]c");
    await adapter.search(query(/^/gm));
    expect(adapter.getResultCount()).toBe(2);
    expect(await adapter.replaceAll("_")).toBe(2);
    expect(document.cells[0].getSourceSnapshot().toString()).toBe("_a[b]c\n_a[b]c");
  });

  it("drops an obsolete query while keeping the new exact count", async () => {
    setup(["x ".repeat(100000)]);
    const first = adapter.search(query(/x/g));
    const second = adapter.search(query(/absent/g));
    await Promise.all([first, second]);
    expect(adapter.getResultCount()).toBe(0);
    expect(adapter.isPending()).toBe(false);
  });
  it("cancels at the last cell before publication without partially updating models or buffers", async () => {
    setup(["x first", "x second"]);
    await adapter.search(query(/x/g));
    editors[1].getBuffer().onWillChange(() => adapter.replacementController.abort());
    let failure;
    try {
      await adapter.replaceAll("long");
    } catch (error) {
      failure = error;
    }
    expect(failure?.name).toBe("AbortError");
    expect(document.cells.map((cell) => cell.getSourceSnapshot().toString())).toEqual([
      "x first",
      "x second",
    ]);
    expect(editors.map((editor) => editor.getBuffer().getText())).toEqual(["x first", "x second"]);
    await adapter.scanPromise;
  });

  it("reports committed model observer failures after all cells and buffers have changed", async () => {
    setup(["x first", "x second"]);
    await adapter.search(query(/x/g));
    const subscription = document.onDidChange(() => {
      throw new Error("observer failed");
    });
    let failure;
    try {
      await adapter.replaceAll("long");
    } catch (error) {
      failure = error;
    }
    subscription.dispose();
    expect(failure?.committed).toBe(true);
    expect(document.cells.map((cell) => cell.getSourceSnapshot().toString())).toEqual([
      "long first",
      "long second",
    ]);
    expect(editors.map((editor) => editor.getBuffer().getText())).toEqual([
      "long first",
      "long second",
    ]);
    await adapter.scanPromise;
  });

  it("publishes cleared query state before a syntax error, so a later update does not erase the error", () => {
    setup(["text"]);
    const events = [];
    adapter.onDidUpdate(() => events.push("update"));
    adapter.onDidError(() => events.push("error"));
    adapter.search({
      findPattern: "[",
      getFindPatternRegex() {
        throw new SyntaxError("bad regex");
      },
    });
    expect(events.at(-1)).toBe("error");
    expect(adapter.getResultCount()).toBe(0);
    expect(adapter.isPending()).toBe(false);
  });
  it("denies model and structure mutation by observers throughout coordinated publication", async () => {
    setup(["x first", "x second"]);
    await adapter.search(query(/x/g));
    const attempts = [
      () => document.cells[1].setSource("corrupted"),
      () => {
        document.cells[1].source = "corrupted";
      },
      () => document.cells.splice(0, 1),
      () => {
        document.cells = [];
      },
      () => document.destroy(),
    ];
    let blocked = 0;
    const subscription = document.onDidChange(() => {
      for (const mutate of attempts) {
        try {
          mutate();
        } catch {
          blocked++;
        }
      }
    });
    expect(await adapter.replaceAll("long")).toBe(2);
    subscription.dispose();
    expect(blocked).toBe(attempts.length);
    expect(document.isDestroyed()).toBe(false);
    expect(document.cells.map((cell) => cell.getSourceSnapshot().toString())).toEqual([
      "long first",
      "long second",
    ]);
    expect(editors.map((editor) => editor.getBuffer().getText())).toEqual([
      "long first",
      "long second",
    ]);
    await adapter.scanPromise;
  });
});
