import { Calder, On, Step, Task, cmd } from "@calder-ci/core";
import { Npm, Pnpm, Project, Vp } from "@calder-ci/std";
import { Schema } from "effect";
import { flake } from "./flake.ts";

const shell = flake.devShells.ci;
const install = Pnpm.install({ shell });

/**
 * `vp check`: format, lint and the type check, which runs the content mapper over the tests' own
 * shaders. The mapper is the built dist/mapper.js, and a task starts without dist/, so `pnpm check`
 * builds first. Vp.check runs `vp check` alone.
 */
const check = Task.make("check", { shell, setup: install, run: cmd`pnpm check` });
/** The whole `vp test` suite, which compiles and runs shaders on Dawn in the shell's software Vulkan driver. */
const test = Vp.test({ shell, setup: install });
/** Tint validates every example shader in the type check, and Chromium loads each demo from the build. */
const examples = Task.make("examples", {
  shell,
  setup: install,
  run: cmd`bash -c ${"pnpm --dir examples typecheck && pnpm --dir examples build && pnpm --dir examples check"}`,
}).pipe(Step.timeout("20 minutes"));
const checks = [check, test, examples];

/** The examples at interstage.schnau.dev (examples/alchemy.run.ts), with a preview per pull request. */
const site = Project.alchemy({
  flake,
  stack: {
    shell,
    setup: install,
    dir: "examples",
    env: "cloudflare",
    outputs: { name: "Interstage", schema: Schema.Struct({ url: Schema.String }) },
  },
  checks,
  previews: { url: (_pr, outputs) => outputs.url },
});

/** A commit that raises the version stages it on npm, for a maintainer to approve with 2FA. */
const release = Npm.publish({ shell, setup: install, token: "npm", after: checks });

export default Calder.project({ rules: [...site.rules, On.push("main", [release])] });
