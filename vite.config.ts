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

const generated = ["dist", "examples/dist", "examples/.contract", "examples/.alchemy", "pnpm-lock.yaml"];

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
      "typescript/no-non-null-assertion": "error",
      "unicorn/prefer-node-protocol": "error",

      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
    },
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
