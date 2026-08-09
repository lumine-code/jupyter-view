const LANGUAGE_ALIASES = {
  "c++": "cpp",
  "text/x-c++src": "cpp",
  "text/x-c++hdr": "cpp",
  "x-c++src": "cpp",
  "x-c++hdr": "cpp",
  "c++src": "cpp",
  "c++hdr": "cpp",
  csrc: "c",
  chdr: "c",
  cppsrc: "cpp",
  cpphdr: "cpp",
  "c#": "csharp",
  "text/x-csharp": "csharp",
  "f#": "fsharp",
  "text/x-fsharp": "fsharp",
  ".js": "javascript",
  js: "javascript",
  node: "javascript",
  nodejs: "javascript",
  ".ts": "typescript",
  ".py": "python",
  py: "python",
  ipython: "python",
  ".r": "r",
  ir: "r",
  "r-project": "r",
  rsrc: "r",
  ".jl": "julia",
  ".rb": "ruby",
  rb: "ruby",
  ".sh": "shell",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  powershell: "pwsh",
};

const LANGUAGE_SCOPES = {
  // IPython first: a Jupyter python kernel is IPython, so cells may hold
  // magics, shell escapes and help requests. Its grammar is a superset of the
  // python one, which stays as the fallback when it is not installed.
  python: ["source.python.ipy", "source.python", "text.python"],
  javascript: ["source.js", "source.javascript"],
  typescript: ["source.ts", "source.typescript"],
  r: ["source.r"],
  julia: ["source.julia"],
  ruby: ["source.ruby"],
  go: ["source.go"],
  rust: ["source.rust"],
  c: ["source.c"],
  cpp: ["source.cpp", "source.c++"],
  csharp: ["source.cs", "source.csharp"],
  fsharp: ["source.fsharp"],
  java: ["source.java"],
  scala: ["source.scala"],
  sql: ["source.sql"],
  shell: ["source.shell", "source.bash", "source.sh"],
  pwsh: ["source.powershell"],
  php: ["text.html.php", "source.php"],
  perl: ["source.perl"],
  lua: ["source.lua"],
  matlab: ["source.matlab"],
  octave: ["source.octave", "source.matlab"],
  clojure: ["source.clojure"],
  groovy: ["source.groovy"],
  kotlin: ["source.kotlin"],
  swift: ["source.swift"],
};

function normalizeLanguage(language) {
  if (!language) return null;

  let normalized = String(language).trim().toLowerCase();
  if (!normalized) return null;

  normalized = normalized.replace(/^text\//, "");
  normalized = normalized.replace(/^application\//, "");
  normalized = normalized.replace(/^x-/, "");

  return LANGUAGE_ALIASES[normalized] || normalized;
}

function getNotebookLanguage(metadata = {}) {
  const codemirrorMode = metadata.language_info?.codemirror_mode;
  const candidates = [
    typeof codemirrorMode === "string" ? codemirrorMode : codemirrorMode?.name,
    metadata.language_info?.name,
    metadata.language_info?.mimetype,
    metadata.language_info?.file_extension,
    metadata.kernelspec?.language,
    metadata.kernelspec?.name,
  ];

  for (const candidate of candidates) {
    const language = normalizeLanguage(candidate);
    if (language) return language;
  }

  return "python";
}

function getGrammarScopesForLanguage(language) {
  const normalized = normalizeLanguage(language);
  if (!normalized) return [];
  return LANGUAGE_SCOPES[normalized] || [`source.${normalized}`, `text.${normalized}`];
}

function getGrammarForLanguage(language) {
  for (const scope of getGrammarScopesForLanguage(language)) {
    const grammar = lumine.grammars.grammarForScopeName(scope);
    if (grammar) return grammar;
  }
  return null;
}

module.exports = {
  getGrammarForLanguage,
  getGrammarScopesForLanguage,
  getNotebookLanguage,
  normalizeLanguage,
};
