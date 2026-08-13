# jupyter.notebook

Exposes the open notebook documents and the active one, for packages that need notebook-aware behavior.

|             |                                                               |
| ----------- | ------------------------------------------------------------- |
| Version     | `1.1.0`                                                       |
| Provided by | `provideJupyterNotebook()` returning the document facade      |
| Consumed by | `consumeJupyterNotebook(notebooks)`                           |
| Owner       | [`jupyter-view`](https://github.com/lumine-code/jupyter-view) |

A package that needs to know a notebook is open — a language-server bridge, an exporter, an outline, a linter with notebook-specific rules — asks here, rather than duck-typing pane items. `ide-jupyter` consumes it to feed notebooks to language servers.

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

The document registry is the way to reach a notebook that is open but not focused. Treat what it holds as read-mostly: mutating a document behind the view's back leaves the two out of step.

Receiving this service means `jupyter-view` is installed, which is itself the useful signal for a package deciding whether to offer notebook-specific behavior at all.

## Teardown

Return a `Disposable` that drops your reference. Notebook documents and editors belong to `jupyter-view` — do not destroy them.

## Versioning

`1.1.0` provided. Consume `^1.0.0` for the polled facade, `^1.1.0` when depending on `getNotebookEditors` or the registry observers. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
