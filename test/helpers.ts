import { execFile } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;

/** The compilers interstage's users run: TypeScript 7.1 and tsrs, its port to Rust. */
export const compilers = ["tsc", "tsrs"] as const;
export type Compiler = (typeof compilers)[number];

export function compilerPath(compiler: Compiler): string {
  return `${root}node_modules/.bin/${compiler}`;
}

export function fixture(name: string): string {
  return `${root}test/fixtures/${name}`;
}

/** Runs the compiler with permission to start content mappers, from inside the project. */
export function typeCheck(
  compiler: Compiler,
  project: string,
  env: Record<string, string> = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const options = { cwd: project, env: { ...process.env, ...env } };
    execFile(
      compilerPath(compiler),
      ["--runExternalCode", "--pretty", "false"],
      options,
      (error, stdout, stderr) => {
        // A compiler that didn't start or was killed has no exit code.
        const code = error ? error.code : 0;
        if (typeof code === "number") resolve({ code, output: stdout + stderr });
        else reject(error);
      },
    );
  });
}

/** One-based line and column of the first occurrence of `marker`. */
export function positionOf(
  text: string,
  marker: string,
): { line: number; column: number; offset: number } {
  const offset = text.indexOf(marker);
  if (offset === -1) throw new Error(`Missing marker: ${marker}`);
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length, column: lines.at(-1)!.length + 1, offset };
}
