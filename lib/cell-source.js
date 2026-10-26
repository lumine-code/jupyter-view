const { TextBuffer } = require("lumine");

let empty;
function emptySource() {
  if (!empty) {
    const buffer = new TextBuffer();
    empty = buffer.getTextSnapshot();
    buffer.destroy();
  }
  return empty;
}

function isSnapshot(value) {
  return value && typeof value.chunks === "function" && typeof value.subtext === "function";
}

function snapshot(value = "") {
  if (isSnapshot(value)) return value;
  if (value?.type === "LumineText") {
    if (
      value.version !== 1 ||
      !Array.isArray(value.chunks) ||
      value.chunks.some((chunk) => typeof chunk !== "string" || chunk.length > 32768)
    )
      throw new TypeError("Invalid portable notebook source snapshot");
    const source = snapshot(value.chunks);
    if (!Number.isSafeInteger(value.length) || source.length !== value.length)
      throw new TypeError("Notebook source snapshot length mismatch");
    return source;
  }
  if (Array.isArray(value)) {
    let source = emptySource();
    for (const part of value) source = source.replace(source.length, source.length, part);
    return source;
  }
  return emptySource().replace(0, 0, value || "");
}

function fromNotebook(cell) {
  return snapshot(cell.sourceSnapshot ?? cell.source ?? "");
}

function forCell(cell) {
  return cell?.getSourceSnapshot?.() ?? fromNotebook(cell ?? {});
}

function equal(left, right) {
  return snapshot(left).equals(snapshot(right));
}

function notebookSource(source) {
  source = snapshot(source);
  if (source.length > 65536) return Array.from(source.chunks());
  return source
    .toString()
    .split("\n")
    .map((line, index, lines) => (index < lines.length - 1 ? line + "\n" : line))
    .filter((line) => line !== "");
}

module.exports = { snapshot, isSnapshot, fromNotebook, forCell, equal, notebookSource };
