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
  if (incoming + (merging ? measure(previous) : 0) > perOutput) throw limitError();
  let total = incoming,
    count = 1;
  for (const sibling of cell.outputBudgetCells?.() ?? [cell]) {
    if (sibling === cell && clearing) continue;
    for (const retained of sibling.outputs ?? []) {
      total += measure(retained);
      if (++count > 10000 || total > perDocument) throw limitError();
    }
  }
  if (total > perDocument) throw limitError();
}

module.exports = { assertOutput, measure };
