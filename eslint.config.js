const js = require("@eslint/js");
const n = require("eslint-plugin-n");
const globals = require("globals");
const prettier = require("eslint-config-prettier");
const jsx = require("./eslint-jsx");

// `lumine` is provided by the Lumine runtime, not resolvable from this manifest.
const runtimeModules = ["lumine"];

module.exports = [
  {
    // The local dev sandbox and spec fixtures are not linted.
    ignores: ["node_modules/**", ".dev/**", "spec/fixtures/**"],
  },
  js.configs.recommended,
  n.configs["flat/recommended-script"],
  {
    // `.jsx` is not one of eslint's default extensions, and the etch components
    // live in those files.
    files: ["**/*.js", "**/*.jsx"],
    settings: {
      // Lumine bundles its own Node 24 runtime; lint against that, not engines.
      // It also registers .jsx with the module loader, which node does not.
      n: { version: ">=24.0.0", tryExtensions: [".js", ".jsx", ".json", ".node"] },
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.node,
        lumine: "readonly",
      },
    },
    plugins: { jsx },
    rules: {
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "n/no-missing-require": ["error", { allowModules: runtimeModules }],
      "n/no-extraneous-require": ["error", { allowModules: runtimeModules }],
      "n/no-unpublished-require": ["error", { allowModules: runtimeModules }],
      // Each file names its own JSX factory in a `/** @jsx ... */` pragma:
      // `require-pragma` insists on it, and `jsx-uses` reads it from there
      // rather than from a default that lives in another repository.
      "jsx/require-pragma": "error",
      "jsx/jsx-uses": "error",
    },
  },
  {
    // Dev tooling (this config) legitimately requires devDependencies and is
    // never shipped as runtime.
    files: ["eslint.config.js", "eslint-jsx.js"],
    rules: {
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  {
    // Specs run in the Lumine jasmine runner and require devDependencies.
    files: ["spec/**", "**/*-spec.js"],
    languageOptions: { globals: { ...globals.jasmine } },
    rules: {
      "n/no-missing-require": "off",
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  // Must be last: turns off lint rules that would conflict with Prettier.
  prettier,
];
