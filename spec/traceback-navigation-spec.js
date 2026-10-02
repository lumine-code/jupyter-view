const navigation = require("../lib/traceback-navigation");

describe("notebook traceback provenance", () => {
  let document_;
  let editor;
  let kernel;
  beforeEach(() => {
    document_ = {
      cells: [
        { id: "first-id", source: "def f():\n    return 1 / 0" },
        { id: "second-id", source: "f()" },
      ],
    };
    editor = {
      document: document_,
      revealCellById: jasmine.createSpy("revealCellById").and.returnValue(Promise.resolve()),
    };
    kernel = {};
  });

  function execute(index, count) {
    const cell = document_.cells[index];
    const target = { id: cell.id, source: cell.source, row: cell.source.split("\n").length - 1 };
    navigation.beginExecution(document_, target, kernel);
    navigation.recordCount(document_, target, count);
    return target;
  }

  it("links a preceding function frame to its stable cell id after reordering", async () => {
    execute(0, 17);
    const target = execute(1, 18);
    const output = { output_type: "error" };
    navigation.recordOutput(document_, target, output);
    document_.cells.reverse();
    const options = navigation.optionsForOutput(editor, output);
    expect(options.kernel).toBe(kernel);
    await options.resolveTracebackFrame({ executionCount: 17, line: 2 }).open();
    const [cellId, range, guard] = editor.revealCellById.calls.mostRecent().args;
    expect(cellId).toBe("first-id");
    expect(range).toEqual([
      [1, 0],
      [1, 0],
    ]);
    expect(typeof guard).toBe("function");
    expect(guard()).toBe(true);
  });

  it("never treats an execution count as the current notebook cell index", () => {
    const target = execute(1, 31);
    const output = { output_type: "error" };
    navigation.recordOutput(document_, target, output);
    const resolve = navigation.optionsForOutput(editor, output).resolveTracebackFrame;
    expect(resolve({ executionCount: 1, line: 1 })).toBe(null);
    expect(resolve({ executionCount: 31, line: 1 })).toBeTruthy();
  });

  it("refuses links when the cell source changed or the cell was deleted", () => {
    const target = execute(0, 9);
    const output = { output_type: "error" };
    navigation.recordOutput(document_, target, output);
    const resolve = navigation.optionsForOutput(editor, output).resolveTracebackFrame;
    document_.cells[0].source = "changed()";
    expect(resolve({ executionCount: 9, line: 1 })).toBe(null);
    document_.cells.shift();
    expect(resolve({ executionCount: 9, line: 1 })).toBe(null);
  });

  it("does not invent provenance for restored notebook outputs", () => {
    const output = { output_type: "error", traceback: ["Cell In[17], line 1"] };
    document_.cells[0].executionCount = 17;
    expect(navigation.optionsForOutput(editor, output)).toEqual({ outputScope: document_ });
  });

  it("retains earlier frames when execute_input and execute_result report the same count", () => {
    execute(0, 3);
    const target = execute(1, 4);
    navigation.recordCount(document_, target, 4);
    const output = { output_type: "error" };
    navigation.recordOutput(document_, target, output);
    expect(
      navigation
        .optionsForOutput(editor, output)
        .resolveTracebackFrame({ executionCount: 3, line: 2 }),
    ).toBeTruthy();
  });

  it("maps a selected cell body and preserves a SyntaxError column range", async () => {
    document_.cells[0].source = "before\n    x = y\nafter";
    const target = { id: "first-id", source: "x = y", row: 1 };
    navigation.beginExecution(document_, target, kernel);
    navigation.recordCount(document_, target, 5);
    const output = { output_type: "error" };
    navigation.recordOutput(document_, target, output);
    await navigation
      .optionsForOutput(editor, output)
      .resolveTracebackFrame({
        executionCount: 5,
        line: 1,
        column: 4,
        endColumn: 5,
        sourceLine: "x = y",
      })
      .open();
    const [cellId, range, guard] = editor.revealCellById.calls.mostRecent().args;
    expect(cellId).toBe("first-id");
    expect(range).toEqual([
      [1, 8],
      [1, 9],
    ]);
    expect(typeof guard).toBe("function");
  });
});
