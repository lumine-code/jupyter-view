const {
  getGrammarForLanguage,
  getGrammarScopesForLanguage,
  getNotebookLanguage,
  inferLanguageFromKernelName,
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
    await lumine.packages.activatePackage("language-ipython");
    await lumine.packages.activatePackage("language-json");
  });

  it("normalizes VS Code spellings onto the table's ids", () => {
    expect(normalizeLanguage("shellscript")).toBe("shell");
    expect(normalizeLanguage("PowerShell")).toBe("pwsh");
  });

  it("uses kernelspec language before stale language_info and syntax hints", () => {
    expect(
      getNotebookLanguage({
        kernelspec: { name: "ir", language: "R" },
        language_info: {
          name: "python",
          codemirror_mode: "julia",
          mimetype: "text/x-python",
          file_extension: ".py",
        },
      }),
    ).toBe("r");
  });

  it("falls through language_info fields in their declared order", () => {
    expect(
      getNotebookLanguage({
        language_info: {
          name: "Julia",
          codemirror_mode: "python",
          mimetype: "text/x-rsrc",
          file_extension: ".r",
        },
      }),
    ).toBe("julia");
    expect(
      getNotebookLanguage({
        language_info: { codemirror_mode: { name: "C++" }, mimetype: "text/x-python" },
      }),
    ).toBe("cpp");
    expect(getNotebookLanguage({ language_info: { file_extension: ".jl" } })).toBe("julia");
  });

  it("recognizes versioned kernelspec names before falling back to python", () => {
    expect(inferLanguageFromKernelName({ name: "python-3.13" })).toBe("python");
    expect(inferLanguageFromKernelName({ name: "ir-4.5" })).toBe("r");
    expect(inferLanguageFromKernelName({ name: "julia-1.11" })).toBe("julia");
    expect(inferLanguageFromKernelName({ name: "xeus-cpp17" })).toBe("cpp");
    expect(getNotebookLanguage({ kernelspec: { name: "custom-runtime" } })).toBe("python");
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
