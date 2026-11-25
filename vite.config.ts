import { defineConfig } from "vite-plus";

import interstage from "./src/vite.ts";

const agentTooling = [
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".continue/**",
  ".cursor/**",
  ".gemini/**",
  ".opencode/**",
  ".pi/**",
  ".roo/**",
  ".windsurf/**",
];

const generated = [
  "dist",
  "examples/dist",
  "examples/.contract",
  "examples/.alchemy",
  "pnpm-lock.yaml",
];

// Projects as interstage's users write them, which the tests compile. Their markers and expected
// positions follow the text as it is.
const fixtures = ["test/fixtures/**", "test/.tmp/**"];

export default defineConfig({
  // runtime.test.ts imports shaders, as an app built with the Vite plugin does.
  plugins: [interstage()],
  fmt: {
    ignorePatterns: [...generated, ...fixtures, ...agentTooling, "tools/oxlint/anti-slop/**"],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: [
      ...generated,
      ...fixtures,
      ...agentTooling,
      // Vendored as upstream wrote it; upstream lints and tests it.
      "tools/oxlint/anti-slop/**",
      // Calder's own TypeScript project, with a tsconfig package the workspace doesn't install.
      ".calder",
    ],
    plugins: ["eslint", "oxc", "typescript", "unicorn"],
    jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
    categories: {
      correctness: "error",
      perf: "error",
      suspicious: "error",
    },
    rules: {
      "eslint/eqeqeq": "error",
      "typescript/consistent-type-imports": "error",
      "typescript/no-explicit-any": "error",
      "unicorn/prefer-node-protocol": "error",

      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",

      // The compiler and the demos index arrays and tuples under noUncheckedIndexedAccess where the
      // index is in range by construction: 117 findings, 58 of them in src/. Replacing them with
      // checked access is a refactor of the compiler and every demo.
      // https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-non-null-assertion.html
      "typescript/no-non-null-assertion": "off",

      // It asks for a comment on every cast: 26 findings, 18 in src/, where tsrs copies comments into
      // the published JavaScript. The casts that narrow are the ones no-unsafe-type-assertion lists
      // below, with the reason they stay.
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/rules/require-safety-comment-for-type-assertion.ts
      "anti-slop/require-safety-comment-for-type-assertion": "off",

      // Sequential awaits are deliberate here: scripts/check.ts loads one demo at a time, and the
      // editor's checker files are read in dependency order. 20 findings.
      // https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-await-in-loop.html
      "eslint/no-await-in-loop": "off",

      // Reusing a precise name in a nested callback reads better, and TypeScript resolves the scopes.
      // 6 findings.
      // https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-shadow.html
      "eslint/no-shadow": "off",

      // A small helper beside its only caller reads better than one hoisted for a tiny allocation.
      // 6 findings.
      // https://oxc.rs/docs/guide/usage/linter/rules/unicorn/consistent-function-scoping.html
      "unicorn/consistent-function-scoping": "off",

      // It misreads exhaustive switches over tagged unions; `noImplicitReturns` covers missing returns.
      // 7 findings.
      // https://oxc.rs/docs/guide/usage/linter/rules/typescript/consistent-return.html
      "typescript/consistent-return": "off",

      // Small immutable updates read better as spreads than as mutation. 1 finding.
      // https://oxc.rs/docs/guide/usage/linter/rules/oxc/no-map-spread.html
      "oxc/no-map-spread": "off",

      // `window.__interstage` is the demos' hook for scripts/check.ts, named so that no page global
      // can collide with it. 11 findings.
      // https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-underscore-dangle.html
      "eslint/no-underscore-dangle": "off",

      // Each cast sits where TypeScript can't relate the types: the evaluator's Value union, which
      // narrows by `ty` rather than by a tag (18 in src/), replies over postMessage and JSON-RPC, a
      // method picked from a union of methods, Object.fromEntries over the controls' keys,
      // FileReader's result and server.address() (7 elsewhere). Removing them is a redesign of each.
      // https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unsafe-type-assertion.html
      "typescript/no-unsafe-type-assertion": "off",

      // Error handlers and the replies of the two RPC clients (test/lsp.ts and the editor's
      // checker worker) receive values whose type isn't known yet: 6 findings.
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/rules/no-unknown-parameters.ts
      "anti-slop/no-unknown-parameters": "off",

      // test/lsp.ts sends JSON-RPC messages whose params differ per method: 2 findings.
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/rules/no-object-parameters.ts
      "anti-slop/no-object-parameters": "off",

      // The editor's capture mode hands TypeGPU a stand-in canvas context that has only
      // getCurrentTexture(), which is all TypeGPU reads: 1 finding.
      // https://github.com/dmmulroy/anti-slop/blob/63dbb09/src/rules/no-chained-type-assertions.ts
      "anti-slop/no-chained-type-assertions": "off",

      // It reads every postMessage as window.postMessage. Its one finding is a Worker's, which takes
      // no target origin.
      // https://oxc.rs/docs/guide/usage/linter/rules/unicorn/require-post-message-target-origin.html
      "unicorn/require-post-message-target-origin": "off",

      // The editor's stand-in for vscode-jsonrpc (examples/src/editor/no-rpc.ts) must export the
      // class that ts-content-mapper constructs. 1 finding.
      // https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-extraneous-class.html
      "typescript/no-extraneous-class": "off",
    },
    overrides: [
      {
        // src/ is the published library, and fixing these changes the JavaScript in dist/. They wait
        // for a release, which can ship that change: no-shape-in-symbol-names 16 (exported names),
        // no-known-value-widening 12, no-runtime-typeof 3, no-array-sort 2, no-array-reverse 1,
        // no-misused-spread 1.
        files: ["src/**"],
        rules: {
          "anti-slop/no-shape-in-symbol-names": "off",
          "anti-slop/no-known-value-widening": "off",
          "anti-slop/no-runtime-typeof": "off",
          "unicorn/no-array-sort": "off",
          "unicorn/no-array-reverse": "off",
          "typescript/no-misused-spread": "off",
        },
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    include: ["test/*.test.ts"],
    // The tests start the published content mapper, dist/mapper.js, through `node_modules/interstage`.
    globalSetup: ["test/build.setup.ts"],
  },
});
