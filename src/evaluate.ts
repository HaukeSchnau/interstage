import type { Token } from './lexer.ts'
import type { Expr, TypeExpr } from './parser.ts'
import { concrete, concretize, describeTy, matrixShape, SCALARS, toTy, vectorShape, type Scalar, type Ty, type TypeScope } from './types.ts'

type ScalarTy = Extract<Ty, { kind: 'scalar' }>
type CompositeTy = Exclude<Ty, { kind: 'scalar' }>

export type Value = { ty: ScalarTy; value: number | boolean } | { ty: CompositeTy; parts: Value[] }

export interface ConstEnv {
  scope: TypeScope
  /** The value of a module-scope const, or throws when there is none. */
  lookup(name: string): Value
}

export class EvalError extends Error {}

const scalar = (type: Scalar, value: number | boolean): Value => ({ ty: { kind: 'scalar', scalar: type }, value })

const INT = new Set<Scalar>(['abstract-int', 'i32', 'u32'])
const FLOAT = new Set<Scalar>(['abstract-float', 'f32', 'f16'])

const MATH: Record<string, (...args: number[]) => number> = {
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  clamp: (x, low, high) => Math.min(Math.max(x, low), high),
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  pow: Math.pow,
  exp: Math.exp,
  exp2: (x) => 2 ** x,
  log: Math.log,
  log2: Math.log2,
  floor: Math.floor,
  ceil: Math.ceil,
  round: (x) => {
    const floor = Math.floor(x)
    const fraction = x - floor
    return fraction === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(x)
  },
  radians: (x) => (x * Math.PI) / 180,
  degrees: (x) => (x * 180) / Math.PI,
}

const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '<': 7,
  '>': 7,
  '<=': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
}

