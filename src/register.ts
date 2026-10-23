// `node --import interstage/register` lets Node import `.wgsl` files, for TypeGPU on Dawn.
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { compile } from './compile.ts'

registerHooks({
  load(url, context, nextLoad) {
    const { pathname } = new URL(url)
    if (!pathname.endsWith('.wgsl')) return nextLoad(url, context)
    const file = fileURLToPath(url)
    const source = readFileSync(file, 'utf8')
    const { code, diagnostics } = compile(source)
    if (diagnostics.length > 0) {
      const lines = diagnostics.map((diagnostic) => {
        const before = source.slice(0, diagnostic.start).split('\n')
        return `${file}:${before.length}:${before.at(-1)!.length + 1} wgsl${diagnostic.code}: ${diagnostic.message}`
      })
      throw new SyntaxError(lines.join('\n'))
    }
    return { format: 'module', source: code, shortCircuit: true }
  },
})
