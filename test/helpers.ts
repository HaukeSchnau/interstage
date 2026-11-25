import { spawn } from "node:child_process";

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
export function typeCheck(compiler: Compiler, project: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn(compilerPath(compiler), ["--runExternalCode", "--pretty", "false"], {
      cwd: project,
      env: { ...process.env, ...env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    // A compiler that was killed has no exit code.
    child.on("close", (code, signal) =>
      code === null
        ? reject(new Error(`${compiler} ended on ${signal}`))
        : resolve({ code, output: stdout + stderr }),
    );
  });
}

/** One-based line and column of the first occurrence of `marker`. */
export function positionOf(text: string, marker: string) {
  const offset = text.indexOf(marker);

  if (offset === -1) throw new Error(`Missing marker: ${marker}`);
  const lines = text.slice(0, offset).split("\n");

  return { line: lines.length, column: lines.at(-1)!.length + 1, offset };
}
