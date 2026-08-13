const path = require("path");
const { buildCellUri, parseCellUri, CELL_SCHEME } = require("../lib/cell-uri");

// This vocabulary must stay byte-identical to ide-client's: the hub mints the
// URIs, this package's opener resolves them, and the two never compare notes.
describe("cell URIs", () => {
  it("round trips a notebook path and cell id", () => {
    const notebookPath = path.resolve("a folder", "note book #1.ipynb");
    const uri = buildCellUri(notebookPath, "1f3a-b2");
    expect(uri.startsWith(`${CELL_SCHEME}:`)).toBe(true);
    expect(parseCellUri(uri)).toEqual({ notebookPath, cellId: "1f3a-b2" });
  });

  it("declines anything that is not a cell URI", () => {
    expect(parseCellUri("file:///C:/x.ipynb")).toBeNull();
    expect(parseCellUri(`${CELL_SCHEME}:///C:/x.ipynb`)).toBeNull();
    expect(parseCellUri(undefined)).toBeNull();
  });

  it("keeps the notebook's own path component", () => {
    const notebookPath = path.resolve("proj", "nb.ipynb");
    const fileHalf = require("url").pathToFileURL(notebookPath).href.slice("file:".length);
    expect(buildCellUri(notebookPath, "c1")).toBe(`${CELL_SCHEME}:${fileHalf}#c1`);
  });
});
