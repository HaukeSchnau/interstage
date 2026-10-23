import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export interface Location {
  file: string
  line: number
  character: number
  endCharacter: number
}

interface LspRange {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

/** A TypeScript language server for one project, as an editor in a trusted workspace runs it. */
export async function languageServer(project: string) {
  const root = new URL('..', import.meta.url).pathname
  const server = spawn(`${root}node_modules/.bin/tsc`, ['--lsp', '--stdio'], { cwd: project, stdio: ['pipe', 'pipe', 'ignore'] })
  const pending = new Map<number, (result: unknown) => void>()
  let buffer = Buffer.alloc(0)
  let nextId = 0

  const send = (message: object) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...message })
    server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
  server.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())![1])
      if (buffer.length < headerEnd + 4 + length) return
      const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString())
      buffer = buffer.subarray(headerEnd + 4 + length)
      if (message.id !== undefined && message.method) send({ id: message.id, result: null })
      else if (message.id !== undefined) pending.get(message.id)?.(message.error ? Promise.reject(new Error(message.error.message)) : message.result)
    }
  })
  const request = <T>(method: string, params: object) =>
    new Promise<T>((resolve) => {
      const id = ++nextId
      pending.set(id, resolve as (result: unknown) => void)
      send({ id, method, params })
    })
  const uri = (file: string) => pathToFileURL(`${project}/${file}`).href
  const fileOf = (fileUri: string) => fileUri.slice(pathToFileURL(project).href.length + 1)
  const toLocation = (fileUri: string, range: LspRange): Location => ({
    file: fileOf(fileUri),
    line: range.start.line + 1,
    character: range.start.character + 1,
    endCharacter: range.end.character + 1,
  })
  const position = (file: string, marker: string, offset = 0) => {
    const text = readFileSync(`${project}/${file}`, 'utf8')
    const index = text.indexOf(marker)
    if (index === -1) throw new Error(`Missing marker in ${file}: ${marker}`)
    const lines = text.slice(0, index + offset).split('\n')
    return { textDocument: { uri: uri(file) }, position: { line: lines.length - 1, character: lines.at(-1)!.length } }
  }

  await request('initialize', {
    processId: process.pid,
    rootUri: uri('.'),
    capabilities: {},
    initializationOptions: { runExternalCode: true },
  })
  send({ method: 'initialized', params: {} })

  return {
    open(file: string) {
      const text = readFileSync(`${project}/${file}`, 'utf8')
      send({ method: 'textDocument/didOpen', params: { textDocument: { uri: uri(file), languageId: file.endsWith('.ts') ? 'typescript' : 'wgsl', version: 1, text } } })
    },
    async definition(file: string, marker: string, offset = 0): Promise<Location[]> {
      const result = await request<Array<{ uri: string; range: LspRange }>>('textDocument/definition', position(file, marker, offset))
      return result.map((location) => toLocation(location.uri, location.range))
    },
    async references(file: string, marker: string, offset = 0): Promise<Location[]> {
      const result = await request<Array<{ uri: string; range: LspRange }>>('textDocument/references', { ...position(file, marker, offset), context: { includeDeclaration: true } })
      return result.map((location) => toLocation(location.uri, location.range))
    },
    async rename(file: string, marker: string, newName: string, offset = 0): Promise<Location[]> {
      const result = await request<{ changes: Record<string, Array<{ range: LspRange; newText: string }>> }>('textDocument/rename', { ...position(file, marker, offset), newName })
      return Object.entries(result.changes).flatMap(([fileUri, edits]) => edits.map((edit) => toLocation(fileUri, edit.range)))
    },
    close() {
      server.kill()
    },
  }
}

/** Sorts locations for comparison and renders them as `file:line:character`. */
export function where(locations: Location[]): string[] {
  return locations.map((location) => `${location.file}:${location.line}:${location.character}`).sort()
}
