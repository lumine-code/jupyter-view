const HEADER = /^[ \t]*%%([A-Za-z_][A-Za-z0-9_]*|!)(?:[ \t]+.*)?$/;
function headerAt(line, row) {
  const match = HEADER.exec(line);
  return match ? { name: match[1], header: line, row } : null;
}

// Automatic language/header recognition is bounded independently of cell size.
// Oversized preludes or headers remain ordinary editable source.
function inspectPrefix(snapshot) {
  const inspectedEnd = Math.min(snapshot.length, 65536);
  let offset = 0;
  for (const chunk of snapshot.subtext(0, inspectedEnd).chunks()) {
    const match = /\S/.exec(chunk);
    if (match) {
      const row = snapshot.positionAt(offset + match.index).row;
      const start = snapshot.lineStart(row);
      let end = row + 1 < snapshot.lineCount ? snapshot.lineStart(row + 1) - 1 : snapshot.length;
      if (end > start && snapshot.charCodeAt(end - 1) === 13) end--;
      return {
        value: end - start <= 4096 ? headerAt(snapshot.slice(start, end), row) : null,
        end: Math.min(end, start + 4096),
      };
    }
    offset += chunk.length;
  }
  return { value: null, end: inspectedEnd };
}

function rootRanges(snapshot, { enabled = true } = {}) {
  if (!enabled) return null;
  const header = inspectPrefix(snapshot).value;
  if (!header) return null;
  const start =
    header.row + 1 < snapshot.lineCount ? snapshot.lineStart(header.row + 1) : snapshot.length;
  return [{ start: snapshot.positionAt(start), end: snapshot.positionAt(snapshot.length) }];
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

    const source = this.buffer.getTextSnapshot();
    const prefix = inspectPrefix(source);
    this.value = prefix.value;
    this.marker = this.layer.markRange([[0, 0], source.positionAt(prefix.end)], {
      invalidate: "touch",
      persistent: false,
    });
    return this.value;
  }

  destroy() {
    this.marker?.destroy();
    this.marker = null;
    this.layer.destroy();
  }
}

module.exports = { CellMagicPrefix, languageForMagic, rootRanges };
