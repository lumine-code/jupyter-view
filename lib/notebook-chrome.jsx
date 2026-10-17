/** @jsx etch.dom */
/**
 * What the notebook pane shows while it has no view of its own: the loading
 * placeholder, and the message when a notebook could not be opened.
 *
 * These were three HTML strings assigned to the container's innerHTML, and one
 * of them interpolated an error message, so a message carrying markup was
 * parsed as markup. Built as nodes, the text is text.
 */

const etch = require("@lumine-code/etch");
// Loading and error chrome can render before the full notebook view is loaded.
etch.setScheduler(lumine.views);

class NotebookChrome {
  constructor(props = {}) {
    this.props = props;
    etch.initialize(this);
  }

  render() {
    if (this.props.error) {
      return <div className="error-message">Failed to load notebook: {this.props.error}</div>;
    }
    return (
      <div className="jupyter-notebook-loading">
        <div className="loading-spinner-large" />
        <div className="loading-message">Loading notebook...</div>
      </div>
    );
  }

  update(props) {
    this.props = props;
    return etch.update(this);
  }

  destroy() {
    return etch.destroySync(this);
  }
}

/**
 * Put one of those states into `container`, replacing whatever it held.
 *
 * @param {HTMLElement} container - The pane's stable container element
 * @param {Object} props - `{ error }` for the failure state, `{}` for loading
 * @returns {NotebookChrome} The component now mounted in the container
 */
function showChrome(container, props = {}) {
  container.innerHTML = "";
  const chrome = new NotebookChrome(props);
  container.appendChild(chrome.element);
  return chrome;
}

module.exports = { NotebookChrome, showChrome };
