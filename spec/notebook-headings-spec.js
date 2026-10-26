const { TextBuffer } = require("lumine");

describe("source-backed notebook headings", () => {
  it("uses bounded title previews while preserving exact cell positions", () => {
    const buffer = new TextBuffer("# " + "x".repeat(200000) + "\n## Small title\n");
    const source = buffer.getTextSnapshot();
    buffer.destroy();
    const cell = {
      type: "markdown",
      getSourceSnapshot: () => source,
      get source() {
        throw new Error("Whole source read");
      },
    };
    const headings = require("../lib/notebook-headings").collectHeadings([cell], {
      budgetMs: Infinity,
    });
    expect(headings.length).toBe(2);
    expect(headings[0].text.length).toBe(257);
    expect(headings[0].preview).toBe(true);
    expect(headings[1].text).toBe("Small title");
    expect(headings[1].cellRow).toBe(1);
  });

  it("marks an incomplete outline explicitly instead of silently omitting the remainder", () => {
    const buffer = new TextBuffer("# One\n# Two\n# Three\n");
    const source = buffer.getTextSnapshot();
    buffer.destroy();
    const headings = require("../lib/notebook-headings").collectHeadings(
      [{ type: "markdown", getSourceSnapshot: () => source }],
      { maxHeadings: 2, budgetMs: Infinity },
    );
    expect(headings.length).toBe(3);
    expect(headings[2].incomplete).toBe(true);
    expect(headings[2].text).toContain("incomplete");
  });
});
