# jupyter.adapter

Lets the REPL run cells in something that is not a text editor, by describing that item's cells as run targets.

|             |                                                               |
| ----------- | ------------------------------------------------------------- |
| Version     | `1.0.0`                                                       |
| Provided by | `provideJupyterAdapter()` returning an adapter instance       |
| Consumed by | `consumeJupyterAdapter(adapter)`                              |
| Owner       | [`jupyter-view`](https://github.com/lumine-code/jupyter-view) |

`jupyter-repl` runs code by reading cells out of a `TextEditor`. An adapter supplies the same information for a notebook, so the REPL's ordinary run commands work unchanged and their output, execution counts, focus, and navigation route back into the notebook UI.

The contract is owned by `jupyter-view` because it is the notebook side that defines what a run target is.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "jupyter.adapter": {
      "versions": { "^1.0.0": "consumeJupyterAdapter" }
    }
  }
}
```

The service is an adapter **class instance created per pane item** — construct one per notebook editor rather than treating the service as a singleton.

## Contract

```ts
type JupyterAdapter = {
  // Identity
  getPaneItem(): object;
  getElement(): HTMLElement;
  getPath(): string | null;
  getTitle(): string;
  getAdapterId(): string;
  getMetadata(): object;
  getKernelOwner(): NotebookDocument;
  onDidChangePath(callback: (path: string | null) => void): Disposable;

  // Targets
  getActiveTargetId(): string | null;
  setActiveTargetId(targetId: string): void;
  getTargetCount(): number;
  getSelectedTargetIds(): string[];
  getRunTargetIds(scope?: "selected" | string): string[];
  getRunTargets(scope?: "selected" | string): Target[];
  getRunTarget(targetId: string): Target;
  getTarget(targetId: string): CellModel;
  getTargetType(targetId: string): string;
  getNextRunTarget(target: Target): Target | null;

  // Kernel
  getKernelEditor(targetId?: string): TextEditor;
  getKernelLanguage(kernelSpec?: object): string;
  getKernelGrammar(kernelSpec?: object): Grammar;
  getKernelTarget(targetId?: string): Target;
  setKernelSpec(kernelSpec: object, languageInfo?: object): boolean;
};

type Target = {
  id: string; // Stable nbformat cell id.
  index: number; // Position snapshot; consumers must not use it as identity.
  executable: boolean;
  source: string;
  editor: TextEditor;
  grammar: Grammar; // Syntax grammar of this cell, not the kernel language.
};
```

| Group    | Purpose                                                                                   |
| -------- | ----------------------------------------------------------------------------------------- |
| Identity | Where the item is, what it is called, and the shared document that owns a kernel binding. |
| Targets  | The cells: how many, which are selected, which is active, and what runs next.             |
| Kernel   | The notebook's execution language and the editor context used to send code.               |

## Minimal example

```js
const { Disposable } = require("lumine");

module.exports = {
  consumeJupyterAdapter(adapter) {
    this.adapter = adapter;
    return new Disposable(() => (this.adapter = null));
  },
};
```

## Behavior

**`getKernelEditor` is the load-bearing member.** It hands the REPL a `TextEditor` view of a cell's source for code transmission and editor context. Kernel selection must use `getKernelLanguage()` or `getKernelGrammar()`, never that editor's grammar, because a cell may carry an independent syntax override.

`getKernelLanguage(kernelSpec)` treats an explicitly supplied, discovered kernelspec as authoritative. Without one it reads the notebook metadata in this order: `kernelspec.language`, `language_info.name`, CodeMirror/MIME/extension hints, a recognizable kernelspec name, then Python. `getKernelGrammar(kernelSpec)` maps that language to a Lumine grammar and returns Plain Text when none is installed.

`setKernelSpec(kernelSpec, languageInfo)` is the successful-binding commit point. It writes the kernelspec and replaces the complete `language_info` object in one notebook metadata update; callers must not invoke it for a cancelled or failed connection.

Target ids are stable nbformat cell ids. `Target.index` is only the cell's position when the target snapshot was created; delayed callbacks resolve `Target.id` again, so insertion, deletion or reordering cannot redirect results into another cell. `getNextRunTarget` is what advances "run this cell and move on", and returning `null` from it stops the sequence at the last cell rather than wrapping.

`getRunTargets(scope)` defaults to `"selected"`, which is what an ordinary run command wants; a "run all" command passes a different scope.

`onDidChangePath` exists because a notebook can be saved under a new name while cells are running, and the REPL keys some state on the path.

Adapters are per pane item, so a window with three notebooks has three of them.

`getKernelOwner()` is different: every split of one notebook returns the same document. Kernel bindings and lifecycle subscriptions belong to that owner, whose `id`, `getPath()`, `onDidChangePath()`, `onDidDestroy()`, and `isDestroyed()` remain stable until the last split closes.

`getAdapterId()` is document-stable too: every split reports `jupyter-view:<document-id>` rather than inventing a pane-specific identity.

## Teardown

Return a `Disposable` that drops your reference. The adapter and the notebook it wraps belong to `jupyter-view`; disposing your reference does not close anything.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
