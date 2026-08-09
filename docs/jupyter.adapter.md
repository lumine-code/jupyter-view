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
  onDidChangePath(callback: (path: string | null) => void): Disposable;

  // Targets
  getActiveTargetId(): string;
  setActiveTargetId(targetId: string): void;
  getTargetCount(): number;
  getSelectedTargetIds(): string[];
  getRunTargetIds(scope?: "selected" | string): string[];
  getRunTargets(scope?: "selected" | string): Target[];
  getRunTarget(targetId: string): Target;
  getTarget(targetId: string): Target;
  getTargetType(targetId: string): string;
  getNextRunTarget(target: Target): Target | null;

  // Kernel
  getKernelEditor(targetId?: string): TextEditor;
  getKernelGrammar(): Grammar;
  getKernelTarget(targetId?: string): Target;
  setKernelSpec(kernelSpec: object): void;
};
```

| Group    | Purpose                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------- |
| Identity | Where the item is, what it is called, and how to reach its DOM — so output can be placed beside a cell. |
| Targets  | The cells: how many, which are selected, which is active, and what runs next.                           |
| Kernel   | A `TextEditor` view of a target's source, so the REPL can send code and detect the language as usual.   |

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

**`getKernelEditor` is the load-bearing member.** It hands the REPL a `TextEditor` view of a cell's source, which is what lets grammar detection, kernel selection, and code transmission work without the REPL knowing anything about notebooks. An adapter that cannot produce one cannot be driven.

Target ids are opaque strings, not indices. `getNextRunTarget` is what advances "run this cell and move on", and returning `null` from it stops the sequence at the last cell rather than wrapping.

`getRunTargets(scope)` defaults to `"selected"`, which is what an ordinary run command wants; a "run all" command passes a different scope.

`onDidChangePath` exists because a notebook can be saved under a new name while cells are running, and the REPL keys some state on the path.

Adapters are per pane item, so a window with three notebooks has three of them.

## Teardown

Return a `Disposable` that drops your reference. The adapter and the notebook it wraps belong to `jupyter-view`; disposing your reference does not close anything.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
