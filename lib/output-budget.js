// Kernel output is an independently bounded protocol surface. Source editing
// and file recovery do not use these accumulation limits.
const PER_OUTPUT = 8 * 1024 * 1024;
const PER_DOCUMENT = 24 * 1024 * 1024;

function measure(value, budget = { units: 0, nodes: 0 }, depth = 0, ancestors = new Set()) {
  if (++budget.nodes > 100000 || depth > 128) throw limitError();
  budget.units += typeof value === "string" ? value.length : 16;
  if (budget.units > PER_DOCUMENT) throw limitError();
  if (value && typeof value === "object") {
    if (Array.isArray(value) && value.length > 100000) throw limitError();
    if (ancestors.has(value)) throw new TypeError("Cyclic kernel output");
    ancestors.add(value);
    for (const key of Object.keys(value)) {
      budget.units += key.length;
      measure(value[key], budget, depth + 1, ancestors);
    }
    ancestors.delete(value);
  }
  return budget.units;
}

function limitError() {
  return Object.assign(
    new RangeError(
      "Kernel output exceeded the accumulation budget (8 Mi UTF-16 per output, 24 Mi per notebook, 10,000 outputs). Previously accepted output is preserved; further output is not retained until outputs are cleared.",
    ),
    { code: "ERR_NOTEBOOK_OUTPUT_LIMIT" },
  );
}

function summarize(outputs) {
  let units = 0;
  try {
    for (const output of outputs) units += measure(output);
    return { units, count: outputs.length };
  } catch (error) {
    return { units: 0, count: outputs.length, error };
  }
}

class OutputBudget {
  constructor(getCells) {
    this.getCells = getCells;
    this.records = null;
    this.invalid = new Map();
    this.units = 0;
    this.count = 0;
  }

  reconcile() {
    if (!this.records) return;
    const cells = new Set(this.getCells());
    for (const cell of this.records.keys()) {
      if (!cells.has(cell)) this.remove(cell);
    }
    for (const cell of cells) this.add(cell);
  }

  add(cell) {
    if (this.records && !this.records.has(cell)) this.replace(cell);
  }

  remove(cell) {
    const record = this.records?.get(cell);
    if (!record) return;
    this.units -= record.units;
    this.count -= record.count;
    this.invalid.delete(cell);
    this.records.delete(cell);
  }

  replace(cell) {
    if (!this.records) return;
    this.remove(cell);
    const record = summarize(cell.outputs);
    this.records.set(cell, record);
    this.units += record.units;
    this.count += record.count;
    if (record.error) this.invalid.set(cell, record.error);
  }

  accept(cell, units, count) {
    const record = this.records?.get(cell);
    if (!record) return;
    record.units += units;
    record.count += count;
    this.units += units;
    this.count += count;
  }

  retained(excludedCell) {
    if (!this.records) {
      // Opening a file need not inspect its outputs for a limit on future
      // kernel messages. Initialize the counters only when receiving one.
      this.records = new Map();
      this.reconcile();
    }
    for (const [cell, error] of this.invalid) {
      if (cell !== excludedCell) throw error;
    }
    const excluded = this.records.get(excludedCell);
    return {
      units: this.units - (excluded?.units ?? 0),
      count: this.count - (excluded?.count ?? 0),
    };
  }
}

function assertOutput(cell, output, options = {}) {
  const perOutput = options.perOutput ?? PER_OUTPUT;
  const perDocument = options.perDocument ?? PER_DOCUMENT;
  const incoming = measure(output);
  const clearing = cell.hasPendingClear() || cell._clearOnNextOutput;
  const previous = !clearing && cell.outputs.at(-1);
  const merging =
    previous?.output_type === "stream" &&
    output?.output_type === "stream" &&
    previous.name === output.name;
  const previousUnits = merging ? measure(previous) : 0;
  if (incoming + previousUnits > perOutput) throw limitError();
  const retained =
    cell.outputBudget?.retained(clearing ? cell : null) ?? summarize(clearing ? [] : cell.outputs);
  if (retained.error) throw retained.error;
  if (retained.count + 1 > 10000 || retained.units + incoming > perDocument) throw limitError();
  return { incoming, previousUnits };
}

module.exports = { OutputBudget, assertOutput, measure };
