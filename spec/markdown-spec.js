const { escapeHtml, renderMarkdown } = require("../lib/markdown");

// Notebook markdown cells and `text/markdown` outputs go through Lumine's
// bundled markdown-it renderer on `lumine.tools.markdown`, so these specs pin the
// contract this package depends on: real markdown, sanitized, and no rewriting
// of the notebook's own links.
describe("markdown rendering", () => {
  describe("renderMarkdown", () => {
    it("renders block markdown rather than escaping it", () => {
      const html = renderMarkdown("# Title\n\nSome **bold** text.");
      expect(html).toContain("Title");
      expect(html).toContain("<strong>bold</strong>");
      expect(html).not.toContain("&lt;strong&gt;");
    });

    it("renders constructs the old regex fallback could not", () => {
      const html = renderMarkdown("- one\n- two\n");
      expect(html).toContain("<ul>");
      expect(html).toContain("<li>");
    });

    it("renders fenced code blocks", () => {
      const html = renderMarkdown("```\nprint(1)\n```");
      expect(html).toContain("<code");
      expect(html).toContain("print(1)");
    });

    it("sanitizes script tags out of untrusted notebook content", () => {
      const html = renderMarkdown("text <script>window.pwned = true</script> more");
      expect(html).not.toContain("<script");
      expect(html).toContain("text");
    });

    it("sanitizes inline event handlers", () => {
      const html = renderMarkdown('<img src="x" onerror="window.pwned = true">');
      expect(html).not.toContain("onerror");
    });

    it("treats a single newline as a line break", () => {
      const html = renderMarkdown("one\ntwo");
      expect(html).toContain("<br");
    });

    it("returns an empty string for empty or nullish source", () => {
      expect(renderMarkdown("")).toBe("");
      expect(renderMarkdown(null)).toBe("");
      expect(renderMarkdown(undefined)).toBe("");
    });

    it("leaves front matter alone instead of consuming it as metadata", () => {
      const html = renderMarkdown("---\ntitle: x\n---\n\nbody");
      expect(html).toContain("body");
    });
  });

  describe("escapeHtml", () => {
    it("escapes the HTML-significant characters", () => {
      expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href="x"&gt;&amp;&lt;/a&gt;');
    });

    it("coerces nullish input to an empty string", () => {
      expect(escapeHtml(null)).toBe("");
      expect(escapeHtml(undefined)).toBe("");
    });

    it("escapes ampersands before angle brackets so entities are not doubled", () => {
      expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    });
  });
});