export function evaluate(expr: Expr, env: ConstEnv): Value {
  const tokens = expr.tokens
  let i = 0

  const peek = (): Token | undefined => tokens[i]
  const fail = (message: string): never => {
    throw new EvalError(message)
  }
  const expect = (text: string) => {
    if (peek()?.text !== text) fail(`Expected '${text}'`)
    i++
  }

  /** The operator at the cursor, joining `>` `>` into `>>` and `>` `=` into `>=`. */
  const operator = (): { text: string; length: number } | undefined => {
    const token = peek()
    if (token?.kind !== 'punct') return undefined
    const following = tokens[i + 1]
    if (token.text === '>' && following?.start === token.end && (following.text === '>' || following.text === '=')) {
      return { text: `>${following.text}`, length: 2 }
    }
    return { text: token.text, length: 1 }
  }

  const binary = (minimum: number): Value => {
    let left = unary()
    for (;;) {
      const op = operator()
      const precedence = op ? BINARY_PRECEDENCE[op.text] : undefined
      if (!op || precedence === undefined || precedence < minimum) return left
      i += op.length
      left = applyBinary(op.text, left, binary(precedence + 1))
    }
  }

  const unary = (): Value => {
    const token = peek()
    if (token?.kind === 'punct' && (token.text === '-' || token.text === '!' || token.text === '~')) {
      i++
      return mapScalars(unary(), (v) => {
        if (token.text === '!') {
          if (v.ty.scalar !== 'bool') fail(`'!' needs a bool`)
          return scalar('bool', !v.value)
        }
        if (v.ty.scalar === 'bool') fail(`'${token.text}' needs a number`)
        if (token.text === '-') return checked(v.ty.scalar, -(v.value as number))
        if (!INT.has(v.ty.scalar)) fail(`'~' needs an integer`)
        return checked(v.ty.scalar, v.ty.scalar === 'u32' ? ~(v.value as number) >>> 0 : ~(v.value as number))
      })
    }
    return postfix(primary())
  }

  const postfix = (value: Value): Value => {
    for (;;) {
      if (peek()?.text === '.') {
        i++
        const member = peek()
        if (member?.kind !== 'ident') fail('Expected a member name')
        i++
        value = access(value, member!.text)
      } else if (peek()?.text === '[') {
        i++
        const index = binary(1)
        expect(']')
        if (index.ty.kind !== 'scalar' || !INT.has(index.ty.scalar)) fail('An index must be an integer')
        if (!('parts' in value)) return fail('Only vectors, matrices and arrays can be indexed')
        const part = value.parts[(index as { value: number }).value]
        if (!part) fail('Index out of bounds')
        value = part!
      } else {
        return value
      }
    }
  }

  const primary = (): Value => {
    const token = peek() ?? fail('Unexpected end of expression')
    i++
    if (token.kind === 'number') return literal(token.text)
    if (token.text === '(') {
      const inner = binary(1)
      expect(')')
      return inner
    }
    if (token.kind !== 'ident') return fail(`Unexpected '${token.text}'`)
    if (token.text === 'true' || token.text === 'false') return scalar('bool', token.text === 'true')

    let template: TypeExpr | undefined
    if (peek()?.text === '<') {
      template = templateType(token)
    }
    if (peek()?.text !== '(') {
      if (template) fail(`Expected '(' after '${template.name.name}<...>'`)
      return env.lookup(token.text)
    }
    i++
    const args: Value[] = []
    while (peek()?.text !== ')') {
      args.push(binary(1))
      if (peek()?.text !== ',') break
      i++
    }
    expect(')')
    return call(token.text, template, args)
  }

  /** Reads `<...>` after a constructor name and returns it as a type. */
  const templateType = (name: Token): TypeExpr => {
    const start = i
    let depth = 0
    do {
      const token = peek() ?? fail('Unterminated template list')
      if (token.text === '<') depth++
      if (token.text === '>') depth--
      i++
    } while (depth > 0)
    const range = [name, ...tokens.slice(start, i)]
    return parseTemplate(range)
  }

  const call = (name: string, template: TypeExpr | undefined, args: Value[]): Value => {
    const math = MATH[name]
    if (math && !template) return callMath(name, math, args)
    if (name === 'array') {
      if (template) return construct(toTy(template, env.scope), args)
      const first = args[0] ?? fail('array() needs at least one element')
      const element = args.slice(1).reduce((ty, arg) => unifyTy(ty, arg.ty), first.ty)
      return construct({ kind: 'array', element, count: args.length }, args)
    }
    if (SCALARS.has(name)) return construct({ kind: 'scalar', scalar: name as Scalar }, args)
    const declared = template ? toTy(template, env.scope) : undefined
    const declaredScalar = declared?.kind === 'vector' || declared?.kind === 'matrix' ? declared.scalar : undefined
    const vector = vectorShape(name)
    if (vector) {
      const element = vector.scalar ?? declaredScalar ?? inferElement(args)
      return construct({ kind: 'vector', size: vector.size, scalar: element }, args)
    }
    const matrix = matrixShape(name)
    if (matrix) {
      const element = matrix.scalar ?? declaredScalar ?? inferElement(args)
      return construct({ kind: 'matrix', columns: matrix.columns, rows: matrix.rows, scalar: element }, args)
    }
    if (env.scope.structs.has(name) || env.scope.aliases.has(name)) {
      return construct(toTy({ kind: 'type', name: { name, start: 0, end: 0 }, args: [], start: 0, end: 0 }, env.scope), args)
    }
    return fail(`'${name}' can't be evaluated as a constant`)
  }

  const result = binary(1)
  if (i < tokens.length) fail(`Unexpected '${tokens[i]!.text}'`)
  return result
}

function parseTemplate(tokens: Token[]): TypeExpr {
  let i = 0
  const type = (): TypeExpr => {
    const name = tokens[i++]!
    const args: TypeExpr['args'] = []
    if (tokens[i]?.text === '<') {
      i++
      while (tokens[i] && tokens[i]!.text !== '>') {
        if (tokens[i]!.kind === 'ident') {
          args.push(type())
        } else {
          const start = i
          while (tokens[i] && tokens[i]!.text !== ',' && tokens[i]!.text !== '>') i++
          const range = tokens.slice(start, i)
          args.push({ kind: 'expr', tokens: range, start: range[0]!.start, end: range.at(-1)!.end })
        }
        if (tokens[i]?.text === ',') i++
      }
      i++
    }
    return { kind: 'type', name: { name: name.text, start: name.start, end: name.end }, args, start: name.start, end: tokens[i - 1]!.end }
  }
  return type()
}

