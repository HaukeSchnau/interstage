import { execFileSync } from "node:child_process";

export default function setup() {
  execFileSync("node_modules/.bin/tsrs", ["-p", "tsconfig.build.json"], { stdio: "inherit" });
}
