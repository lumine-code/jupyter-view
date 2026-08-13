const { pathToFileURL, fileURLToPath } = require("url");

// The cell URI vocabulary, byte-identical to ide-client's: the scheme VS Code
// coined, the notebook's path in the path component, the cell id in the
// fragment. Implemented locally so the workspace opener can resolve a cell
// URI before — or without — the ide-client service being connected.
const CELL_SCHEME = "vscode-notebook-cell";

exports.CELL_SCHEME = CELL_SCHEME;

exports.buildCellUri = (notebookPath, cellId) => {
  const fileUri = pathToFileURL(notebookPath).href;
  return `${CELL_SCHEME}:${fileUri.slice("file:".length)}#${encodeURIComponent(cellId)}`;
};

exports.parseCellUri = (uri) => {
  if (!uri?.startsWith(`${CELL_SCHEME}:`)) return null;
  const rest = uri.slice(CELL_SCHEME.length + 1);
  const hash = rest.indexOf("#");
  if (hash === -1) return null;
  let notebookPath;
  try {
    notebookPath = fileURLToPath(`file:${rest.slice(0, hash)}`);
  } catch {
    return null;
  }
  let cellId = rest.slice(hash + 1);
  try {
    cellId = decodeURIComponent(cellId);
  } catch {
    /* A fragment that is not percent-encoded is its own name. */
  }
  return { notebookPath, cellId };
};
