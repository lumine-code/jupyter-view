// Runtime provenance is deliberately outside nbformat. A saved execution count
// alone does not prove which source was executed, and is never a cell index.
const documents = new WeakMap();
const outputContexts = new WeakMap();

function stateFor(document) {
  let state = documents.get(document);
  if (!state) {
    state = { targets: new WeakMap(), kernels: new WeakMap(), subscriptions: new Set() };
    documents.set(document, state);
    document.onDidDestroy?.(() => {
      for (const subscription of state.subscriptions) subscription.dispose();
      state.subscriptions.clear();
      documents.delete(document);
    });
  }
  return state;
}

function kernelState(document, kernel) {
  const documentState = stateFor(document);
  let state = documentState.kernels.get(kernel);
  const transport = kernel.transport || null;
  const generation = transport?._connectionGeneration ?? null;
  if (!state) {
    state = { transport, generation, epoch: 0, counts: new Map(), subscription: null };
    documentState.kernels.set(kernel, state);
  } else if (state.transport !== transport || state.generation !== generation) {
    state.counts = new Map();
    state.epoch++;
    state.generation = generation;
    if (state.transport !== transport) {
      state.subscription?.dispose();
      documentState.subscriptions.delete(state.subscription);
      state.subscription = null;
      state.transport = transport;
    }
  }
  if (!state.subscription && kernel.onDidChangeExecutionState) {
    state.subscription = kernel.onDidChangeExecutionState((status) => {
      if (["restarting", "shutting-down", "dead"].includes(status)) {
        state.counts = new Map();
        state.epoch++;
      }
    });
    documentState.subscriptions.add(state.subscription);
  }
  return state;
}

function sourceFrame(frame) {
  if (!frame || !Number.isInteger(frame.line) || frame.line < 1) return null;
  const input = /^<ipython-input-(\d+)-[^>]+>$/.exec(frame.filename || "");
  const executionCount = frame.executionCount ?? (input ? Number(input[1]) : null);
  if (!Number.isSafeInteger(executionCount) || executionCount < 1) return null;
  if (input && Number(input[1]) !== executionCount) return null;
  const firstLine =
    typeof frame.source === "string" && frame.source
      ? frame.source.split(/\r?\n/)[0]
      : frame.sourceLine;
  if (firstLine != null && typeof firstLine !== "string") return null;
  return { ...frame, executionCount, ...(firstLine != null ? { sourceLine: firstLine } : {}) };
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
  const counts = kernelState(document, kernel).counts;
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

function resolveSourceFrame(editor, kernel, frame) {
  if (
    !editor?.document ||
    editor._destroyed ||
    editor.document._destroyed ||
    !kernel ||
    (typeof kernel !== "object" && typeof kernel !== "function") ||
    kernel._destroyed ||
    kernel.destroyed ||
    kernel.transport?._destroyed
  )
    return null;
  const location = sourceFrame(frame);
  if (!location || !documents.get(editor.document)?.kernels.has(kernel)) return null;
  const state = kernelState(editor.document, kernel);
  const snapshot = state.counts.get(location.executionCount);
  const epoch = state.epoch;
  const transport = state.transport;
  const generation = state.generation;
  const range = () => {
    const selected = rangeFor(editor, snapshot, location);
    if (!selected) return null;
    if (location.sourceLine != null) {
      const index = location.line - 1;
      const line = snapshot.source.split(/\r?\n/)[snapshot.startRow + index];
      if (line.slice(snapshot.indents[index]).trim() !== location.sourceLine.trim()) return null;
    }
    return selected;
  };
  const isCurrent = () => {
    if (typeof frame.isCurrent === "function" && !frame.isCurrent()) return false;
    if (
      editor._destroyed ||
      editor.document?._destroyed ||
      kernel._destroyed ||
      kernel.destroyed ||
      kernel.transport?._destroyed
    )
      return false;
    const current = kernelState(editor.document, kernel);
    const lifecycle = kernel.transport?.lifecycle ?? kernel.executionState;
    return (
      !["loading", "recovering", "unresponsive", "restarting", "shutting-down", "dead"].includes(
        lifecycle,
      ) &&
      current.transport === transport &&
      current.generation === generation &&
      current.epoch === epoch &&
      current.counts.get(location.executionCount) === snapshot &&
      (frame.generation == null || frame.generation === generation)
    );
  };
  if (!snapshot || !isCurrent() || !range()) return null;
  return {
    title: "Go to the notebook cell defining this symbol",
    async open() {
      const selected = isCurrent() && range();
      if (!selected) {
        lumine.notifications.addWarning(
          "The cell or kernel changed. Request the definition again.",
        );
        return;
      }
      await editor.revealCellById(snapshot.cellId, selected, () => Boolean(isCurrent() && range()));
    },
  };
}

module.exports = {
  beginExecution,
  recordCount,
  recordOutput,
  optionsForOutput,
  resolveSourceFrame,
};
