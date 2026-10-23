import { readFile } from 'node:fs/promises'
import type { Plugin } from 'vite'
import { compile } from './compile.ts'

/** Serves `.wgsl` imports as the TypeGPU modules that the content mapper types them as. */
export default function interstage(): Plugin {
  return {
    name: 'interstage',
    enforce: 'pre',
    async load(id) {
      if (!id.endsWith('.wgsl')) return null
      const source = await readFile(id, 'utf8')
      const { code, diagnostics } = compile(source)
      const [first] = diagnostics
      if (first) {
        const lines = diagnostics.map((diagnostic) => {
          const { line, column } = lineAndColumn(source, diagnostic.start)
          return `${id}:${line}:${column + 1} wgsl${diagnostic.code}: ${diagnostic.message}`
        })
        this.error({ message: lines.join('\n'), id, loc: { file: id, ...lineAndColumn(source, first.start) } })
      }
      return { code, moduleType: 'js' }
    },
  }
}

function lineAndColumn(source: string, index: number): { line: number; column: number } {
  const before = source.slice(0, index).split('\n')
  return { line: before.length, column: before.at(-1)!.length }
}
