/**
 * Markdown rendering for notebook cells and outputs.
 *
 * Lumine ships a markdown-it renderer with DOMPurify sanitizing on
 * `lumine.tools.markdown`, so notebooks render the same flavour of markdown as the
 * rest of the editor without this package carrying its own parser.
 */

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Render markdown source to a sanitized HTML fragment.
 *
 * Notebook content is untrusted, so sanitizing is always on. Link and image
 * rewriting is disabled: notebook resources are relative to the document, not
 * to the editor's docs.
 *
 * @param {string} source markdown source.
 * @returns {string} sanitized HTML.
 */
function renderMarkdown(source) {
  try {
    return lumine.tools.markdown.render(source || "", {
      renderMode: "fragment",
      sanitize: true,
      breaks: true,
      handleFrontMatter: false,
      transformImageLinks: false,
      transformLegacyLinks: false,
      transformNonFqdnLinks: false,
    });
  } catch (e) {
    // A malformed cell must not take the whole notebook down; fall back to the
    // source as escaped plain text.
    return escapeHtml(source);
  }
}

module.exports = { escapeHtml, renderMarkdown };
