import { Calder, On, Step, Task, cmd } from "@calder-ci/core"
import { Npm, Pnpm, Project } from "@calder-ci/std"
import { Schema } from "effect"
import { flake } from "./flake.ts"

const shell = flake.devShells.ci
const install = Pnpm.install({ shell })

/** The repository's type check runs the content mapper over the tests' own shaders. */
const typecheck = Task.make("typecheck", { shell, setup: install, run: cmd`pnpm typecheck` })
/** The tests compile and run shaders on Dawn, in the shell's software Vulkan driver. */
const test = Task.make("test", { shell, setup: install, run: cmd`pnpm test` }).pipe(Step.timeout("15 minutes"))
/** Tint validates every example shader in the type check, and Chromium loads each demo from the build. */
const examples = Task.make("examples", {
  shell,
  setup: install,
  run: cmd`bash -c ${"pnpm --dir examples typecheck && pnpm --dir examples build && pnpm --dir examples check"}`,
}).pipe(Step.timeout("20 minutes"))
const checks = [typecheck, test, examples]

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
})

/** A commit that raises the version stages it on npm, for a maintainer to approve with 2FA. */
const release = Npm.publish({ shell, setup: install, token: "npm", after: checks })

export default Calder.project({ rules: [...site.rules, On.push("main", [release])] })
