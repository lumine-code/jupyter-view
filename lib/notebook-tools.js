const read = { readOnlyHint: true, openWorldHint: false };
const write = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};
const notebookId = {
  type: "string",
  description: "Explicit notebookId returned by ListJupyterNotebooks.",
};
const cellId = { type: "string", description: "Stable cellId returned by GetJupyterNotebook." };
const operationId = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  description: "Unique retry key; reuse only with identical arguments.",
};
const expectedRevision = {
  type: "string",
  description: "Opaque source revision returned by the notebook read. Re-read after conflict.",
};
const integer = (maximum, description) => ({ type: "integer", minimum: 0, maximum, description });
const schema = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

function notebookTools(control) {
  return [
    {
      name: "ListJupyterNotebooks",
      description:
        "List live notebook IDs, paths, languages, source revisions and changeRevision tokens; includes unsaved notebooks. Never assumes the active notebook.",
      annotations: read,
      inputSchema: schema({
        offset: integer(Number.MAX_SAFE_INTEGER, "Notebook pagination offset."),
        limit: integer(100, "Maximum notebooks, default 50."),
      }),
      execute: control.listNotebooks,
    },
    {
      name: "GetJupyterNotebook",
      description:
        "Read a live notebook by ID with paginated cells and bounded source previews; includes source revision, changeRevision, cell IDs and execution state.",
      annotations: read,
      inputSchema: schema(
        {
          notebookId,
          offset: integer(Number.MAX_SAFE_INTEGER, "Cell pagination offset."),
          limit: integer(100, "Maximum cells, default 50."),
          sourceLimit: integer(1000, "Preview characters per cell, default 1000."),
        },
        ["notebookId"],
      ),
      execute: control.getNotebookSnapshot,
    },
    {
      name: "GetJupyterCell",
      description:
        "Read one stable notebook cell, paginating source and stored outputs. Binary output representations report type and size without returning base64.",
      annotations: read,
      inputSchema: schema(
        {
          notebookId,
          cellId,
          sourceOffset: integer(Number.MAX_SAFE_INTEGER, "Source character offset."),
          sourceLimit: integer(65536, "Maximum source characters, default 16000."),
          outputOffset: integer(Number.MAX_SAFE_INTEGER, "Output pagination offset."),
          outputLimit: integer(25, "Maximum outputs, default 10."),
          includeOutputs: { type: "boolean", default: true },
        },
        ["notebookId", "cellId"],
      ),
      execute: control.getCellSnapshot,
    },
    {
      name: "EditJupyterCell",
      description:
        "Insert, replace source/type, move or delete a cell through live notebook undo and editor integrations. Requires current source revision and operationId. Insert/move use beforeCellId or afterCellId, default append; deleting the final cell clears it.",
      annotations: write,
      inputSchema: schema(
        {
          notebookId,
          cellId,
          operationId,
          expectedRevision,
          operation: { enum: ["insert", "replace", "move", "delete"] },
          source: { type: "string", maxLength: 1000000 },
          type: { enum: ["code", "markdown", "raw"] },
          beforeCellId: cellId,
          afterCellId: cellId,
        },
        ["notebookId", "operation", "expectedRevision", "operationId"],
      ),
      execute: control.editCell,
    },
    {
      name: "SaveJupyterNotebook",
      description:
        "Save the live notebook through its document's atomic save path. An unsaved notebook requires an absolute .ipynb path. Replacing another file or resolving external conflicts requires overwrite:true. Retry with the same operationId and arguments.",
      annotations: write,
      inputSchema: schema(
        {
          notebookId,
          operationId,
          expectedRevision,
          path: { type: "string" },
          overwrite: { type: "boolean", default: false },
        },
        ["notebookId", "operationId"],
      ),
      execute: control.saveNotebook,
    },
    {
      name: "OpenJupyterNotebook",
      description:
        "Open an existing absolute .ipynb path through the live notebook editor. expectedGeneration comes from ListJupyterNotebooks; operationId preserves retry receipts. Reuses an open document and refuses retry after it closes.",
      annotations: { ...write, destructiveHint: false },
      inputSchema: schema(
        {
          path: { type: "string", description: "Absolute path to an existing .ipynb file." },
          operationId,
          expectedGeneration: { type: "string" },
        },
        ["path", "expectedGeneration", "operationId"],
      ),
      execute: control.openNotebook,
    },
    {
      name: "CreateJupyterNotebook",
      description:
        "Create a live unsaved notebook. expectedGeneration is the generation from ListJupyterNotebooks; operationId prevents duplicate notebooks on retries in that provider generation.",
      annotations: { ...write, destructiveHint: false },
      inputSchema: schema(
        {
          operationId,
          expectedGeneration: { type: "string" },
          language: { type: "string", maxLength: 80, default: "python" },
        },
        ["operationId", "expectedGeneration"],
      ),
      execute: control.createNotebook,
    },
    {
      name: "WaitForJupyterNotebookChange",
      description:
        "Wait at most 25 seconds for source, execution output/status, save/path or close changes. afterRevision must be the changeRevision token from a read, not the source revision used by edits. At most eight waits are pending; disconnect/cancellation removes the listener.",
      annotations: read,
      inputSchema: schema(
        {
          notebookId,
          afterRevision: {
            type: "string",
            description: "The changeRevision from the latest notebook read.",
          },
          timeoutMs: integer(25000, "Wait duration, default 20000 ms."),
        },
        ["notebookId", "afterRevision"],
      ),
      execute: (args, context) => control.waitForNotebookChange(args, context),
    },
  ];
}

module.exports = { notebookTools };
