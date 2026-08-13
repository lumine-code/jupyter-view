/**
 * CellModel - Data model for individual notebook cells
 */

const { Emitter } = require("lumine");
const Anser = require("anser");

function sourceToNotebookLines(source) {
  return (source || "")
    .split("\n")
    .map((line, i, arr) => (i < arr.length - 1 ? line + "\n" : line))
    .filter((line) => line !== "");
}

function asPlainText(value) {
  const text = Array.isArray(value) ? value.join("") : value || "";
  return Anser.ansiToText(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function escapeCarriageReturn(text) {
  if (!text || typeof text !== "string") return text;

  const lines = text.split("\n");
  const result = [];

  for (const line of lines) {
    if (!line.includes("\r")) {
      result.push(line);
      continue;
    }

    const segments = line.split("\r");
    let currentLine = "";

    for (const segment of segments) {
      if (segment === "") {
        currentLine = "";
      } else {
        currentLine = segment + currentLine.slice(segment.length);
      }
    }
    result.push(currentLine);
  }

  return result.join("\n");
}

function getOutputText(output) {
  if (!output) return "";
  if (output.output_type === "stream") {
    return asPlainText(output.text);
  }
  if (output.output_type === "error") {
    return asPlainText(
      [output.ename, output.evalue, ...(output.traceback || [])].filter(Boolean).join("\n"),
    );
  }
  const data = output.data || {};
  const text = data["text/plain"] || data["text/html"] || data["text/markdown"];
  return asPlainText(text);
}

class CellModel {
  constructor({ id, type, source, outputs, executionCount, metadata }) {
    this.id = id;
    this.type = type || "code";
    this.source = source || "";
    this.sourceRevision = 0;
    this.outputs = outputs || [];
    this.executionCount = executionCount;
    this.metadata = metadata || {};
    this.outputVisible = true;
    this.inputVisible = true;
    this.status = null; // null | "running"
    this.startTime = null;
    this.lastRunTime = null;
    this.lastRunTimeText = null;
    this._clearOnNextOutput = false;
    this.emitter = new Emitter();
  }

  _emitChange(category, reason) {
    this.emitter.emit("did-change", { category, reason });
  }

  setRunning() {
    // Defer flipping status to "running" so cells that finish in <50ms never
    // show the loader — avoids a visible flash on instant cells.  startTime is
    // recorded immediately so lastRunTime stays accurate.
    this.startTime = performance.now();
    this.lastRunTime = null;
    this.lastRunTimeText = null;
    if (this._runningTimer) clearTimeout(this._runningTimer);
    this._runningTimer = setTimeout(() => {
      this._runningTimer = null;
      if (this.startTime === null) return;
      this.status = "running";
      this._emitChange("transient", "running-status");
    }, 50);
  }

  clearRunning() {
    if (this._runningTimer) {
      clearTimeout(this._runningTimer);
      this._runningTimer = null;
    }
    // If execution finished without producing any output, the scheduled clear
    // is still pending: flush its output wipe now so we don't leave stale
    // previous-run outputs lingering after the cell has visibly completed.
    // executionCount is *not* touched: the new run's count was set via
    // setExecutionCount before clearRunning ran, and that's what we want to
    // keep displayed.
    const clearedPendingOutputs = !!this._pendingClearTimer;
    if (this._pendingClearTimer) {
      clearTimeout(this._pendingClearTimer);
      this._pendingClearTimer = null;
      this._pendingClearOptions = null;
      this.outputs = [];
    }
    if (this.startTime !== null) {
      this.lastRunTime = performance.now() - this.startTime;
    }
    this.status = null;
    this.startTime = null;
    this._emitChange(
      clearedPendingOutputs ? "runtime" : "transient",
      clearedPendingOutputs ? "clear-outputs" : "running-status",
    );
  }

  resetTimer() {
    if (this._runningTimer) {
      clearTimeout(this._runningTimer);
      this._runningTimer = null;
    }
    this.status = null;
    this.startTime = null;
    this.lastRunTime = null;
    this.lastRunTimeText = null;
    this._emitChange("transient", "runtime-timer");
  }

  setLastRunTime(lastRunTime, lastRunTimeText = null) {
    this.lastRunTime = lastRunTime;
    this.lastRunTimeText = lastRunTimeText;
    this._emitChange("transient", "runtime-timer");
  }

  setType(type) {
    if (["code", "markdown", "raw"].includes(type)) {
      this.type = type;
      if (type !== "code") {
        this.outputs = [];
        this.executionCount = null;
      }
      this._emitChange("history", "cell-type");
    }
  }

  setSource(source) {
    this.source = source;
    this.sourceRevision++;
    this._emitChange("history", "cell-source");
  }

  /**
   * The cell's own language id, when a grammar was picked for it explicitly.
   * Stored under metadata.vscode.languageId — the key VS Code reads and
   * writes for per-cell language overrides — so it survives the file.
   */
  getLanguage() {
    return this.metadata?.vscode?.languageId || null;
  }

  setLanguage(languageId) {
    const normalized = languageId || null;
    if (this.getLanguage() === normalized) return;

    if (normalized) {
      this.metadata = {
        ...this.metadata,
        vscode: { ...this.metadata?.vscode, languageId: normalized },
      };
    } else {
      const vscode = { ...this.metadata?.vscode };
      delete vscode.languageId;
      this.metadata = { ...this.metadata };
      if (Object.keys(vscode).length > 0) {
        this.metadata.vscode = vscode;
      } else {
        delete this.metadata.vscode;
      }
    }
    this._emitChange("history", "cell-language");
  }

  setExecutionCount(count) {
    this.executionCount = count;
    this._emitChange("runtime", "execution-count");
  }

  /**
   * Add output to the cell. Adjacent streams with the same name are merged.
   */
  addOutput(output) {
    this._flushPendingClear();
    if (this._clearOnNextOutput) {
      this._clearOnNextOutput = false;
      this.outputs = [];
    }
    const previous = this.outputs[this.outputs.length - 1];
    if (
      previous &&
      previous.output_type === "stream" &&
      output?.output_type === "stream" &&
      previous.name === output.name
    ) {
      const previousText = Array.isArray(previous.text)
        ? previous.text.join("")
        : previous.text || "";
      const nextText = Array.isArray(output.text) ? output.text.join("") : output.text || "";
      previous.text = escapeCarriageReturn(previousText + nextText);
    } else if (output) {
      this.outputs.push(output);
    }

    this._emitChange("runtime", "cell-output");
  }

  /**
   * Handle a kernel clear_output message (IPython.display.clear_output).
   * Only wipes outputs: execution count and runtime status stay intact.
   * With wait=true the clear is deferred until the next output arrives,
   * so live-updating loops don't flicker.
   */
  applyClearOutput(wait = false) {
    if (wait) {
      this._clearOnNextOutput = true;
      return;
    }
    this._clearOnNextOutput = false;
    this._flushPendingClear();
    this.outputs = [];
    this._emitChange("runtime", "clear-outputs");
  }

  clearOutputs(options = {}) {
    if (this._pendingClearTimer) {
      clearTimeout(this._pendingClearTimer);
      this._pendingClearTimer = null;
      this._pendingClearOptions = null;
    }
    this._clearOnNextOutput = false;
    this.outputs = [];
    this.executionCount = null;
    if (!options.preserveRuntime) {
      this.status = null;
      this.startTime = null;
      this.lastRunTime = null;
      this.lastRunTimeText = null;
    }
    this._emitChange("runtime", "clear-outputs");
  }

  // Defer wiping the *previous run's* outputs so instant cells don't flash
  // an empty output area between "previous outputs" and "new outputs".  The
  // new run's executionCount is set independently via setExecutionCount and
  // must not be touched here, otherwise the new [N] indicator gets nulled
  // back to empty.  If new output arrives before the timer fires, addOutput
  // flushes the wipe synchronously so the new output replaces (not appends
  // to) the previous run.  If the timer fires with no new output, the wipe
  // happens at the scheduled time.
  scheduleClearOutputs(options = {}, delayMs = 50) {
    if (this._pendingClearTimer) clearTimeout(this._pendingClearTimer);
    this._pendingClearOptions = options;
    this._pendingClearTimer = setTimeout(() => {
      this._pendingClearTimer = null;
      this._pendingClearOptions = null;
      this.outputs = [];
      this._emitChange("runtime", "clear-outputs");
    }, delayMs);
  }

  _flushPendingClear() {
    if (!this._pendingClearTimer) return;
    clearTimeout(this._pendingClearTimer);
    this._pendingClearTimer = null;
    this._pendingClearOptions = null;
    this.outputs = [];
  }

  hasPendingClear() {
    return this._pendingClearTimer !== null && this._pendingClearTimer !== undefined;
  }

  toggleOutputVisibility() {
    this.outputVisible = !this.outputVisible;
    this._emitChange("transient", "output-visibility");
  }

  toggleInputVisibility() {
    this.inputVisible = !this.inputVisible;
    this._emitChange("transient", "input-visibility");
  }

  getDisplaySource() {
    return this.source;
  }

  hasOutput() {
    return this.outputs && this.outputs.length > 0;
  }

  /**
   * Get plain text representation of outputs
   */
  getOutputText() {
    return (this.outputs || []).map(getOutputText).filter(Boolean).join("\n");
  }

  /**
   * Convert cell to notebook JSON format
   */
  toJSON() {
    const cell = {
      id: this.id,
      cell_type: this.type,
      metadata: this.metadata,
      source: sourceToNotebookLines(this.source),
    };

    if (this.type === "code") {
      cell.execution_count = this.executionCount;
      cell.outputs = this.outputs || [];
    }

    return cell;
  }

  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  destroy() {
    this.emitter.dispose();
  }
}

module.exports = CellModel;
