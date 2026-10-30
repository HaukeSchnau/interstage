// TypeScript for the home page's editor. TypeScript 7, which runs interstage as a content mapper,
// is native code without a browser build, so this is TypeScript 6, the last version written in
// JavaScript. It reads `lamp.wgsl` as `/lamp.wgsl.ts`, the module interstage compiled from it.
import ts from 'typescript-js'
import files from 'virtual:checker-files'

const MAIN = '/main.ts'
const SHADER = '/lamp.wgsl.ts'

export interface Problem {
  from: number
  to: number
  message: string
  code: string
}

export interface Hover {
  from: number
  to: number
  signature: string
  documentation: string
}

export interface Completion {
  label: string
  kind: string
  /** Lower sorts first, as TypeScript ranks them. */
  rank: number
}

export interface Definition {
  file: 'main' | 'shader' | 'library'
  from: number
  to: number
}

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
  types: [],
  strict: true,
  noUncheckedIndexedAccess: true,
  skipLibCheck: true,
  noEmit: true,
}

const edited = new Map<string, { text: string; version: number }>()
const read = (path: string) => edited.get(path)?.text ?? files[path]
const write = (path: string, text: string) => {
  const previous = edited.get(path)
  if (previous?.text !== text) edited.set(path, { text, version: (previous?.version ?? 0) + 1 })
}

const directories = new Set(['/'])
for (const path of Object.keys(files)) {
  for (let directory = path.slice(0, path.lastIndexOf('/')); directory; directory = directory.slice(0, directory.lastIndexOf('/'))) {
    directories.add(directory)
  }
}

const service = ts.createLanguageService({
  getCompilationSettings: () => options,
  getScriptFileNames: () => [MAIN],
  getScriptVersion: (path) => String(edited.get(path)?.version ?? 0),
  getScriptSnapshot: (path) => {
    const text = read(path)
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
  },
  getCurrentDirectory: () => '/',
  getDefaultLibFileName: (settings) => `/lib/${ts.getDefaultLibFileName(settings)}`,
  fileExists: (path) => read(path) !== undefined,
  readFile: read,
  directoryExists: (path) => directories.has(path.replace(/\/$/, '') || '/'),
  getDirectories: () => [],
})

const api = {
  check(main: string, shader: string) {
    write(MAIN, main)
    write(SHADER, shader)
    const started = performance.now()
    const diagnostics = [...service.getSyntacticDiagnostics(MAIN), ...service.getSemanticDiagnostics(MAIN)]
    const problems = diagnostics.map(
      (diagnostic): Problem => ({
        from: diagnostic.start ?? 0,
        to: (diagnostic.start ?? 0) + (diagnostic.length ?? 0),
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        code: `TS${diagnostic.code}`,
      }),
    )
    return { problems, milliseconds: performance.now() - started }
  },

  hover(main: string, position: number): Hover | undefined {
    write(MAIN, main)
    const info = service.getQuickInfoAtPosition(MAIN, position)
    if (!info) return undefined
    return {
      from: info.textSpan.start,
      to: info.textSpan.start + info.textSpan.length,
      signature: ts.displayPartsToString(info.displayParts),
      documentation: ts.displayPartsToString(info.documentation),
    }
  },

  complete(main: string, position: number): Completion[] {
    write(MAIN, main)
    const info = service.getCompletionsAtPosition(MAIN, position, undefined)
    return (info?.entries ?? [])
      .toSorted((a, b) => a.sortText.localeCompare(b.sortText))
      .slice(0, 300)
      .map((entry) => ({ label: entry.name, kind: entry.kind, rank: Number.parseInt(entry.sortText, 10) || 0 }))
  },

  definition(main: string, position: number): Definition | undefined {
    write(MAIN, main)
    const [first] = service.getDefinitionAtPosition(MAIN, position) ?? []
    if (!first) return undefined
    const file = first.fileName === SHADER ? 'shader' : first.fileName === MAIN ? 'main' : 'library'
    return { file, from: first.textSpan.start, to: first.textSpan.start + first.textSpan.length }
  },

  transpile(main: string) {
    return ts.transpileModule(main, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText
  },
}

export type CheckerApi = typeof api
export type Call = { [Method in keyof CheckerApi]: { id: number; method: Method; args: Parameters<CheckerApi[Method]> } }[keyof CheckerApi]
export type Reply = { ready: string } | { id: number; result: unknown } | { id: number; error: string }

function invoke<Method extends keyof CheckerApi>(method: Method, args: Parameters<CheckerApi[Method]>) {
  // Each method's own `args`; TypeScript can't relate the two through the union of methods.
  return (api[method] as (...args: Parameters<CheckerApi[Method]>) => ReturnType<CheckerApi[Method]>)(...args)
}

addEventListener('message', ({ data }: MessageEvent<Call>) => {
  try {
    postMessage({ id: data.id, result: invoke(data.method, data.args) } satisfies Reply)
  } catch (error) {
    postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) } satisfies Reply)
  }
})
postMessage({ ready: ts.version } satisfies Reply)
