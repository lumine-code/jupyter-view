// Runtime provenance is deliberately outside nbformat. A saved execution count
// alone does not prove which source was executed, and is never a cell index.
const documents = new WeakMap();
const outputContexts = new WeakMap();

function stateFor(document) {
  let state = documents.get(document);
  if (!state) {
    state = { targets: new WeakMap(), kernels: new WeakMap() };
    documents.set(document, state);
  }
  return state;
}

function beginExecution(document, target, kernel) {
  const cell = document?.cells?.find((candidate) => candidate.id === target?.id);
  if (!cell || !target || !kernel) return;
  const source = cell.source || "";
  const code = target.source || "";
  const submitted = code.replace(/\r?\n$/, "").split(/\r?\n/);
  const startRow = code === source ? 0 : target.row - submitted.length + 1;
  const actual = source.split(/\r?\n/).slice(startRow, startRow + submitted.length);
  const indents = actual.map((line, index) => {
    const expected = submitted[index];
    if (line === expected || (!line.trim() && !expected.trim())) return 0;
    const prefix = line.slice(0, line.length - expected.length);
    return expected && line.endsWith(expected) && /^\s*$/.test(prefix) ? prefix.length : null;
  });
  const valid =
    Number.isInteger(startRow) &&
    startRow >= 0 &&
    actual.length === submitted.length &&
    !indents.includes(null);
  const state = stateFor(document);
  let counts = state.kernels.get(kernel);
  if (!counts) state.kernels.set(kernel, (counts = new Map()));
  state.targets.set(target, {
    kernel,
    counts,
    snapshot: valid ? { cellId: cell.id, source, startRow, indents } : null,
  });
}

function recordCount(document, target, count) {
  const record = stateFor(document).targets.get(target);
  if (!record || !Number.isSafeInteger(count) || count < 1) return;
  if (record.executionCount === count) return;
  record.executionCount = count;
  if (count <= (Array.from(record.counts.keys()).at(-1) ?? 0)) record.counts.clear();
  record.counts.set(count, record.snapshot);
  while (record.counts.size > 200) record.counts.delete(record.counts.keys().next().value);
}

function recordOutput(document, target, output) {
  const record = stateFor(document).targets.get(target);
  if (!record || !output || typeof output !== "object") return;
  outputContexts.set(output, {
    kernel: record.kernel,
    current: record.snapshot,
    history: output.output_type === "error" ? new Map(record.counts) : null,
  });
}

function rangeFor(editor, snapshot, frame) {
  const cell = editor.document?.cells?.find((candidate) => candidate.id === snapshot?.cellId);
  if (!cell || cell.source !== snapshot.source || editor._destroyed) return null;
  const rowIndex = frame.line - 1;
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= snapshot.indents.length)
    return null;
  const row = snapshot.startRow + rowIndex;
  const line = snapshot.source.split(/\r?\n/)[row];
  const indent = snapshot.indents[rowIndex];
  const syntaxIndent = frame.sourceLine != null ? line.slice(indent).indexOf(frame.sourceLine) : 0;
  if (syntaxIndent < 0 || !/^\s*$/.test(line.slice(indent, indent + syntaxIndent))) return null;
  const column = frame.column == null ? 0 : frame.column + indent + syntaxIndent;
  if (column > line.length) return null;
  return [
    [row, column],
    [
      row,
      frame.endColumn == null
        ? column
        : Math.min(line.length, frame.endColumn + indent + syntaxIndent),
    ],
  ];
}

function optionsForOutput(editor, output) {
  const context = outputContexts.get(output);
  if (!context) return { outputScope: editor.document };
  return {
    outputScope: editor.document,
    kernel: context.kernel,
    resolveTracebackFrame(frame) {
      const snapshot =
        frame.executionCount != null
          ? context.history?.get(frame.executionCount)
          : /^(?:<string>|<stdin>)$/.test(frame.filename || "")
            ? context.current
            : null;
      if (!snapshot || !rangeFor(editor, snapshot, frame)) return null;
      return {
        title: "Go to the notebook cell that produced this frame",
        async open() {
          const range = rangeFor(editor, snapshot, frame);
          if (!range) {
            lumine.notifications.addWarning(
              "The cell changed since this execution. Run it again to update traceback links.",
            );
            return;
          }
          await editor.revealCellById(snapshot.cellId, range, () =>
            Boolean(rangeFor(editor, snapshot, frame)),
          );
        },
      };
    },
  };
}

module.exports = { beginExecution, recordCount, recordOutput, optionsForOutput };