function literal(text: string): Value {
  const suffix = /[iufh]$/.test(text) && !/^0[xX][0-9a-fA-F]*$/.test(text.slice(0, -1)) ? text.at(-1) : undefined
  const hexInt = /^0[xX][0-9a-fA-F]+[iu]?$/.test(text)
  if (hexInt) {
    const value = Number.parseInt(text.replace(/[iu]$/, ''), 16)
    return checked(text.endsWith('u') ? 'u32' : text.endsWith('i') ? 'i32' : 'abstract-int', value)
  }
  const body = suffix ? text.slice(0, -1) : text
  const isFloat = /[.eEpP]/.test(body) || suffix === 'f' || suffix === 'h'
  if (/^0[xX]/.test(body)) throw new EvalError('Hexadecimal floats are not supported in constants')
  const value = Number(body)
  if (Number.isNaN(value)) throw new EvalError(`Invalid number '${text}'`)
  const type: Scalar = suffix === 'f' ? 'f32' : suffix === 'h' ? 'f16' : suffix === 'u' ? 'u32' : suffix === 'i' ? 'i32' : isFloat ? 'abstract-float' : 'abstract-int'
  return checked(type, value)
}

function checked(type: Scalar, value: number): Value {
  if (!Number.isFinite(value)) throw new EvalError('A constant overflowed or divided by zero')
  if (type === 'u32' && (value < 0 || value > 0xffffffff)) throw new EvalError(`${value} doesn't fit in u32`)
  if (type === 'i32' && (value < -0x80000000 || value > 0x7fffffff)) throw new EvalError(`${value} doesn't fit in i32`)
  return scalar(type, INT.has(type) ? Math.trunc(value) : value)
}

function unifyScalar(a: Scalar, b: Scalar): Scalar {
  if (a === b) return a
  if (a === 'abstract-int' && b !== 'bool') return b
  if (b === 'abstract-int' && a !== 'bool') return a
  if (a === 'abstract-float' && FLOAT.has(b)) return b
  if (b === 'abstract-float' && FLOAT.has(a)) return a
  throw new EvalError(`Can't combine ${a} with ${b}`)
}

function unifyTy(a: Ty, b: Ty): Ty {
  if (a.kind === 'scalar' && b.kind === 'scalar') return { kind: 'scalar', scalar: unifyScalar(a.scalar, b.scalar) }
  if (a.kind === 'vector' && b.kind === 'vector' && a.size === b.size) return { ...a, scalar: unifyScalar(a.scalar, b.scalar) }
  if (a.kind === 'matrix' && b.kind === 'matrix' && a.columns === b.columns && a.rows === b.rows) return { ...a, scalar: unifyScalar(a.scalar, b.scalar) }
  if (JSON.stringify(a) === JSON.stringify(b)) return a
  throw new EvalError(`Can't combine ${describeTy(a)} with ${describeTy(b)}`)
}

function inferElement(args: Value[]): Scalar {
  return args.map((arg) => arg.ty.kind === 'scalar' || arg.ty.kind === 'vector' ? arg.ty.scalar : 'abstract-int').reduce(unifyScalar, 'abstract-int')
}

function flattenScalars(value: Value): Array<Extract<Value, { value: unknown }>> {
  return 'value' in value ? [value] : value.parts.flatMap(flattenScalars)
}

/** Converts a value to a type it can implicitly convert to, or throws. */
export function convert(value: Value, ty: Ty): Value {
  if (ty.kind === 'scalar') {
    if (!('value' in value)) throw new EvalError(`Expected ${describeTy(ty)}, got ${describeTy(value.ty)}`)
    const target = unifyScalar(value.ty.scalar, ty.scalar)
    if (target !== ty.scalar) throw new EvalError(`Expected ${ty.scalar}, got ${value.ty.scalar}`)
    return checked(target, value.value as number)
  }
  if ('value' in value || value.ty.kind !== ty.kind) throw new EvalError(`Expected ${describeTy(ty)}, got ${describeTy(value.ty)}`)
  const elements = elementTypes(ty)
  if (elements.length !== value.parts.length) throw new EvalError(`Expected ${describeTy(ty)}, got ${describeTy(value.ty)}`)
  return { ty, parts: value.parts.map((part, index) => convert(part, elements[index]!)) }
}

function elementTypes(ty: CompositeTy): Ty[] {
  switch (ty.kind) {
    case 'vector':
      return Array.from({ length: ty.size }, () => ({ kind: 'scalar', scalar: ty.scalar }))
    case 'matrix':
      return Array.from({ length: ty.columns }, () => ({ kind: 'vector', size: ty.rows, scalar: ty.scalar }))
    case 'array':
      return Array.from({ length: ty.count }, () => ty.element)
    case 'struct':
      return ty.members.map(([, member]) => member)
  }
}

function zero(ty: Ty): Value {
  if (ty.kind === 'scalar') return scalar(ty.scalar, ty.scalar === 'bool' ? false : 0)
  return { ty, parts: elementTypes(ty).map(zero) }
}

