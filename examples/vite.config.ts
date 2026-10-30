import { glob, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import interstage from 'interstage/vite'
import typegpu from 'unplugin-typegpu/vite'
import { defineConfig, type Plugin } from 'vite'

const pages = ['index', 'slime/index', 'ink/index', 'sculpture/index', 'atlas/index', 'postcard/index']

export default defineConfig({
  base: './',
  plugins: [interstage(), typegpu()],
  // The home page's editor runs interstage's compiler; see the file for why.
  resolve: { alias: { 'vscode-jsonrpc/node': resolve(import.meta.dirname, 'src/editor/no-rpc.ts') } },
  worker: { format: 'es', plugins: () => [checkerFiles()] },
  build: {
    target: 'es2023',
    rollupOptions: {
      input: Object.fromEntries(pages.map((page) => [page, resolve(import.meta.dirname, `${page}.html`)])),
    },
  },
})

/**
 * `virtual:checker-files`: what TypeScript reads in the home page's editor, by path. That is its
 * own libraries for ES2023 and the DOM, TypeGPU's declarations and those of the packages they
 * import, and the editor's page.d.ts.
 */
function checkerFiles(): Plugin {
  const id = 'virtual:checker-files'
  const require = createRequire(import.meta.url)
  return {
    name: 'checker-files',
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    async load(resolved) {
      if (resolved !== `\0${id}`) return undefined
      const files: Record<string, string> = {}

      const libraries = join(dirname(require.resolve('typescript-js/package.json')), 'lib')
      const pending = ['es2023', 'dom']
      while (pending.length > 0) {
        const name = pending.pop()!
        const path = `/lib/lib.${name}.d.ts`
        if (path in files) continue
        const text = await readFile(join(libraries, `lib.${name}.d.ts`), 'utf8')
        files[path] = text
        for (const [, referenced] of text.matchAll(/<reference lib="([^"]+)"/g)) pending.push(referenced!)
      }

      // pnpm puts a package's dependencies next to it.
      const packages = dirname(await realpath(dirname(require.resolve('typegpu/package.json'))))
      for (const name of ['typegpu', 'tinyest', 'typed-binary']) {
        const directory = join(packages, name)
        for await (const file of glob('**/{*.d.ts,package.json}', { cwd: directory, exclude: ['node_modules/**'] })) {
          files[`/node_modules/${name}/${file}`] = await readFile(join(directory, file), 'utf8')
        }
      }

      files['/page.d.ts'] = await readFile(resolve(import.meta.dirname, 'src/editor/sample/page.d.ts'), 'utf8')
      return `export default ${JSON.stringify(files)}`
    },
  }
}
