describe("notebook kernel output accumulation budgets", () => {
  let cells, budget, check;
  const output = (text) => ({ output_type: "stream", name: "stdout", text });
  beforeEach(() => {
    cells = [];
    budget = require("../lib/output-budget");
    check = budget.assertOutput;
    spyOn(lumine.notifications, "addError");
  });
  afterEach(() => {
    for (const cell of cells) cell.destroy();
  });
  function cell() {
    const value = new (require("../lib/cell-model"))({
      id: String(cells.length),
      source: "",
      outputs: [],
    });
    value.outputBudgetCells = () => cells;
    cells.push(value);
    return value;
  }

  it("rejects before joining or clearing prior complete output and persists the incomplete state", () => {
    spyOn(budget, "assertOutput").and.callFake((item, incoming) =>
      check(item, incoming, { perOutput: 160, perDocument: 500 }),
    );
    const first = cell();
    first.addOutput(output("complete result"));
    first.scheduleClearOutputs();
    const text = ["x".repeat(200), "y".repeat(200)];
    spyOn(text, "join").and.throwError("Must check before joining");
    expect(first.addOutput(output(text))).toBe(false);
    expect(first.outputs[0].text).toBe("complete result");
    expect(first.hasPendingClear()).toBe(false);
    expect(first.outputIncomplete).toContain("accumulation budget");
    expect(text.join).not.toHaveBeenCalled();
    expect(first.addOutput(output("later output"))).toBe(false);
    expect(lumine.notifications.addError).toHaveBeenCalledTimes(1);
    const saved = first.toJSON();
    const restored = new (require("../lib/cell-model"))({
      source: "",
      outputs: saved.outputs,
      metadata: saved.metadata,
    });
    cells.push(restored);
    expect(restored.outputIncomplete).toBe(first.outputIncomplete);
    first.clearOutputs();
    expect(first.addOutput(output("recovered"))).toBe(true);
    expect(first.outputIncomplete).toBeNull();
  });

  it("bounds the aggregate across different cells and outputs", () => {
    const unit = budget.measure(output("x".repeat(40)));
    spyOn(budget, "assertOutput").and.callFake((item, incoming) =>
      check(item, incoming, { perOutput: unit * 2, perDocument: unit * 2 + 5 }),
    );
    const first = cell(),
      second = cell(),
      third = cell();
    expect(first.addOutput(output("x".repeat(40)))).toBe(true);
    expect(second.addOutput(output("y".repeat(40)))).toBe(true);
    expect(third.addOutput(output("z".repeat(40)))).toBe(false);
    expect(first.outputs[0].text).toBe("x".repeat(40));
    expect(second.outputs[0].text).toBe("y".repeat(40));
    expect(third.outputs).toEqual([]);
    expect(third.outputIncomplete).toBeTruthy();
  });
});
