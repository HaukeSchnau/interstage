import { runContentMapper, stringIndexToPosition } from 'ts-content-mapper'
import { compile } from './compile.ts'

runContentMapper({
  diagnosticSource: 'wgsl',
  transform({ content }, { positionEncoding }) {
    const { code, mappings, diagnostics } = compile(content, { navigation: true, positionEncoding })
    const position = (index: number) => stringIndexToPosition(content, index, positionEncoding)
    return {
      text: code,
      extension: '.mts',
      mappings,
      diagnostics: diagnostics.map((diagnostic) => ({
        messageText: diagnostic.message,
        start: position(diagnostic.start),
        length: position(diagnostic.end) - position(diagnostic.start),
        code: diagnostic.code,
      })),
    }
  },
})
