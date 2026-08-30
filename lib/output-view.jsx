/** @jsx etch.dom */
/**
 * OutputView - renders the outputs stored in a notebook cell.
 *
 * The rendering itself comes from jupyter-repl's `jupyter.output` service —
 * one implementation, one copy of the heavy renderers, shared by the whole
 * family. Without the service (jupyter-repl absent) a minimal built-in
 * fallback keeps a notebook readable: plain text, images, streams and error
 * text. Full fidelity — ANSI colour, plotly, vega, LaTeX, markdown, html —
 * arrives with the hub, as every jupyter package README already states.
 */

const etch = require("@lumine-code/etch");
const outputRenderer = require("./output-renderer");

function asText(value) {
  if (Array.isArray(value)) return value.join("");
  return value == null ? "" : String(value);
}

const FALLBACK_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif"];

/** The readable-without-the-hub subset: text, images, streams, error text. */
function renderFallbackOutput(output) {
  if (output.output_type === "stream") {
    return (
      <pre className={`output-stream output-${output.name || "stream"}`}>{asText(output.text)}</pre>
    );
  }
  if (output.output_type === "error") {
    const traceback =
      output.traceback && output.traceback.length
        ? output.traceback
        : [`${output.ename || "Error"}: ${output.evalue || ""}`];
    return <pre className="output-error">{asText(traceback.join("\n"))}</pre>;
  }
  if (output.output_type === "display_data" || output.output_type === "execute_result") {
    const data = output.data || {};
    const imageMime = FALLBACK_IMAGE_MIMES.find((mime) => data[mime]);
    if (imageMime) {
      const src = `data:${imageMime};base64,${asText(data[imageMime]).replace(/\s/g, "")}`;
      return <img className="output-image" src={src} draggable={false} />;
    }
    if (data["text/plain"]) {
      return <pre className="output-text">{asText(data["text/plain"])}</pre>;
    }
    return null;
  }
  if (output.text) {
    return <pre className="output-text">{asText(output.text)}</pre>;
  }
  return null;
}

function renderOutput(output) {
  const service = outputRenderer.get();
  if (!service) {
    return renderFallbackOutput(output);
  }
  return service.renderDisplay(service.normalizeOutput(output));
}

class OutputView {
  constructor(props) {
    this.props = props;
    etch.initialize(this);

    // Re-render when the service arrives or goes away: a notebook restored at
    // startup can beat jupyter-repl's activation by a frame.
    this.serviceSubscription = outputRenderer.onDidChange(() => etch.update(this));

    // Block image drag-and-drop from outputs (catches imgs embedded in
    // text/html outputs that don't go through the image MIME branch).
    this.element.addEventListener("dragstart", (event) => {
      if (event.target?.tagName === "IMG") event.preventDefault();
    });
  }

  render() {
    const { outputs, maxHeight } = this.props;
    const style = maxHeight > 0 ? { maxHeight: `${maxHeight}px`, overflowY: "auto" } : {};

    return (
      <div className="jupyter-output-container">
        <div className="jupyter-outputs" style={style}>
          {(outputs || []).map((output, index) => (
            <div
              key={index}
              className={`jupyter-output output-${output.output_type || "unknown"}`}
              attributes={{ "data-output-index": String(index) }}
            >
              {renderOutput(output)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  update(props) {
    this.props = { ...this.props, ...props };
    return etch.update(this);
  }

  destroy() {
    this.serviceSubscription.dispose();
    return etch.destroy(this);
  }
}

module.exports = OutputView;
