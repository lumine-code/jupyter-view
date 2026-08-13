const {
  getGrammarForLanguage,
  getGrammarScopesForLanguage,
  languageIdForGrammar,
  normalizeLanguage,
} = require("../lib/notebook-language");

// The persistence contract for per-cell grammars: whatever id
// languageIdForGrammar hands out, getGrammarForLanguage must resolve back to
// the very same scope — a plain id where one round-trips, the scope name
// verbatim where none does.

describe("notebook language mapping", () => {
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-python");
    await lumine.packages.activatePackage("language-json");
  });

  it("normalizes VS Code spellings onto the table's ids", () => {
    expect(normalizeLanguage("shellscript")).toBe("shell");
    expect(normalizeLanguage("PowerShell")).toBe("pwsh");
  });

  it("resolves a stored scope name verbatim", () => {
    expect(getGrammarScopesForLanguage("source.weird.thing")).toEqual(["source.weird.thing"]);
  });

  it("prefers a plain id that round-trips to the same grammar", () => {
    const json = lumine.grammars.grammarForScopeName("source.json");
    expect(languageIdForGrammar(json)).toBe("json");
    expect(getGrammarForLanguage("json")).toBe(json);
  });

  it("keeps the ipython grammar as plain python", () => {
    const ipy = lumine.grammars.grammarForScopeName("source.python.ipy");
    expect(languageIdForGrammar(ipy)).toBe("python");
    expect(getGrammarForLanguage("python")).toBe(ipy);
  });

  it("falls back to the scope name when no id resolves back", () => {
    expect(languageIdForGrammar({ scopeName: "source.no.such.language" })).toBe(
      "source.no.such.language",
    );
    expect(languageIdForGrammar(null)).toBe(null);
  });
});