function construct(ty: Ty, args: Value[]): Value {
  if (args.length === 0) return zero(ty)
  switch (ty.kind) {
    case 'scalar': {
      const [arg] = args
      if (args.length !== 1 || !arg || !('value' in arg)) throw new EvalError(`${ty.scalar}() takes one scalar`)
      if (ty.scalar === 'bool') return scalar('bool', Boolean(arg.value))
      const number = Number(arg.value)
      return checked(ty.scalar, INT.has(ty.scalar) ? Math.trunc(number) : number)
    }
    case 'vector':
    case 'matrix': {
      const element: Scalar = ty.scalar
      const scalars = args.flatMap(flattenScalars).map((part) => (ty.kind === 'vector' ? construct({ kind: 'scalar', scalar: element }, [part]) : convert(part, { kind: 'scalar', scalar: element })))
      const total = ty.kind === 'vector' ? ty.size : ty.columns * ty.rows
      const filled = scalars.length === 1 && ty.kind === 'vector' ? Array.from({ length: total }, () => scalars[0]!) : scalars
      if (filled.length !== total) throw new EvalError(`${describeTy(ty)} needs ${total} components, got ${filled.length}`)
      if (ty.kind === 'vector') return { ty, parts: filled }
      const columns = Array.from({ length: ty.columns }, (_, column): Value => ({
        ty: { kind: 'vector', size: ty.rows, scalar: element },
        parts: filled.slice(column * ty.rows, (column + 1) * ty.rows),
      }))
      return { ty, parts: columns }
    }
    case 'array':
    case 'struct':
      return convert({ ty, parts: args }, ty)
  }
}

function mapScalars(value: Value, map: (scalar: Extract<Value, { value: unknown }>) => Value): Value {
  if ('value' in value) return map(value)
  if (value.ty.kind !== 'vector') throw new EvalError(`Can't apply this operator to ${describeTy(value.ty)}`)
  const parts = value.parts.map((part) => map(part as Extract<Value, { value: unknown }>))
  const first = parts[0]!.ty as ScalarTy
  return { ty: { ...value.ty, scalar: first.scalar }, parts }
}

function applyBinary(op: string, left: Value, right: Value): Value {
  const leftParts = 'value' in left ? undefined : left.parts
  const rightParts = 'value' in right ? undefined : right.parts
  if ((leftParts && left.ty.kind !== 'vector') || (rightParts && right.ty.kind !== 'vector')) {
    throw new EvalError(`'${op}' only works on scalars and vectors in constants`)
  }
  if (leftParts || rightParts) {
    const size = (leftParts ?? rightParts)!.length
    if (leftParts && rightParts && leftParts.length !== rightParts.length) throw new EvalError(`'${op}' needs vectors of the same size`)
    const parts = Array.from({ length: size }, (_, index) =>
      applyBinary(op, leftParts ? leftParts[index]! : left, rightParts ? rightParts[index]! : right),
    )
    const first = parts[0]!.ty as ScalarTy
    return { ty: { kind: 'vector', size, scalar: first.scalar }, parts }
  }
  const a = left as Extract<Value, { value: unknown }>
  const b = right as Extract<Value, { value: unknown }>
  if (op === '&&' || op === '||') {
    if (a.ty.scalar !== 'bool' || b.ty.scalar !== 'bool') throw new EvalError(`'${op}' needs bools`)
    return scalar('bool', op === '&&' ? (a.value as boolean) && (b.value as boolean) : (a.value as boolean) || (b.value as boolean))
  }
  const type = op === '<<' || op === '>>' ? a.ty.scalar : unifyScalar(a.ty.scalar, b.ty.scalar)
  const x = a.value as number
  const y = b.value as number
  switch (op) {
    case '==':
      return scalar('bool', x === y)
    case '!=':
      return scalar('bool', x !== y)
    case '<':
      return scalar('bool', x < y)
    case '>':
      return scalar('bool', x > y)
    case '<=':
      return scalar('bool', x <= y)
    case '>=':
      return scalar('bool', x >= y)
  }
  if (type === 'bool') throw new EvalError(`'${op}' needs numbers`)
  const integer = INT.has(type)
  switch (op) {
    case '+':
      return checked(type, x + y)
    case '-':
      return checked(type, x - y)
    case '*':
      return checked(type, x * y)
    case '/':
      if (integer && y === 0) throw new EvalError('Division by zero')
      return checked(type, integer ? Math.trunc(x / y) : x / y)
    case '%':
      if (integer && y === 0) throw new EvalError('Division by zero')
      return checked(type, x % y)
  }
  if (!integer) throw new EvalError(`'${op}' needs integers`)
  const unsigned = type === 'u32'
  const wrap = (n: number) => (unsigned ? n >>> 0 : n | 0)
  switch (op) {
    case '&':
      return checked(type, wrap(x & y))
    case '|':
      return checked(type, wrap(x | y))
    case '^':
      return checked(type, wrap(x ^ y))
    case '<<':
      return checked(type, type === 'abstract-int' ? x * 2 ** y : wrap(x << y))
    case '>>':
      return checked(type, type === 'abstract-int' ? Math.floor(x / 2 ** y) : unsigned ? x >>> y : x >> y)
  }
  throw new EvalError(`Unsupported operator '${op}'`)
}

