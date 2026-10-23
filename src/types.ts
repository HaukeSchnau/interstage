import type { AliasDecl, Decl, StructDecl, TypeExpr } from './parser.ts'

export type Scalar = 'abstract-int' | 'abstract-float' | 'i32' | 'u32' | 'f32' | 'f16' | 'bool'

/** The WGSL types that const-expressions can produce. */
export type Ty =
  | { kind: 'scalar'; scalar: Scalar }
  | { kind: 'vector'; size: number; scalar: Scalar }
  | { kind: 'matrix'; columns: number; rows: number; scalar: Scalar }
  | { kind: 'array'; element: Ty; count: number }
  | { kind: 'struct'; name: string; members: Array<[name: string, type: Ty]> }

export const SCALARS = new Set(['i32', 'u32', 'f32', 'f16', 'bool'])

const SHORTHAND_SCALAR: Record<string, Scalar> = { i: 'i32', u: 'u32', f: 'f32', h: 'f16' }
const SCALAR_SUFFIX: Partial<Record<Scalar, string>> = {
  i32: 'i',
  u32: 'u',
  f32: 'f',
  f16: 'h',
  bool: 'b',
  'abstract-int': 'i',
  'abstract-float': 'f',
}

/** `vec3f` → 3 and f32, `vec3` → 3 and no element type. */
export function vectorShape(name: string): { size: number; scalar: Scalar | undefined } | undefined {
  const match = /^vec([234])([iufh]?)$/.exec(name)
  if (!match) return undefined
  return { size: Number(match[1]), scalar: match[2] ? SHORTHAND_SCALAR[match[2]] : undefined }
}

export function matrixShape(name: string): { columns: number; rows: number; scalar: Scalar | undefined } | undefined {
  const match = /^mat([234])x([234])([fh]?)$/.exec(name)
  if (!match) return undefined
  return { columns: Number(match[1]), rows: Number(match[2]), scalar: match[3] ? SHORTHAND_SCALAR[match[3]] : undefined }
}

export function concrete(scalar: Scalar): Scalar {
  if (scalar === 'abstract-int') return 'i32'
  if (scalar === 'abstract-float') return 'f32'
  return scalar
}

export function concretize(ty: Ty): Ty {
  switch (ty.kind) {
    case 'scalar':
    case 'vector':
    case 'matrix':
      return { ...ty, scalar: concrete(ty.scalar) }
    case 'array':
      return { ...ty, element: concretize(ty.element) }
    case 'struct':
      return ty
  }
}

/** TypeGPU schema code for a type, such as `d.vec3f` or `d.arrayOf(d.f32, 4)`. */
export function schemaOf(ty: Ty): string {
  switch (ty.kind) {
    case 'scalar':
      return `d.${concrete(ty.scalar)}`
    case 'vector':
      return `d.vec${ty.size}${SCALAR_SUFFIX[ty.scalar]}`
    case 'matrix':
      return `d.mat${ty.columns}x${ty.rows}${SCALAR_SUFFIX[ty.scalar]}`
    case 'array':
      return `d.arrayOf(${schemaOf(ty.element)}, ${ty.count})`
    case 'struct':
      return ty.name
  }
}

export function sameTy(a: Ty, b: Ty): boolean {
  return JSON.stringify(concretize(a)) === JSON.stringify(concretize(b))
}

export function describeTy(ty: Ty): string {
  switch (ty.kind) {
    case 'scalar':
      return ty.scalar
    case 'vector':
      return `vec${ty.size}<${ty.scalar}>`
    case 'matrix':
      return `mat${ty.columns}x${ty.rows}<${ty.scalar}>`
    case 'array':
      return `array<${describeTy(ty.element)}, ${ty.count}>`
    case 'struct':
      return ty.name
  }
}

export interface TypeScope {
  structs: Map<string, StructDecl>
  aliases: Map<string, AliasDecl>
  /** Resolves an array element count written as a const-expression. */
  count(expr: TypeExpr['args'][number]): number
}

export function scopeOf(decls: Decl[], count: TypeScope['count']): TypeScope {
  const structs = new Map<string, StructDecl>()
  const aliases = new Map<string, AliasDecl>()
  for (const decl of decls) {
    if (decl.kind === 'struct') structs.set(decl.name.name, decl)
    if (decl.kind === 'alias') aliases.set(decl.name.name, decl)
  }
  return { structs, aliases, count }
}

/** Resolves a written type to the value type a const-expression can have, or throws. */
export function toTy(type: TypeExpr, scope: TypeScope, seen = new Set<string>()): Ty {
  const name = type.name.name
  const elementOf = (index: number): Scalar | undefined => {
    const arg = type.args[index]
    if (arg?.kind !== 'type') return undefined
    const inner = toTy(arg, scope, seen)
    if (inner.kind !== 'scalar') throw new Error(`Expected a scalar type in '${name}'`)
    return inner.scalar
  }
  if (SCALARS.has(name)) return { kind: 'scalar', scalar: name as Scalar }
  const vector = vectorShape(name)
  if (vector) {
    const scalar = vector.scalar ?? elementOf(0)
    if (!scalar) throw new Error(`'${name}' needs an element type`)
    return { kind: 'vector', size: vector.size, scalar }
  }
  const matrix = matrixShape(name)
  if (matrix) {
    const scalar = matrix.scalar ?? elementOf(0)
    if (!scalar) throw new Error(`'${name}' needs an element type`)
    return { kind: 'matrix', columns: matrix.columns, rows: matrix.rows, scalar }
  }
  if (name === 'array') {
    const [element, count] = type.args
    if (element?.kind !== 'type' || !count) throw new Error('A constant array needs an element type and a count')
    return { kind: 'array', element: toTy(element, scope, seen), count: scope.count(count) }
  }
  if (seen.has(name)) throw new Error(`'${name}' refers to itself`)
  const struct = scope.structs.get(name)
  if (struct) {
    const nested = new Set(seen).add(name)
    return {
      kind: 'struct',
      name,
      members: struct.members.map((member) => [member.name.name, toTy(member.type, scope, nested)]),
    }
  }
  const alias = scope.aliases.get(name)
  if (alias) return toTy(alias.type, scope, new Set(seen).add(name))
  throw new Error(`'${name}' is not a type a constant can have`)
}
