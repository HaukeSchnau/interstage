import { tokenize, type Problem, type Span, type Token } from './lexer.ts'

export interface Ident extends Span {
  name: string
}

/** A token range that the module-scope parser does not interpret. */
export interface Expr extends Span {
  kind: 'expr'
  tokens: Token[]
}

export interface TypeExpr extends Span {
  kind: 'type'
  name: Ident
  args: TemplateArg[]
}

export type TemplateArg = TypeExpr | Expr

export interface Attribute extends Span {
  name: Ident
  args: Expr[]
}

export interface Member extends Span {
  attrs: Attribute[]
  name: Ident
  type: TypeExpr
}

export interface StructDecl extends Span {
  kind: 'struct'
  name: Ident
  members: Member[]
}

export interface AliasDecl extends Span {
  kind: 'alias'
  name: Ident
  type: TypeExpr
}

export interface ConstDecl extends Span {
  kind: 'const'
  name: Ident
  type: TypeExpr | undefined
  init: Expr
}

export interface OverrideDecl extends Span {
  kind: 'override'
  attrs: Attribute[]
  name: Ident
  type: TypeExpr | undefined
  init: Expr | undefined
}

export interface VarDecl extends Span {
  kind: 'var'
  attrs: Attribute[]
  /** Address space and access mode, as written in `var<storage, read_write>`. */
  template: Ident[]
  name: Ident
  type: TypeExpr | undefined
  init: Expr | undefined
}

export interface Param extends Span {
  attrs: Attribute[]
  name: Ident
  type: TypeExpr
}

export interface FnDecl extends Span {
  kind: 'fn'
  attrs: Attribute[]
  name: Ident
  params: Param[]
  returnAttrs: Attribute[]
  returnType: TypeExpr | undefined
  /** From `{` to `}` inclusive. */
  body: Expr
}

export type Decl = StructDecl | AliasDecl | ConstDecl | OverrideDecl | VarDecl | FnDecl

export interface WgslModule {
  decls: Decl[]
  problems: Problem[]
}

class ParseError extends Error {
  readonly span: Span

  constructor(message: string, span: Span) {
    super(message)
    this.span = span
  }
}

const DECLARATION_STARTS = new Set(['@', 'struct', 'alias', 'const', 'override', 'var', 'fn', 'enable', 'requires', 'diagnostic', 'const_assert'])

