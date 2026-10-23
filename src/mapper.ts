import { runContentMapper, stringIndexToPosition, type OptionDiagnostic } from 'ts-content-mapper'
import { compile, DiagnosticCode } from './compile.ts'
import { createValidator, type Validator } from './validate.ts'

interface Options {
  /** Compile every shader with Tint through Dawn and report its errors. */
  validate?: boolean
}

interface Project {
  validator: Validator | undefined
}

runContentMapper<Options, Project>({
  diagnosticSource: 'wgsl',

  async openProject({ options = {} }) {
    const optionDiagnostics: OptionDiagnostic[] = Object.keys(options)
      .filter((key) => key !== 'validate')
      .map((key) => ({ path: [key], messageText: `Unknown option '${key}'`, code: DiagnosticCode.Option }))
    if (options.validate !== undefined && typeof options.validate !== 'boolean') {
      optionDiagnostics.push({ path: ['validate'], messageText: "'validate' must be true or false", code: DiagnosticCode.Option })
    }
    if (options.validate !== true) return { project: { validator: undefined }, optionDiagnostics }
    try {
      return { project: { validator: await createValidator() }, optionDiagnostics }
    } catch (error) {
      optionDiagnostics.push({ path: ['validate'], messageText: (error as Error).message, code: DiagnosticCode.Option })
      return { project: { validator: undefined }, optionDiagnostics }
    }
  },

  async transform({ content }, { positionEncoding, project }) {
    const { code, mappings, diagnostics } = compile(content, { navigation: true, positionEncoding })
    // Tint reports syntax errors too; one report of each is enough.
    if (project.validator && !diagnostics.some((diagnostic) => diagnostic.code === DiagnosticCode.Syntax)) {
      diagnostics.push(...(await project.validator(content)))
    }
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
