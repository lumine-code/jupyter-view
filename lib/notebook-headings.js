const cellSource = require("./cell-source");
const MAX_HEADINGS = 5000;
const LABEL_UNITS = 256;

// Navigation is a bounded presentation of document positions. Titles are
// explicit previews; an incomplete outline has a visible sentinel entry.
function collectHeadings(cells, { maxHeadings = MAX_HEADINGS, budgetMs = 16 } = {}) {
  const headings = [],
    deadline = performance.now() + budgetMs;
  const incomplete = (cellIndex, cellRow) => {
    headings.push({
      text: "Outline incomplete — more text remains",
      level: 1,
      classList: ["text-subtle"],
      cellIndex,
      cellRow,
      incomplete: true,
    });
    return headings;
  };
  for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
    const cell = cells[cellIndex];
    if (cell.type !== "markdown") continue;
    const source = cellSource.forCell(cell);
    for (let row = 0; row < source.lineCount; row++) {
      if ((row & 127) === 0 && performance.now() >= deadline) return incomplete(cellIndex, row);
      const start = source.lineStart(row);
      if (source.charCodeAt(start) !== 35) continue;
      const end = row + 1 < source.lineCount ? source.lineStart(row + 1) - 1 : source.length;
      let offset = start;
      while (offset < end && offset - start < 7 && source.charCodeAt(offset) === 35) offset++;
      const level = offset - start;
      if (level > 6 || offset === end || !/\s/.test(source.slice(offset, offset + 1))) continue;
      while (offset < end) {
        const part = source.slice(offset, Math.min(end, offset + 1024)),
          index = part.search(/\S/);
        if (index >= 0) {
          offset += index;
          break;
        }
        offset += part.length;
        if (performance.now() >= deadline) return incomplete(cellIndex, row);
      }
      if (offset === end) continue;
      let limit = Math.min(end, offset + LABEL_UNITS);
      if (
        limit < end &&
        source.charCodeAt(limit - 1) >= 0xd800 &&
        source.charCodeAt(limit - 1) <= 0xdbff &&
        source.charCodeAt(limit) >= 0xdc00 &&
        source.charCodeAt(limit) <= 0xdfff
      )
        limit--;
      headings.push({
        text: source.slice(offset, limit).trim() + (limit < end ? "…" : ""),
        level,
        classList: [],
        cellIndex,
        cellRow: row,
        preview: limit < end,
      });
      if (headings.length >= maxHeadings) return incomplete(cellIndex, row);
    }
  }
  return headings;
}
module.exports = { collectHeadings, MAX_HEADINGS, LABEL_UNITS };
