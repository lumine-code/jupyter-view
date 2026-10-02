# jupyter.notebook

Exposes the open notebook documents and the active one, for packages that need notebook-aware behavior.

|             |                                                               |
| ----------- | ------------------------------------------------------------- |
| Version     | `1.0.0`                                                       |
| Provided by | `provideJupyterNotebook()` returning the document facade      |
| Consumed by | `consumeJupyterNotebook(notebooks)`                           |
| Owner       | [`jupyter-view`](https://github.com/lumine-code/jupyter-view) |

A package that needs to know a notebook is open — an exporter, an outline, a linter with notebook-specific rules — asks here, rather than duck-typing pane items. The language-server bridge lives in this package and uses these same shapes internally.

To _execute_ notebook cells, use [`jupyter.adapter`](jupyter.adapter.md) instead.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "jupyter.notebook": {
      "versions": { "^1.0.0": "consumeJupyterNotebook" }
    }
  }
}
```

## Contract

```ts
type JupyterNotebook = {
  getActiveNotebook(): NotebookEditor | null;
  getDocumentRegistry(): DocumentRegistry;
  getNotebookEditors(document: NotebookDocument): NotebookEditor[];
  listNotebooks(options?: { offset?: number; limit?: number }): NotebookList;
  getNotebookSnapshot(options: {
    notebookId: string;
    offset?: number;
    limit?: number;
    sourceLimit?: number;
  }): Promise<NotebookSnapshot>;
  getCellSnapshot(options: {
    notebookId: string;
    cellId: string;
    sourceOffset?: number;
    sourceLimit?: number;
    outputOffset?: number;
    outputLimit?: number;
    includeOutputs?: boolean;
  }): Promise<CellSnapshot>;
  getNotebookRevision(notebookId: string): string;
  getExecutionSnapshot(options: {
    notebookId: string;
    cellIds?: string[];
    codeOnly?: boolean;
    maxCells?: number;
    maxSourceChars?: number;
  }): Promise<ExecutionSnapshot>;
  getExecutionAdapter(notebookId: string): NotebookAdapter;
  editCell(request: EditCellRequest): Promise<MutationResult>;
  saveNotebook(request: SaveNotebookRequest): Promise<MutationResult>;
  openNotebook(request: {
    path: string;
    expectedGeneration: string;
    operationId: string;
  }): Promise<NotebookSnapshot>;
  createNotebook(request: {
    expectedGeneration: string;
    operationId: string;
    language?: string;
  }): Promise<NotebookSnapshot>;
  onDidChangeNotebook(callback: (event: NotebookChange) => void): Disposable;
  waitForNotebookChange(
    request: { notebookId: string; afterRevision: string; timeoutMs?: number },
    context?: { signal?: AbortSignal },
  ): Promise<NotebookChange & { changed: boolean }>;
};
```

| Member                         | Description                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `getActiveNotebook()`          | The notebook editor in the active pane, or `null` when the active item is not one. |
| `getDocumentRegistry()`        | The registry of open notebook documents, for reaching ones that are not active.    |
| `getNotebookEditors(document)` | Every live notebook editor showing that document — one per split view.             |

The registry answers with documents and change notifications:

| Registry member                 | Description                                                            |
| ------------------------------- | ---------------------------------------------------------------------- |
| `getDocuments()`                | Every open notebook document.                                          |
| `getDocument(filePath)`         | The document for that path, or `undefined`.                            |
| `observeDocuments(callback)`    | Calls back with every current document, then with each one that opens. |
| `onDidAddDocument(callback)`    | A document was opened.                                                 |
| `onDidRemoveDocument(callback)` | A document was destroyed.                                              |

A notebook editor carries a `document` holding the cells, and a `view` for the rendered UI. A document handed out by `observeDocuments` may still be loading — its cells and metadata fill in through its own events (`onDidLoad`, `onDidReload`, `onDidChange`), so treat the document as live rather than reading it once.

The editor's `getFileTextEditor()` is the `.ipynb` identity used by file-oriented status controls. Its encoding is read-only UTF-8, while `getLineEndings()`, `setLineEnding(value)`, and `onDidChangeLineEndings(callback)` expose the physical LF/CRLF state that notebook saves preserve. `getActiveEmbeddedTextEditor()` returns a cell editor only in edit mode, so grammar UI is hidden in command mode.

Cell types and boundaries come from the notebook document. Code cells use original language packages; a Python cell does not interpret `# %%` comments as document boundaries. In Python notebooks, a leading cell magic selects the body grammar and excludes its header from syntax parsing through the editor's buffer-owned root ranges. The full header remains in saved and executed source. A manual cell language overrides body syntax without changing the shared notebook kernel.

Line magics, shell escapes and help syntax remain valid inputs to the IPython kernel but may produce Python parser errors in notebook cells. Full IPython document syntax belongs to `.ipy` files handled by `language-ipython`.

### Addressed automation

Automation targets `notebookId`, the live document's `id`, rather than the active notebook or its filename. `listNotebooks()` returns paginated summaries, including unsaved notebooks, their paths and URIs, language, file state and cell count. It also returns the provider `generation` token used by `createNotebook` and `openNotebook`. Closed or unloaded document generations reject requests. Opening a file requires an explicit absolute `.ipynb` path, `expectedGeneration` and `operationId`, and reuses an existing document.

