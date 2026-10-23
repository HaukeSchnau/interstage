export interface Span {
  start: number
  end: number
}

export type TokenKind = 'ident' | 'number' | 'punct'

export interface Token extends Span {
  kind: TokenKind
  text: string
}

export interface Problem extends Span {
  message: string
}

const IDENT = /[_\p{XID_Start}][\p{XID_Continue}]*/uy
const NUMBER = new RegExp(
  [
    /0[xX](?:[0-9a-fA-F]+\.[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?[fh]?/,
    /0[xX][0-9a-fA-F]+[pP][+-]?\d+[fh]?/,
    /0[xX][0-9a-fA-F]+[iu]?/,
    /(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?[fh]?/,
    /\d+[eE][+-]?\d+[fh]?/,
    /\d+[fh]/,
    /\d+[iu]?/,
  ]
    .map((part) => part.source)
    .join('|'),
  'y',
)
// `>` is always its own token so that `array<vec3<f32>>` closes two template lists.
// The expression evaluator recombines adjacent `>` tokens into `>>` and `>=`.
const PUNCT = /->|<<=|<<|<=|==|!=|&&|\|\||\+\+|--|[+\-*/%&|^]=|[@(){}[\]<>,;:.=+\-*/%&|^!~?]/y

export function tokenize(source: string): { tokens: Token[]; problems: Problem[] } {
  const tokens: Token[] = []
  const problems: Problem[] = []
  let i = 0

  const scan = (pattern: RegExp, kind: TokenKind): boolean => {
    pattern.lastIndex = i
    const match = pattern.exec(source)
    if (!match) return false
    tokens.push({ kind, text: match[0], start: i, end: i + match[0].length })
    i += match[0].length
    return true
  }

  while (i < source.length) {
    const char = source[i]!
    if (/\s/u.test(char)) {
      i++
    } else if (source.startsWith('//', i)) {
      const newline = source.indexOf('\n', i)
      i = newline === -1 ? source.length : newline
    } else if (source.startsWith('/*', i)) {
      const start = i
      let depth = 0
      do {
        if (source.startsWith('/*', i)) {
          depth++
          i += 2
        } else if (source.startsWith('*/', i)) {
          depth--
          i += 2
        } else {
          i++
        }
      } while (depth > 0 && i < source.length)
      if (depth > 0) problems.push({ message: 'Unterminated block comment', start, end: start + 2 })
    } else if (!(scan(NUMBER, 'number') || scan(IDENT, 'ident') || scan(PUNCT, 'punct'))) {
      problems.push({ message: `Unexpected character '${char}'`, start: i, end: i + 1 })
      i++
    }
  }
  return { tokens, problems }
}