export function parse(source: string): WgslModule {
  const { tokens, problems } = tokenize(source)
  const decls: Decl[] = []
  let i = 0
  const end = source.length

  const peek = (offset = 0): Token | undefined => tokens[i + offset]
  const at = (text: string, offset = 0) => peek(offset)?.text === text && peek(offset)?.kind !== 'number'
  const fail = (message: string): never => {
    const token = peek()
    throw new ParseError(message, token ?? { start: end, end })
  }
  const next = (): Token => tokens[i++] ?? fail('Unexpected end of file')
  const expect = (text: string): Token => (at(text) ? next() : fail(`Expected '${text}'${describe(peek())}`))
  const ident = (): Ident => {
    const token = peek()
    if (token?.kind !== 'ident') return fail(`Expected an identifier${describe(token)}`)
    i++
    return { name: token.text, start: token.start, end: token.end }
  }
  const optional = (text: string): boolean => (at(text) ? (i++, true) : false)

  /** Tokens up to (not including) a terminator outside of brackets. */
  const expr = (terminators: readonly string[]): Expr => {
    const first = i
    let depth = 0
    while (i < tokens.length) {
      const token = tokens[i]!
      if (depth === 0 && token.kind === 'punct' && terminators.includes(token.text)) break
      if ('([{'.includes(token.text) && token.kind === 'punct') depth++
      if (')]}'.includes(token.text) && token.kind === 'punct') {
        if (depth === 0) break
        depth--
      }
      i++
    }
    if (i === first) fail(`Expected an expression${describe(peek())}`)
    const range = tokens.slice(first, i)
    return { kind: 'expr', tokens: range, start: range[0]!.start, end: range.at(-1)!.end }
  }

  const type = (): TypeExpr => {
    const name = ident()
    const args: TemplateArg[] = []
    if (optional('<')) {
      while (!at('>')) {
        args.push(templateArg())
        if (!optional(',')) break
      }
      expect('>')
    }
    return { kind: 'type', name, args, start: name.start, end: tokens[i - 1]!.end }
  }

  const templateArg = (): TemplateArg => {
    const first = i
    let depth = 0
    while (i < tokens.length) {
      const text = tokens[i]!.text
      if (depth === 0 && (text === ',' || text === '>')) break
      if (text === '<' || text === '(') depth++
      if (text === '>' || text === ')') depth--
      i++
    }
    const range = tokens.slice(first, i)
    if (range.length === 0) fail(`Expected a template argument${describe(peek())}`)
    const isType = range[0]!.kind === 'ident' && (range.length === 1 || (range[1]!.text === '<' && range.at(-1)!.text === '>'))
    if (!isType) return { kind: 'expr', tokens: range, start: range[0]!.start, end: range.at(-1)!.end }
    i = first
    return type()
  }

  const attributes = (): Attribute[] => {
    const attrs: Attribute[] = []
    while (at('@')) {
      const start = next().start
      const name = ident()
      const args: Expr[] = []
      if (optional('(')) {
        while (!at(')')) {
          args.push(expr([',', ')']))
          if (!optional(',')) break
        }
        expect(')')
      }
      attrs.push({ name, args, start, end: tokens[i - 1]!.end })
    }
    return attrs
  }

  const block = (): Expr => {
    const first = i
    expect('{')
    let depth = 1
    while (depth > 0) {
      const token = next()
      if (token.kind !== 'punct') continue
      if (token.text === '{') depth++
      if (token.text === '}') depth--
    }
    const range = tokens.slice(first, i)
    return { kind: 'expr', tokens: range, start: range[0]!.start, end: range.at(-1)!.end }
  }

  const declaration = (): Decl | undefined => {
    const start = peek()!.start
    const attrs = attributes()
    const keyword = next()
    const span = () => ({ start, end: tokens[i - 1]!.end })

    switch (keyword.text) {
      case 'struct': {
        const name = ident()
        expect('{')
        const members: Member[] = []
        while (!at('}')) {
          const memberStart = peek()?.start ?? end
          const memberAttrs = attributes()
          const memberName = ident()
          expect(':')
          members.push({ attrs: memberAttrs, name: memberName, type: type(), start: memberStart, end: tokens[i - 1]!.end })
          if (!optional(',') && !optional(';')) break
        }
        expect('}')
        optional(';')
        return { kind: 'struct', name, members, ...span() }
      }
      case 'alias': {
        const name = ident()
        expect('=')
        const aliased = type()
        expect(';')
        return { kind: 'alias', name, type: aliased, ...span() }
      }
      case 'const': {
        const name = ident()
        const declared = optional(':') ? type() : undefined
        expect('=')
        const init = expr([';'])
        expect(';')
        return { kind: 'const', name, type: declared, init, ...span() }
      }
      case 'override': {
        const name = ident()
        const declared = optional(':') ? type() : undefined
        const init = optional('=') ? expr([';']) : undefined
        expect(';')
        return { kind: 'override', attrs, name, type: declared, init, ...span() }
      }
      case 'var': {
        const template: Ident[] = []
        if (optional('<')) {
          while (!at('>')) {
            template.push(ident())
            if (!optional(',')) break
          }
          expect('>')
        }
        const name = ident()
        const declared = optional(':') ? type() : undefined
        const init = optional('=') ? expr([';']) : undefined
        expect(';')
        return { kind: 'var', attrs, template, name, type: declared, init, ...span() }
      }
      case 'fn': {
        const name = ident()
        expect('(')
        const params: Param[] = []
        while (!at(')')) {
          const paramStart = peek()?.start ?? end
          const paramAttrs = attributes()
          const paramName = ident()
          expect(':')
          params.push({ attrs: paramAttrs, name: paramName, type: type(), start: paramStart, end: tokens[i - 1]!.end })
          if (!optional(',')) break
        }
        expect(')')
        let returnAttrs: Attribute[] = []
        let returnType: TypeExpr | undefined
        if (optional('->')) {
          returnAttrs = attributes()
          returnType = type()
        }
        return { kind: 'fn', attrs, name, params, returnAttrs, returnType, body: block(), ...span() }
      }
      case 'enable':
      case 'requires':
      case 'diagnostic':
      case 'const_assert':
        expr([';'])
        expect(';')
        return undefined
      case ';':
        return undefined
      default:
        i--
        return fail(`Expected a declaration${describe(keyword)}`)
    }
  }

  /** Skips past the broken declaration: to its `;`, the `}` that closes it, or the next declaration. */
  const recover = (from: number) => {
    let depth = 0
    i = Math.max(i, from + 1)
    while (i < tokens.length) {
      const token = tokens[i]!
      if (depth === 0 && DECLARATION_STARTS.has(token.text) && token.kind !== 'number') return
      i++
      if (token.text === '{') depth++
      else if (token.text === '}' && --depth <= 0) return
      else if (token.text === ';' && depth === 0) return
    }
  }

  while (i < tokens.length) {
    const from = i
    try {
      const decl = declaration()
      if (decl) decls.push(decl)
    } catch (error) {
      if (!(error instanceof ParseError)) throw error
      problems.push({ message: error.message, ...error.span })
      recover(from)
    }
  }

  return { decls, problems }
}

function describe(token: Token | undefined): string {
  return token ? `, found '${token.text}'` : ' before the end of the file'
}