Every summary has two opaque tokens. `revision` changes with notebook source, type, structure, metadata, reload or undo; runtime output and execution status do not invalidate it. `changeRevision` also changes with output/status, save and path events. Both include an instance UUID, so a token from before provider unload or file reopening cannot match a fresh generation. Source reads and revision checks flush pending source from every split view and the source controller first.

`getNotebookSnapshot` returns `{notebookId, revision, changeRevision, path, uri, language, fileState, modified, cellCount, offset, cells, truncated}`. Each cell has `{cellId, index, type, sourceRevision, source, executionCount, status, outputCount}`. `source` is `{text, offset, totalChars, truncated}`. Listing defaults to 50 cells, at most 100, with at most 1,000 source characters per cell. `getCellSnapshot` provides source pagination up to 65,536 characters and output pagination up to 25 entries; default limits are 16,000 characters and 10 outputs. Text, error and traceback previews are bounded to 2,000 characters per representation; binary outputs expose MIME type and size without base64. Reads never execute notebook code.

Execution consumers use `getExecutionSnapshot` rather than truncated read previews. It returns complete `{cellId, index, type, source: string, sourceRevision}` entries and the current notebook `revision`, or rejects if the requested bounds are exceeded. Optional `cellIds` selects stable IDs and `codeOnly: true` excludes Markdown and raw cells; selection happens before budgeting and preserves document order. Maximum bounds are 1,000 selected cells and 1,048,576 selected source characters. A single-cell run requests its own `cellIds`, while a full notebook run requests `codeOnly: true`, so unrelated or large Markdown content cannot block code execution. `getExecutionAdapter(notebookId)` returns the normal live notebook adapter, with ID `jupyter-view:<notebookId>`, without consulting the active pane. Before accepting a run, compare `getNotebookRevision(notebookId)` with the captured source revision; the execution package owns kernel selection and running code.

`editCell` requires `{notebookId, operationId, expectedRevision, operation}`. Operations are `insert`, `replace`, `move` and `delete`. Insert accepts optional `source` and `type`; replace requires a stable `cellId` and `source` or `type`; move and delete require `cellId`. Insert/move accept one `beforeCellId` or `afterCellId`, defaulting to the end. Types are `code`, `markdown` and `raw`. Source is limited to 1,000,000 characters. Deleting the final cell clears it and reports `cleared: true`, preserving the editor's one-cell invariant. Edits commit through the existing document/source controller, preserving undo, split-view updates, language-server synchronization and search adapters.

`saveNotebook` requires `{notebookId, operationId}` and accepts `expectedRevision`, `path` and `overwrite`. Unsaved notebooks require an absolute `.ipynb` path. An existing different destination or unresolved external file conflict requires explicit boolean `overwrite: true`; strings and other types are refused before filesystem work. All notebook tools reject unexpected arguments at runtime as well as declaring their schemas. Saves use the document's normal atomic save queue, preserving edits that arrive while writing. Failed Save As restores the previous file binding only while the attempted path and File identity still belong to that operation; concurrent human path and source changes win. No dialog chooses a path on behalf of automation.

Cell edits and saves retain up to 128 operation receipts per document; create/open share 128 receipts per provider. Receipts, including failures, remain for the entire generation. At capacity, new operations are refused while existing retries remain available. Retrying identical arguments returns the original result with `replayed: true`, or the original failure; reusing an ID with different arguments rejects. Concurrent retries share one operation. A fresh edit still requires the current source token after pending human edits have been flushed. Create/open require the provider generation from `listNotebooks`, preventing retry keys from creating duplicates after a provider reload. Retrying creation/open after its notebook closes rejects rather than opening another one.

`onDidChangeNotebook` publishes `{notebookId, revision, changeRevision, kind, cellIds}`, with `closed: true` when the document closes. `waitForNotebookChange` takes `afterRevision` from a read's **changeRevision**, not its source revision. It resolves immediately if a change has already occurred, otherwise waits for a live event or returns `changed: false` on timeout. The default wait is 20 seconds, maximum 25 seconds; at most eight waits may be pending per provider. An optional request-context `AbortSignal`, provider unload or client cancellation removes the timer and listener; a closed notebook reports a close event. Return and dispose subscriptions when a consumer unloads.

## Minimal example

```js
const { Disposable } = require("lumine");

module.exports = {
  consumeJupyterNotebook(notebooks) {
    this.notebooks = notebooks;
    return new Disposable(() => (this.notebooks = null));
  },

  activeNotebookPath() {
    return this.notebooks?.getActiveNotebook()?.getPath() ?? null;
  },
};
```

## Behavior

**The active notebook is polled — there is no change notification for it on this service.** Read it when you act, and drive any UI from the workspace's own `onDidChangeActivePaneItem` rather than expecting this service to tell you. Documents, by contrast, are observable: `observeDocuments` replays the current set and follows along.

`getActiveNotebook()` returns `null` whenever the active pane item is anything else, which is most of the time. It is a query, not a subscription.

The document registry is the way to reach a notebook that is open but not focused. Use the addressed edit/save methods for automation, rather than mutating a document behind the source controller.

Receiving this service means `jupyter-view` is installed, which is itself the useful signal for a package deciding whether to offer notebook-specific behavior at all.

## Teardown

Return a `Disposable` that drops your reference. Notebook documents and editors belong to `jupyter-view` — do not destroy them.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
