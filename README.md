# jupyter-view

Open and edit Jupyter notebooks.

## Features

- **Notebook editing**: open and edit `.ipynb` files with a cell-based interface, command/edit modes, and keyboard-driven navigation.
- **Cell operations**: insert, delete, move, merge, cut, copy, paste, duplicate, change type, and reorder cells by drag and drop.
- **Rich output**: render stored notebook outputs — text, images, SVG, HTML, LaTeX, markdown, plotly and vega, with ANSI color — through jupyter-repl's renderers.
- **Multi-select and history**: anchor-based multi-cell selection and buffer-based undo/redo of notebook edits.
- **Execution integration**: run cells through the jupyter-repl kernel engine via the `jupyter.adapter` service, with per-cell run buttons and live execution status.
- **Notebook search**: search and replace cell source through the search-panel package, entering edit mode on the matching cell.
- **Open source**: open any `.ipynb` as plain JSON text from an active notebook or the tree-view.
- **Editor integrations**: expose cells to linter, navigation, and scrollmap adapters so headings, selection, and diagnostics appear on the scrollbar.
- **Export**: save notebooks as Python scripts or HTML.

## Installation

To install `jupyter-view` search for _jupyter-view_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/jupyter-view`.

## Commands

Commands available in `lumine-workspace`:

- `jupyter-view:toggle`: toggle the active notebook item,
- `jupyter-view:new-notebook`: create a new notebook,
- `jupyter-view:scroll-up`: scroll the notebook up by one page,
- `jupyter-view:scroll-down`: scroll the notebook down by one page,
- `jupyter-view:open-source`: open the active notebook as plain text,
- `jupyter-view:clear-output`: clear active cell output,
- `jupyter-view:clear-all-outputs`: clear all outputs,
- `jupyter-view:insert-cell-above`: insert cell above,
- `jupyter-view:insert-cell-below`: insert cell below,
- `jupyter-view:insert-cell-below-and-edit`: insert cell below and enter edit mode,
- `jupyter-view:insert-cell-above-and-extend-selection`: insert cell above and extend the selection to it,
- `jupyter-view:insert-cell-below-and-extend-selection`: insert cell below and extend the selection to it,
- `jupyter-view:delete-cell`: delete cell,
- `jupyter-view:move-cell-up`: move cell up,
- `jupyter-view:move-cell-down`: move cell down,
- `jupyter-view:change-cell-to-code`: change to code cell,
- `jupyter-view:change-cell-to-markdown`: change to markdown cell,
- `jupyter-view:change-cell-to-raw`: change to raw cell,
- `jupyter-view:toggle-cell-output`: toggle output visibility,
- `jupyter-view:toggle-cell-input`: toggle input visibility,
- `jupyter-view:enter-edit-mode`: enter edit mode,
- `jupyter-view:enter-command-mode`: enter command mode,
- `jupyter-view:focus-previous-cell`: focus previous cell,
- `jupyter-view:focus-next-cell`: focus next cell,
- `jupyter-view:focus-first-cell`: focus first cell,
- `jupyter-view:focus-last-cell`: focus last cell,
- `jupyter-view:select-previous-cell`: extend selection to previous cell,
- `jupyter-view:select-next-cell`: extend selection to next cell,
- `jupyter-view:cut-cell`: cut cell,
- `jupyter-view:copy-cell`: copy cell,
- `jupyter-view:paste-cell-below`: paste cell below,
- `jupyter-view:paste-cell-above`: paste cell above,
- `jupyter-view:duplicate-cell`: duplicate cell,
- `jupyter-view:merge-cell-below`: merge with cell below,
- `jupyter-view:undo-cell-operation`: undo the latest notebook edit,
- `jupyter-view:redo-cell-operation`: redo the latest notebook edit,
- `jupyter-view:save`: save notebook,
- `jupyter-view:save-as`: save notebook as,
- `jupyter-view:export-to-python`: export to Python script,
- `jupyter-view:export-to-html`: export to HTML.

Commands available in `.jupyter-output-container`:

- `jupyter-view:copy-output-selection`: copy the selected output text to the clipboard.

Commands available in `.tree-view`:

- `jupyter-view:open-notebook`: open the selected `.ipynb` file as a notebook,
- `jupyter-view:open-source`: open the selected `.ipynb` file as plain text.

## Services

- **[jupyter.adapter](docs/jupyter.adapter.md)** (`1.0.0`): provided to let [jupyter-repl](https://github.com/lumine-code/jupyter-repl) execute notebook cells with its normal run commands, routing kernel output, execution counts, focus, and navigation back into the notebook.
- **[jupyter.notebook](docs/jupyter.notebook.md)** (`1.0.0`): provided to expose notebook documents and the active notebook item to packages that need notebook-aware behavior.
- **search.adapter** (`1.0.0`): provided to let the search-panel package find and replace cell source in the active notebook.
- **linter.adapter** (`1.0.0`): provided to map linter diagnostics from the backing editor onto the visible notebook cells.
- **linter.ui** (`1.0.0`): provided to receive linter message updates so notebook scrollmap markers stay in sync with diagnostics.
- **navigation.adapter** (`1.0.0`): provided to show notebook markdown headings as a document outline, activating and revealing the cell on selection.
- **autocomplete.watch-editor** (`^1.0.0`): consumed to keep autocomplete active in notebook cell editors.
- **jupyter.output** (`^1.0.0`): consumed to render stored outputs with jupyter-repl's renderers; without it a notebook falls back to text and images.
- **tree-view.selection** (`^1.0.0`): consumed to add tree-view entries for opening a selected `.ipynb` as a notebook or as plain JSON source.
- **scrollmap.widget** (`^1.0.0`): consumed to render notebook scrollmap markers in a standalone scrollbar widget.

## Integration

### `jupyter.notebook`

The service exposes `getActiveNotebook()` and `getDocumentRegistry()`. Consume it from your `package.json`:

```json
{
  "consumedServices": {
    "jupyter.notebook": {
      "versions": {
        "^1.0.0": "consumeJupyterNotebook"
      }
    }
  }
}
```

### `search.adapter`

While a notebook is the active pane item, `search-panel:show`, `search-panel:find-next`, `search-panel:find-previous`, `search-panel:replace-current`, and `search-panel:replace-all` operate on cell source:

- Search scans all cells and reports the total match count in the find panel.
- Navigation enters edit mode, scrolls to the matching cell, focuses its editor, and selects the current match so typing can immediately replace it.
- Markdown cells are searched by source text; navigation switches a rendered markdown cell to edit mode before selecting the text.
- Replace works across code, markdown, and raw cells and updates the notebook document model.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
