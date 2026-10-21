const HEADER = /^[ \t]*%%([A-Za-z_][A-Za-z0-9_]*|!)(?:[ \t]+.*)?$/;
function headerAt(line, row) {
  const match = HEADER.exec(line);
  return match ? { name: match[1], header: line, row } : null;
}

function rootRanges(snapshot, { enabled = true } = {}) {
  if (!enabled) return null;
  let offset = 0;
  for (const chunk of snapshot.chunks()) {
    const match = /\S/.exec(chunk);
    if (match) {
      const row = snapshot.positionAt(offset + match.index).row;
      const header = headerAt(snapshot.lines(row, row + 1).next().value, row);
      if (!header) return null;
      const start = row + 1 < snapshot.lineCount ? snapshot.lineStart(row + 1) : snapshot.length;
      return [{ start: snapshot.positionAt(start), end: snapshot.positionAt(snapshot.length) }];
    }
    offset += chunk.length;
  }
  return null;
}

// These are syntax languages, never kernel languages. Names are case-sensitive
// because IPython also permits custom magics.
const LANGUAGES = new Map([
  ...[
    "time",
    "timeit",
    "prun",
    "debug",
    "capture",
    "code_wrap",
    "python",
    "python2",
    "python3",
    "pypy",
  ].map((name) => [name, "python"]),
  ...["bash", "sh", "sx", "system", "!"].map((name) => [name, "shell"]),
  ["html", "html"],
  ["HTML", "html"],
  ["markdown", "markdown"],
  ["latex", "latex"],
  ["javascript", "javascript"],
  ["js", "javascript"],
  ["svg", "xml"],
  ["SVG", "xml"],
  ["perl", "perl"],
  ["ruby", "ruby"],
]);

function languageForMagic(name) {
  return LANGUAGES.get(name) || "text.plain";
}

// The renderer caches header decorations and grammar choice with a marker.
// The parser owner uses the same recognizer against its immutable snapshot.
class CellMagicPrefix {
  constructor(buffer) {
    this.buffer = buffer;
    this.layer = buffer.addMarkerLayer({ maintainHistory: false, persistent: false });
    this.marker = null;
    this.value = null;
  }

  get() {
    if (this.marker && !this.marker.isDestroyed() && this.marker.isValid()) return this.value;
    this.marker?.destroy();

    const lastRow = this.buffer.getLastRow();
    let row = 0;
    let line = this.buffer.lineForRow(row);
    while (row < lastRow && !line.trim()) line = this.buffer.lineForRow(++row);
    this.value = headerAt(line, row);
    this.marker = this.layer.markRange(
      [
        [0, 0],
        [row, line.length],
      ],
      {
        invalidate: "touch",
        persistent: false,
      },
    );
    return this.value;
  }

  destroy() {
    this.marker?.destroy();
    this.marker = null;
    this.layer.destroy();
  }
}

module.exports = { CellMagicPrefix, languageForMagic, rootRanges };