function callMath(name: string, math: (...args: number[]) => number, args: Value[]): Value {
  const scalars = args.map((arg) => {
    if (!('value' in arg) || arg.ty.scalar === 'bool') throw new EvalError(`${name}() takes numbers in constants`)
    return arg as Extract<Value, { value: unknown }>
  })
  const type = scalars.map((arg) => arg.ty.scalar).reduce(unifyScalar)
  const keepsIntegers = ['abs', 'min', 'max', 'clamp'].includes(name)
  const resultType: Scalar = INT.has(type) && !keepsIntegers ? (type === 'abstract-int' ? 'abstract-float' : needsFloat(name, type)) : type
  return checked(resultType, math(...scalars.map((arg) => arg.value as number)))
}

function needsFloat(name: string, type: Scalar): never {
  throw new EvalError(`${name}() needs a float, got ${type}`)
}

function access(value: Value, member: string): Value {
  if (value.ty.kind === 'struct' && 'parts' in value) {
    const index = value.ty.members.findIndex(([name]) => name === member)
    if (index === -1) throw new EvalError(`${value.ty.name} has no member '${member}'`)
    return value.parts[index]!
  }
  if (value.ty.kind === 'vector' && 'parts' in value) {
    const indices = [...member].map((char) => 'xyzw'.indexOf(char) >= 0 ? 'xyzw'.indexOf(char) : 'rgba'.indexOf(char))
    if (indices.some((index) => index < 0 || index >= value.parts.length)) throw new EvalError(`Invalid swizzle '.${member}'`)
    if (indices.length === 1) return value.parts[indices[0]!]!
    return { ty: { kind: 'vector', size: indices.length, scalar: value.ty.scalar }, parts: indices.map((index) => value.parts[index]!) }
  }
  throw new EvalError(`Can't read '.${member}' of ${describeTy(value.ty)}`)
}

/** The value's type with abstract numbers made concrete, as WGSL does for a `const` without a type. */
export function concreteTy(value: Value): Ty {
  return concretize(value.ty)
}

export function isAbstractScalar(value: Value): value is Extract<Value, { value: unknown }> {
  return 'value' in value && (value.ty.scalar === 'abstract-int' || value.ty.scalar === 'abstract-float')
}

/** JavaScript for the value: numbers, booleans, TypeGPU vectors and matrices, arrays and objects. */
export function toJs(value: Value): string {
  if ('value' in value) return formatNumber(value.value)
  switch (value.ty.kind) {
    case 'vector':
    case 'matrix': {
      const schema = value.ty.kind === 'vector'
        ? `d.vec${value.ty.size}${suffix(value.ty.scalar)}`
        : `d.mat${value.ty.columns}x${value.ty.rows}${suffix(value.ty.scalar)}`
      return `${schema}(${value.parts.map(toJs).join(', ')})`
    }
    case 'array':
      return `[${value.parts.map(toJs).join(', ')}]`
    case 'struct': {
      const members = value.ty.members
      return `{ ${value.parts.map((part, index) => `${members[index]![0]}: ${toJs(part)}`).join(', ')} }`
    }
  }
}

function suffix(scalar: Scalar): string {
  return { i32: 'i', u32: 'u', f32: 'f', f16: 'h', bool: 'b', 'abstract-int': 'i', 'abstract-float': 'f' }[concrete(scalar)]
}

function formatNumber(value: number | boolean): string {
  if (typeof value === 'boolean') return String(value)
  return Object.is(value, -0) ? '-0' : String(value)
}
