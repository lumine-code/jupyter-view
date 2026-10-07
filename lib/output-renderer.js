const { Emitter } = require("lumine");

/**
 * The `jupyter.output` service, held where the views can reach it.
 *
 * jupyter-repl owns the renderers (and the heavy dependencies behind them —
 * MathJax, plotly, vega); this package renders stored notebook outputs through
 * that service instead of carrying drifting copies. The service can arrive
 * after a notebook is already on screen and go away when jupyter-repl
 * deactivates, so views subscribe and re-render on both edges.
 */
const emitter = new Emitter();
let service = null;
let generation = 0;

module.exports = {
  set(nextService) {
    service = nextService;
    generation++;
    emitter.emit("did-change");
    return generation;
  },

  clear(lease) {
    if (generation === lease) this.set(null);
  },

  get() {
    return service;
  },

  /**
   * Invoke the callback when the service arrives or goes away.
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidChange(callback) {
    return emitter.on("did-change", callback);
  },
};
