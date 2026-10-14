// Asking whether a pane item is a notebook must not load notebook models,
// views or execution code for an ordinary text editor or an empty workspace.
function isNotebookEditor(item) {
  if (item?.constructor?.name === "JupyterNotebookEditor") return true;
  if (typeof item?.getCellEditor !== "function") return false;
  const JupyterNotebookEditor = require("./jupyter-notebook-editor");
  return item instanceof JupyterNotebookEditor;
}

module.exports = class JupyterAdapterService {
  handlesItem(item) {
    return isNotebookEditor(item);
  }

  getAdapterForItem(item) {
    if (!this.handlesItem(item)) return null;
    const JupyterAdapter = require("./notebook-execution-adapter");
    return new JupyterAdapter(item);
  }

  getActiveAdapter() {
    return this.getAdapterForItem(lumine.workspace.getCenter().getActivePaneItem());
  }
};
