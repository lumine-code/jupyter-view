const { Range } = require("lumine");

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

// Marker invalidation occurs before the language mode processes the edit.
// Public onDidChange runs after that, so it is too late to invalidate a cache
// consulted by the parser's root-range provider.
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
    const match = /^[ \t]*%%([A-Za-z_][A-Za-z0-9_]*|!)(?:[ \t]+.*)?$/.exec(line);
    this.value = match ? { name: match[1], header: line, row } : null;
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

  bodyRange() {
    const header = this.get();
    if (!header) return null;
    return new Range(this.buffer.clipPosition([header.row + 1, 0]), this.buffer.getEndPosition());
  }

  destroy() {
    this.marker?.destroy();
    this.marker = null;
    this.layer.destroy();
  }
}

module.exports = { CellMagicPrefix, languageForMagic };
