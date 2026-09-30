const js = require("@eslint/js");
const n = require("eslint-plugin-n");
const globals = require("globals");
const prettier = require("eslint-config-prettier");
// Local JSX rules keep each file's factory explicit and count JSX references
// for no-unused-vars without depending on a particular UI library.
const jsxPragmas = new WeakMap();
function readJSXPragmas(sourceCode) {
  if (!jsxPragmas.has(sourceCode)) {
    const pragmas = {};
    for (const comment of sourceCode.getAllComments()) {
      // Match Babel's annotation syntax and let the last annotation win.
      const factory = /^\s*(?:\*\s*)?@jsx\s+(\S+)\s*$/m.exec(comment.value);
      const fragment = /^\s*(?:\*\s*)?@jsxFrag\s+(\S+)\s*$/m.exec(comment.value);
      if (factory) pragmas.factory = factory[1];
      if (fragment) pragmas.fragment = fragment[1];
    }
    jsxPragmas.set(sourceCode, pragmas);
  }
  return jsxPragmas.get(sourceCode);
}

const jsx = {
  rules: {
    "require-pragma": {
      meta: {
        type: "problem",
        schema: [],
        messages: { missing: "This file contains JSX but declares no `/** @jsx ... */` pragma." },
      },
      create({ sourceCode, report }) {
        const { factory } = readJSXPragmas(sourceCode);
        let reported = false;
        function check(node) {
          if (factory || reported) return;
          reported = true;
          report({ node, messageId: "missing" });
        }
        return { JSXOpeningElement: check, JSXOpeningFragment: check };
      },
    },
    "jsx-uses": {
      meta: { type: "problem", schema: [] },
      create({ sourceCode }) {
        const { factory, fragment } = readJSXPragmas(sourceCode);
        function mark(expression, node) {
          if (expression) sourceCode.markVariableAsUsed(expression.split(".")[0], node);
        }
        return {
          JSXOpeningElement(node) {
            mark(factory, node);
            // Plain lowercase tags are strings; a member tag still references
            // its root even when that root starts with a lowercase letter.
            if (node.name.type === "JSXIdentifier" && /^[a-z]/.test(node.name.name)) return;
            let root = node.name;
            while (root.type === "JSXMemberExpression") root = root.object;
            if (root.type === "JSXIdentifier") sourceCode.markVariableAsUsed(root.name, root);
          },
          JSXOpeningFragment(node) {
            mark(factory, node);
            // A fragment type is separate from the factory that receives it.
            // Compiler defaults are outside this rule's explicit-pragma scope.
            mark(fragment, node);
          },
        };
      },
    },
  },
};

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
    files: ["eslint.config.js"],
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
