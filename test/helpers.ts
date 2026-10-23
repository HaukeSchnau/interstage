import { execFile } from 'node:child_process'

const root = new URL('..', import.meta.url).pathname

export function fixture(name: string): string {
  return `${root}test/fixtures/${name}`
}

/** Runs the project's TypeScript with permission to start content mappers, from inside the project. */
export function tsc(project: string, env: Record<string, string> = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const options = { cwd: project, env: { ...process.env, ...env } }
    execFile(`${root}node_modules/.bin/tsc`, ['--runExternalCode', '--pretty', 'false'], options, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, output: stdout + stderr })
    })
  })
}

/** One-based line and column of the first occurrence of `marker`. */
export function positionOf(text: string, marker: string): { line: number; column: number; offset: number } {
  const offset = text.indexOf(marker)
  if (offset === -1) throw new Error(`Missing marker: ${marker}`)
  const lines = text.slice(0, offset).split('\n')
  return { line: lines.length, column: lines.at(-1)!.length + 1, offset }
}
