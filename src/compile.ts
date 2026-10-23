import { MappedCodeBuilder, SpanMapFeature, type PositionEncoding, type SpanMapping } from 'ts-content-mapper'
import { convert, EvalError, evaluate, isAbstractScalar, toJs, type ConstEnv, type Value } from './evaluate.ts'
import type { Span, Token } from './lexer.ts'
import { parse, type Attribute, type ConstDecl, type Decl, type Expr, type FnDecl, type Ident, type StructDecl, type TemplateArg, type TypeExpr, type VarDecl } from './parser.ts'
import { matrixShape, schemaOf, scopeOf, toTy, vectorShape, type TypeScope } from './types.ts'

export interface Diagnostic extends Span {
  message: string
  code: DiagnosticCode
}

export const DiagnosticCode = {
  Syntax: 1,
  Unsupported: 2,
  Invalid: 3,
  NotConstant: 4,
  Name: 5,
} as const

export type DiagnosticCode = (typeof DiagnosticCode)[keyof typeof DiagnosticCode]

export interface CompileOptions {
  /**
   * Adds a statement that maps every identifier reference inside function bodies, so that
   * references, rename and go-to-definition reach into the shader code. Only the content mapper
   * needs it; at runtime it would be dead code.
   */
  navigation?: boolean
  positionEncoding?: PositionEncoding
}

export interface CompileResult {
  /** A TypeScript module that is also valid JavaScript. */
  code: string
  mappings: SpanMapping[]
  diagnostics: Diagnostic[]
}

const BUILTINS: Record<string, string> = {
  vertex_index: 'vertexIndex',
  instance_index: 'instanceIndex',
  clip_distances: 'clipDistances',
  position: 'position',
  front_facing: 'frontFacing',
  frag_depth: 'fragDepth',
  primitive_index: 'primitiveIndex',
  sample_index: 'sampleIndex',
  sample_mask: 'sampleMask',
  local_invocation_id: 'localInvocationId',
  local_invocation_index: 'localInvocationIndex',
  global_invocation_id: 'globalInvocationId',
  workgroup_id: 'workgroupId',
  num_workgroups: 'numWorkgroups',
  subgroup_invocation_id: 'subgroupInvocationId',
  subgroup_size: 'subgroupSize',
  subgroup_id: 'subgroupId',
  num_subgroups: 'numSubgroups',
}

const SAMPLED_TEXTURES: Record<string, string> = {
  texture_1d: 'texture1d',
  texture_2d: 'texture2d',
  texture_2d_array: 'texture2dArray',
  texture_3d: 'texture3d',
  texture_cube: 'textureCube',
  texture_cube_array: 'textureCubeArray',
  texture_multisampled_2d: 'textureMultisampled2d',
}

const DEPTH_TEXTURES: Record<string, string> = {
  texture_depth_2d: 'textureDepth2d',
  texture_depth_2d_array: 'textureDepth2dArray',
  texture_depth_cube: 'textureDepthCube',
  texture_depth_cube_array: 'textureDepthCubeArray',
  texture_depth_multisampled_2d: 'textureDepthMultisampled2d',
}

const STORAGE_TEXTURES: Record<string, string> = {
  texture_storage_1d: 'textureStorage1d',
  texture_storage_2d: 'textureStorage2d',
  texture_storage_2d_array: 'textureStorage2dArray',
  texture_storage_3d: 'textureStorage3d',
}

const STORAGE_TEXTURE_ACCESS: Record<string, string> = { read: 'read-only', write: 'write-only', read_write: 'read-write' }

const POINTERS: Record<string, string> = {
  function: 'ptrFn',
  private: 'ptrPrivate',
  workgroup: 'ptrWorkgroup',
  uniform: 'ptrUniform',
  storage: 'ptrStorage',
}

/** Names a module can't export: JavaScript's reserved words, and the bindings the module itself declares. */
const RESERVED = new Set(
  'await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield arguments eval tgpu d'.split(
    ' ',
  ),
)

const STAGES = ['compute', 'vertex', 'fragment'] as const
type Stage = (typeof STAGES)[number]

/** A module-scope identifier written somewhere other than its declaration. */
interface Reference extends Span {
  name: string
}

export function compile(source: string, options: CompileOptions = {}): CompileResult {
  const module = parse(source)
  const diagnostics: Diagnostic[] = module.problems.map((problem) => ({ ...problem, code: DiagnosticCode.Syntax }))
  const report = (span: Span, code: DiagnosticCode, message: string) => {
    diagnostics.push({ start: span.start, end: span.end, code, message })
  }

  const decls = new Map<string, Decl>()
  for (const decl of module.decls) {
    const name = decl.name.name
    if (decls.has(name)) report(decl.name, DiagnosticCode.Name, `'${name}' is already declared in this module`)
    else if (RESERVED.has(name)) report(decl.name, DiagnosticCode.Name, `'${name}' can't be exported to TypeScript; rename it`)
    else decls.set(name, decl)
  }

  // Constants, evaluated on demand so that their order in the file doesn't matter.
  const constValues = new Map<string, Value | EvalError>()
  const evaluating = new Set<string>()
  const env: ConstEnv = {
    scope: undefined as unknown as TypeScope,
    lookup(name) {
      const cached = constValues.get(name)
      if (cached instanceof EvalError) throw cached
      if (cached) return cached
      const decl = decls.get(name)
      if (decl?.kind !== 'const') throw new EvalError(`'${name}' is not a constant`)
      if (evaluating.has(name)) throw new EvalError(`'${name}' depends on itself`)
      evaluating.add(name)
      try {
        const raw = evaluate(decl.init, env)
        const value = decl.type ? convert(raw, toTy(decl.type, env.scope)) : raw
        constValues.set(name, value)
        return value
      } catch (error) {
        const failure = error instanceof EvalError ? error : new EvalError(error instanceof Error ? error.message : String(error))
        constValues.set(name, failure)
        throw failure
      } finally {
        evaluating.delete(name)
      }
    },
  }
  const constant = (expr: Expr): Value => evaluate(expr, env)
  const integer = (arg: TemplateArg | Expr, what: string): number | undefined => {
    const expr: Expr = arg.kind === 'expr' ? arg : asExpr(arg)
    try {
      const value = constant(expr)
      if ('value' in value && typeof value.value === 'number' && Number.isInteger(value.value)) return value.value
      report(expr, DiagnosticCode.NotConstant, `${what} must be an integer constant`)
    } catch (error) {
      report(expr, DiagnosticCode.NotConstant, `${what} must be a constant: ${(error as Error).message}`)
    }
    return undefined
  }
  env.scope = scopeOf(module.decls, (arg) => {
    const count = integer(arg, 'An array size')
    if (count === undefined) throw new EvalError('Invalid array size')
    return count
  })

  const b = new MappedCodeBuilder(source, { positionEncoding: options.positionEncoding ?? 'utf-16' })
  const name = (ident: Ident) => b.appendVerbatim(ident.start, ident.end)
  const navigation: Reference[] = []

  // --- Types ---------------------------------------------------------------------------------

  /** Appends the TypeGPU schema for a written type. */
  const schema = (type: TypeExpr, where: 'binding' | 'value' = 'value'): void => {
    const typeName = type.name.name
    const decl = decls.get(typeName)
    if (decl?.kind === 'struct' || decl?.kind === 'alias') {
      name(type.name)
      return
    }
    const element = (index: number) => {
      const arg = type.args[index]
      if (arg?.kind === 'type') schema(arg)
      else {
        report(type, DiagnosticCode.Invalid, `'${typeName}' needs an element type`)
        b.append('d.f32')
      }
    }
    const scalarName = (index: number): string | undefined => {
      const arg = type.args[index]
      return arg?.kind === 'type' ? arg.name.name : undefined
    }

    if (['f32', 'f16', 'i32', 'u32', 'bool'].includes(typeName)) {
      b.append(`d.${typeName}`)
      return
    }
    const vector = vectorShape(typeName)
    if (vector) {
      const scalar = vector.scalar ?? scalarName(0)
      const suffix = { f32: 'f', f16: 'h', i32: 'i', u32: 'u', bool: 'b' }[scalar ?? ''] ?? ''
      if (!suffix) report(type, DiagnosticCode.Invalid, `'${typeName}' needs a scalar element type`)
      b.append(`d.vec${vector.size}${suffix || 'f'}`)
      return
    }
    const matrix = matrixShape(typeName)
    if (matrix) {
      const scalar = matrix.scalar ?? scalarName(0)
      if (matrix.columns !== matrix.rows || scalar !== 'f32') {
        report(type, DiagnosticCode.Unsupported, `TypeGPU only has square f32 matrices (mat2x2f, mat3x3f, mat4x4f)`)
      }
      b.append(`d.mat${matrix.columns}x${matrix.columns}f`)
      return
    }
    switch (typeName) {
      case 'array': {
        const count = type.args[1]
        b.append('d.arrayOf(')
        element(0)
        if (count) b.append(`, ${integer(count, 'An array size') ?? 0}`)
        else if (where !== 'binding') report(type, DiagnosticCode.Unsupported, 'Runtime-sized arrays are only supported as a whole storage binding')
        b.append(')')
        return
      }
      case 'atomic':
        b.append('d.atomic(')
        element(0)
        b.append(')')
        return
      case 'ptr': {
        const space = scalarName(0) ?? ''
        const pointer = POINTERS[space]
        if (!pointer) report(type, DiagnosticCode.Unsupported, `Pointers to the '${space}' address space are not supported`)
        b.append(`d.${pointer ?? 'ptrFn'}(`)
        element(1)
        if (space === 'storage' && scalarName(2) === 'read_write') b.append(`, 'read-write'`)
        b.append(')')
        return
      }
    }
    const texture = textureSchema(type)
    if (texture) {
      b.append(texture)
      return
    }
    // Unknown names go through as written, so that TypeScript reports them at this spot.
    name(type.name)
  }

  const textureSchema = (type: TypeExpr): string | undefined => {
    const typeName = type.name.name
    const [first, second] = type.args.map((arg) => (arg.kind === 'type' ? arg.name.name : ''))
    if (typeName in SAMPLED_TEXTURES) return `d.${SAMPLED_TEXTURES[typeName]}(d.${first || 'f32'})`
    if (typeName in DEPTH_TEXTURES) return `d.${DEPTH_TEXTURES[typeName]}()`
    if (typeName in STORAGE_TEXTURES) {
      const access = STORAGE_TEXTURE_ACCESS[second ?? 'write'] ?? 'write-only'
      return `d.${STORAGE_TEXTURES[typeName]}(${JSON.stringify(first)}, '${access}')`
    }
    if (typeName === 'texture_external') return 'd.textureExternal()'
    return undefined
  }

  /** Appends a schema wrapped in the TypeGPU decorators for its attributes. */
  const decorated = (type: TypeExpr, attrs: Attribute[]): void => {
    const builtin = attrs.find((attr) => attr.name.name === 'builtin')
    if (builtin) {
      const written = builtin.args[0]?.tokens[0]?.text ?? ''
      const key = BUILTINS[written]
      if (!key) report(builtin, DiagnosticCode.Unsupported, `TypeGPU has no '${written}' builtin`)
      b.append(`d.builtin.${key ?? 'position'}`)
      return
    }
    const wrappers: Array<[open: string, close: string]> = []
    for (const attr of attrs) {
      const value = () => (attr.args[0] ? integer(attr.args[0], `@${attr.name.name}`) ?? 0 : 0)
      switch (attr.name.name) {
        case 'align':
        case 'size':
        case 'location':
          wrappers.push([`d.${attr.name.name}(${value()}, `, ')'])
          break
        case 'interpolate': {
          const parts = attr.args.map((arg) => arg.tokens.map((token) => token.text).join(''))
          wrappers.push([`d.interpolate(${JSON.stringify(parts.join(', '))}, `, ')'])
          break
        }
        case 'invariant':
          wrappers.push(['d.invariant(', ')'])
          break
        default:
          report(attr, DiagnosticCode.Unsupported, `@${attr.name.name} is not supported here`)
      }
    }
    // The outermost decorator comes first in TypeGPU, so `@location` must wrap `@interpolate`.
    wrappers.sort(([a], [b_]) => Number(b_.startsWith('d.location')) - Number(a.startsWith('d.location')))
    for (const [open] of wrappers) b.append(open)
    schema(type)
    for (const [, close] of wrappers.reverse()) b.append(close)
  }

  // --- Declarations --------------------------------------------------------------------------

  b.append(`import { tgpu, d } from 'typegpu';\n`)

  const typeDecls = sortByDependencies(
    module.decls.filter((decl) => decl.kind === 'struct' || decl.kind === 'alias'),
    (decl) => typeNamesIn(decl.kind === 'struct' ? decl.members.map((member) => member.type) : [decl.type]),
  )
  for (const decl of typeDecls) {
    if (decls.get(decl.name.name) !== decl) continue
    b.append('\nexport const ')
    name(decl.name)
    if (decl.kind === 'alias') {
      b.append(' = ')
      schema(decl.type)
      b.append(';\n')
      continue
    }
    b.append(' = d.struct({\n')
    for (const member of decl.members) {
      b.append('  ')
      name(member.name)
      b.append(': ')
      decorated(member.type, member.attrs)
      b.append(',\n')
    }
    b.append(`}).$name(${JSON.stringify(decl.name.name)});\n`)
    if (decl.members.length === 0) report(decl.name, DiagnosticCode.Invalid, 'A struct needs at least one member')
  }

  /** What a function body's reference to a name resolves to in `$uses`. */
  const gpuValue = new Map<string, string>()

  /** Constants the shader receives as text, which a same-named local would break. */
  const inlined = new Set<string>()

  const constDecls = sortByDependencies(
    module.decls.filter((decl): decl is ConstDecl => decl.kind === 'const' && decls.get(decl.name.name) === decl),
    (decl) => referencesIn(decl.init.tokens, decls).map((ref) => ref.name),
  )
  constDecls.forEach(emitConst)
  for (const decl of module.decls) {
    if (decl.kind === 'override') {
      report(decl.name, DiagnosticCode.Unsupported, 'Pipeline-overridable constants are not supported yet; use const')
    }
  }

  function emitConst(decl: ConstDecl) {
    const constName = decl.name.name
    let value: Value | undefined
    try {
      value = env.lookup(constName)
    } catch {
      // Not every const-expression can be evaluated here; such a constant is inlined into the
      // shader as written, and TypeScript code can't read it.
    }
    if (!value) {
      const refs = referencesIn(decl.init.tokens, decls)
      b.append('\nconst ')
      name(decl.name)
      b.append(`$gpu = tgpu['~unstable'].rawCodeSnippet(${JSON.stringify(`(${textOf(source, decl.init)})`)}, `)
      if (decl.type) schema(decl.type)
      else b.append('d.f32')
      b.append(`, 'constant')`)
      if (refs.length > 0) b.append(`.$uses({ ${usesEntries(refs)} })`)
      b.append(';\n')
      gpuValue.set(constName, `${constName}$gpu`)
      inlined.add(constName)
      navigation.push(...refs)
      return
    }
    b.append('\nexport const ')
    name(decl.name)
    b.append(` = ${toJs(value)};\n`)
    if (isAbstractScalar(value)) {
      gpuValue.set(constName, constName)
      inlined.add(constName)
      return
    }
    b.append(`const ${constName}$gpu = tgpu.const(`)
    if (decl.type) schema(decl.type)
    else b.append(schemaOf(value.ty))
    b.append(`, ${constName}).$name(${JSON.stringify(constName)});\n`)
    gpuValue.set(constName, `${constName}$gpu`)
  }

  // Bindings, one layout per group.
  const groups = new Map<number, Array<{ decl: VarDecl; binding: number; group: Attribute }>>()
  for (const decl of module.decls) {
    if (decl.kind !== 'var' || decls.get(decl.name.name) !== decl) continue
    const space = decl.template[0]?.name
    const groupAttr = decl.attrs.find((attr) => attr.name.name === 'group')
    const bindingAttr = decl.attrs.find((attr) => attr.name.name === 'binding')
    if (space === 'private' || space === 'workgroup') {
      emitVar(decl, space)
      continue
    }
    if (!groupAttr?.args[0] || !bindingAttr?.args[0]) {
      report(decl.name, DiagnosticCode.Invalid, 'A resource needs @group and @binding attributes')
      continue
    }
    const group = integer(groupAttr.args[0], '@group')
    const binding = integer(bindingAttr.args[0], '@binding')
    if (group === undefined || binding === undefined) continue
    const entries = groups.get(group) ?? []
    const taken = entries.find((entry) => entry.binding === binding)
    if (taken) report(bindingAttr, DiagnosticCode.Invalid, `@binding(${binding}) is already used by '${taken.decl.name.name}' in @group(${group})`)
    else entries.push({ decl, binding, group: groupAttr })
    groups.set(group, entries)
  }

  function emitVar(decl: VarDecl, space: 'private' | 'workgroup') {
    if (!decl.type) {
      report(decl.name, DiagnosticCode.Invalid, 'A module-scope variable needs a type')
      return
    }
    b.append('\nexport const ')
    name(decl.name)
    b.append(` = tgpu.${space}Var(`)
    schema(decl.type)
    if (decl.init) {
      if (space === 'workgroup') report(decl.init, DiagnosticCode.Invalid, 'Workgroup variables cannot have an initializer')
      try {
        b.append(`, ${toJs(convert(constant(decl.init), toTy(decl.type, env.scope)))}`)
      } catch (error) {
        report(decl.init, DiagnosticCode.NotConstant, `The initializer must be a constant: ${(error as Error).message}`)
      }
    }
    b.append(`).$name(${JSON.stringify(decl.name.name)});\n`)
    gpuValue.set(decl.name.name, decl.name.name)
  }

  const layoutNames = new Map<string, string>()
  for (const [group, entries] of [...groups].sort(([a], [b_]) => a - b_)) {
    const layoutName = `layout${group}`
    if (decls.has(layoutName)) {
      report(decls.get(layoutName)!.name, DiagnosticCode.Name, `'${layoutName}' is the name of the @group(${group}) layout; rename this declaration`)
    }
    entries.sort((x, y) => x.binding - y.binding)
    b.append('\nexport const ')
    b.appendAtom(layoutName, entries[0]!.group.start, entries[0]!.group.end, SpanMapFeature.Definition | SpanMapFeature.Hover)
    b.append(' = tgpu.bindGroupLayout({\n')
    let next = 0
    for (const { decl, binding } of entries) {
      for (; next < binding; next++) b.append(`  _${next}: null,\n`)
      next = binding + 1
      b.append('  ')
      name(decl.name)
      b.append(': ')
      layoutEntry(decl)
      b.append(',\n')
      layoutNames.set(decl.name.name, layoutName)
      gpuValue.set(decl.name.name, `get ${decl.name.name}() { return ${layoutName}.$.${decl.name.name}; }`)
    }
    b.append(`}).$idx(${group}).$name(${JSON.stringify(layoutName)});\n`)
  }

  function layoutEntry(decl: VarDecl) {
    const [space, access] = decl.template.map((ident) => ident.name)
    if (!decl.type) {
      report(decl.name, DiagnosticCode.Invalid, 'A resource needs a type')
      b.append('null')
      return
    }
    if (decl.init) report(decl.init, DiagnosticCode.Invalid, 'Resources cannot have an initializer')
    if (space === 'uniform') {
      b.append('{ uniform: ')
      schema(decl.type)
      b.append(' }')
      return
    }
    if (space === 'storage') {
      b.append('{ storage: ')
      schema(decl.type, 'binding')
      b.append(`, access: '${access === 'read_write' ? 'mutable' : 'readonly'}' }`)
      return
    }
    const typeName = decl.type.name.name
    if (typeName === 'sampler' || typeName === 'sampler_comparison') {
      b.append(`{ sampler: '${typeName === 'sampler' ? 'filtering' : 'comparison'}' }`)
      return
    }
    const texture = textureSchema(decl.type)
    if (texture) {
      const kind = typeName in STORAGE_TEXTURES ? 'storageTexture' : typeName === 'texture_external' ? 'externalTexture' : 'texture'
      b.append(`{ ${kind}: ${texture} }`)
      return
    }
    report(decl.type, DiagnosticCode.Unsupported, space ? `var<${space}> is not supported as a binding` : `'${typeName}' is not a resource type`)
    b.append('null')
  }

  // Functions. `$uses` comes after every declaration, so that the order of functions in the
  // file doesn't matter.
  const wiring: Array<{ fn: string; refs: Reference[] }> = []
  for (const decl of module.decls) {
    if (decl.kind !== 'fn' || decls.get(decl.name.name) !== decl) continue
    const stage = STAGES.find((candidate) => decl.attrs.some((attr) => attr.name.name === candidate))
    const { refs, locals } = scanBody(decl, decls)
    for (const local of locals) {
      if (inlined.has(local.name) && refs.some((ref) => ref.name === local.name)) {
        report(local, DiagnosticCode.Name, `'${local.name}' shadows the module-scope constant that this function also uses; rename one of them`)
      }
    }
    navigation.push(...refs)
    navigation.push(...decl.attrs.flatMap((attr) => attr.args.flatMap((arg) => referencesIn(arg.tokens, decls))))
    const bodyRefs = stage ? emitEntry(decl, stage, refs) : emitFn(decl, refs)
    if (bodyRefs.length > 0) wiring.push({ fn: decl.name.name, refs: bodyRefs })
  }

  function emitFn(decl: FnDecl, refs: Reference[]): Reference[] {
    b.append('\nexport const ')
    name(decl.name)
    b.append(' = tgpu.fn([')
    decl.params.forEach((param, index) => {
      if (index > 0) b.append(', ')
      schema(param.type)
    })
    b.append(']')
    if (decl.returnType) {
      b.append(', ')
      schema(decl.returnType)
    }
    const header = `(${decl.params.map((param) => param.name.name).join(', ')}) `
    b.append(`)(${template(header + textOf(source, decl.body))}).$name(${JSON.stringify(decl.name.name)});\n`)
    return refs
  }

  function emitEntry(decl: FnDecl, stage: Stage, refs: Reference[]): Reference[] {
    const edits: Array<Span & { text: string }> = []
    const inputs: Array<{ key: string; span: Span; emit: () => void }> = []
    const prologue: string[] = []
    const extraRefs: Reference[] = []
    const positional = (attrs: Attribute[]) => stage === 'vertex' || attrs.some((attr) => attr.name.name === 'builtin')
    const ioAttrs = (attrs: Attribute[]) => attrs.some((attr) => attr.name.name === 'builtin' || attr.name.name === 'location')

    for (const param of decl.params) {
      if (ioAttrs(param.attrs)) {
        inputs.push({ key: param.name.name, span: param.name, emit: () => decorated(param.type, param.attrs) })
        if (!positional(param.attrs)) prologue.push(`let ${param.name.name} = in.${param.name.name};`)
        continue
      }
      const struct = decls.get(param.type.name.name)
      if (struct?.kind !== 'struct') {
        report(param, DiagnosticCode.Invalid, 'An entry point parameter needs @builtin or @location, or a struct type whose members have them')
        continue
      }
      for (const member of struct.members) {
        if (!ioAttrs(member.attrs)) report(member, DiagnosticCode.Invalid, `'${member.name.name}' needs @builtin or @location to be an entry point input`)
        inputs.push({ key: member.name.name, span: param.name, emit: () => decorated(member.type, member.attrs) })
      }
      const args = struct.members.map((member) => (positional(member.attrs) ? member.name.name : `in.${member.name.name}`))
      prologue.push(`let ${param.name.name} = ${struct.name.name}(${args.join(', ')});`)
      extraRefs.push({ name: struct.name.name, start: param.type.start, end: param.type.end })
    }
    const seen = new Map<string, Span>()
    for (const input of inputs) {
      if (seen.has(input.key)) report(input.span, DiagnosticCode.Name, `Two entry point inputs are named '${input.key}'; TypeGPU needs unique names`)
      seen.set(input.key, input.span)
    }
    for (const reserved of ['in', 'Out']) {
      const clash = decl.params.find((param) => param.name.name === reserved) ?? scanIdents(decl.body.tokens).find((token) => token.text === reserved)
      if (clash) report(clash, DiagnosticCode.Name, `'${reserved}' is reserved in TypeGPU entry points; rename it`)
    }

    let bodyRefs = [...refs, ...extraRefs]
    const returned = decl.returnType ? decls.get(decl.returnType.name.name) : undefined
    let output: (() => void) | undefined
    if (decl.returnType && returned?.kind === 'struct') {
      // TypeGPU generates the output struct itself and calls it `Out` inside the body.
      const outStruct = returned
      output = () => ioRecord(outStruct)
      for (const ref of refs.filter((ref) => ref.name === outStruct.name.name)) edits.push({ ...ref, text: 'Out' })
      bodyRefs = bodyRefs.filter((ref) => ref.name !== outStruct.name.name)
      extraRefs.push({ name: outStruct.name.name, start: decl.returnType.start, end: decl.returnType.end })
    } else if (decl.returnType) {
      const returnType = decl.returnType
      const builtin = decl.returnAttrs.find((attr) => attr.name.name === 'builtin')
      if (builtin) {
        const key = BUILTINS[builtin.args[0]?.tokens[0]?.text ?? ''] ?? 'position'
        output = () => {
          b.append(`{ ${key}: `)
          decorated(returnType, decl.returnAttrs)
          b.append(' }')
        }
        edits.push(...wrapReturns(decl.body.tokens))
      } else if (stage === 'fragment') {
        output = () => decorated(returnType, decl.returnAttrs)
      } else {
        report(returnType, DiagnosticCode.Invalid, 'A vertex entry point must return a struct or @builtin(position)')
      }
    }
    if (stage !== 'compute' && !output) report(decl.name, DiagnosticCode.Unsupported, `A ${stage} entry point without outputs is not supported`)
    if (stage === 'compute' && decl.returnType) report(decl.returnType, DiagnosticCode.Invalid, 'A compute entry point cannot return a value')

    if (prologue.length > 0) {
      const open = decl.body.start + 1
      edits.push({ start: open, end: open, text: `\n  ${prologue.join('\n  ')}` })
    }

    b.append('\nexport const ')
    name(decl.name)
    b.append(` = tgpu.${stage}Fn({ `)
    if (inputs.length > 0) {
      b.append('in: { ')
      for (const input of inputs) {
        b.append(`${input.key}: `)
        input.emit()
        b.append(', ')
      }
      b.append('}, ')
    }
    if (stage === 'compute') {
      const size = decl.attrs.find((attr) => attr.name.name === 'workgroup_size')
      const dimensions = size?.args.map((arg) => integer(arg, '@workgroup_size') ?? 1) ?? []
      if (!size) report(decl.name, DiagnosticCode.Invalid, 'A compute entry point needs @workgroup_size')
      b.append(`workgroupSize: [${dimensions.join(', ') || '1'}] `)
    } else if (output) {
      b.append('out: ')
      output()
      b.append(' ')
    }
    b.append(`})(${template(applyEdits(source, decl.body, edits))}).$name(${JSON.stringify(decl.name.name)});\n`)
    navigation.push(...extraRefs.filter((ref) => ref.start !== ref.end))
    return bodyRefs
  }

  function ioRecord(struct: StructDecl) {
    b.append('{ ')
    for (const member of struct.members) {
      b.append(`${member.name.name}: `)
      decorated(member.type, member.attrs)
      b.append(', ')
    }
    b.append('}')
  }

  function usesEntries(refs: Reference[]): string {
    const names = [...new Set(refs.map((ref) => ref.name))]
    return names
      .map((refName) => {
        const value = gpuValue.get(refName) ?? refName
        return value.startsWith('get ') ? value : value === refName ? refName : `${refName}: ${value}`
      })
      .join(', ')
  }

  if (wiring.length > 0) b.append('\n')
  for (const { fn, refs } of wiring) b.append(`${fn}.$uses({ ${usesEntries(refs)} });\n`)

  if (options.navigation && navigation.length > 0) {
    // Maps each reference to its declaration's TypeScript binding, for references and rename.
    b.append('\nvoid [')
    for (const ref of navigation) {
      const layout = layoutNames.get(ref.name)
      if (layout) b.append(`${layout}.entries.`)
      b.appendVerbatim(ref.start, ref.end)
      b.append(', ')
    }
    b.append('];\n')
  }

  if (b.text.trim() === `import { tgpu, d } from 'typegpu';`) b.append('export {};\n')

  const output = b.build('.mts')
  diagnostics.sort((x, y) => x.start - y.start)
  return { code: output.text, mappings: output.mappings ?? [], diagnostics }
}

// --- Helpers -----------------------------------------------------------------------------------

function textOf(source: string, span: Span): string {
  return source.slice(span.start, span.end)
}

function template(text: string): string {
  return `\`${text.replace(/[\\`]|\$\{/g, (match) => `\\${match}`)}\``
}

function asExpr(type: TypeExpr): Expr {
  return { kind: 'expr', tokens: [{ kind: 'ident', text: type.name.name, start: type.name.start, end: type.name.end }], start: type.start, end: type.end }
}

function applyEdits(source: string, span: Span, edits: Array<Span & { text: string }>): string {
  let text = ''
  let cursor = span.start
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    text += source.slice(cursor, edit.start) + edit.text
    cursor = edit.end
  }
  return text + source.slice(cursor, span.end)
}

function typeNamesIn(types: TypeExpr[]): string[] {
  return types.flatMap((type) => [type.name.name, ...typeNamesIn(type.args.filter((arg): arg is TypeExpr => arg.kind === 'type'))])
}

function sortByDependencies<T extends { name: Ident }>(items: T[], dependencies: (item: T) => string[]): T[] {
  const byName = new Map(items.map((item) => [item.name.name, item]))
  const sorted: T[] = []
  const visited = new Set<string>()
  const visit = (item: T) => {
    if (visited.has(item.name.name)) return
    visited.add(item.name.name)
    for (const dependency of dependencies(item)) {
      const target = byName.get(dependency)
      if (target) visit(target)
    }
    sorted.push(item)
  }
  items.forEach(visit)
  return sorted
}

function scanIdents(tokens: Token[]): Token[] {
  return tokens.filter((token, index) => token.kind === 'ident' && tokens[index - 1]?.text !== '.' && tokens[index - 1]?.text !== '@')
}

/** Module-scope names in a token range with no local declarations, such as a const initializer. */
function referencesIn(tokens: Token[], decls: Map<string, Decl>): Reference[] {
  return scanIdents(tokens)
    .filter((token) => decls.has(token.text))
    .map((token) => ({ name: token.text, start: token.start, end: token.end }))
}

const DECLARATION_KEYWORDS = new Set(['let', 'var', 'const'])

/**
 * Finds the module-scope names a function body refers to, honouring WGSL's block scoping: a
 * local declaration hides a module-scope name from the end of its statement to the end of its
 * block.
 */
function scanBody(fn: FnDecl, decls: Map<string, Decl>): { refs: Reference[]; locals: Reference[] } {
  const tokens = fn.body.tokens
  const scopes: Array<Set<string>> = [new Set(fn.params.map((param) => param.name.name))]
  const forScopes: number[] = []
  const pending: Array<{ name: string; scope: Set<string> }> = []
  const refs: Reference[] = []
  const locals: Reference[] = fn.params.filter((param) => decls.has(param.name.name)).map((param) => ({ ...param.name }))
  let depth = 0

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    const previous = tokens[index - 1]
    if (token.kind === 'punct') {
      if (token.text === '{') {
        scopes.push(new Set())
        depth++
      } else if (token.text === '}') {
        scopes.pop()
        depth--
        while (forScopes.at(-1) === depth) {
          forScopes.pop()
          scopes.pop()
        }
      } else if (token.text === ';') {
        for (const declared of pending.splice(0)) declared.scope.add(declared.name)
      }
      continue
    }
    if (token.kind !== 'ident' || previous?.text === '.' || previous?.text === '@') continue
    if (token.text === 'for') {
      scopes.push(new Set())
      forScopes.push(depth)
      continue
    }
    if (DECLARATION_KEYWORDS.has(token.text)) {
      let cursor = index + 1
      if (tokens[cursor]?.text === '<') while (tokens[cursor] && tokens[cursor]!.text !== '>') cursor++
      if (tokens[cursor]?.text === '>') cursor++
      const declared = tokens[cursor]
      if (declared?.kind === 'ident') {
        pending.push({ name: declared.text, scope: scopes.at(-1)! })
        if (decls.has(declared.text)) locals.push({ name: declared.text, start: declared.start, end: declared.end })
        index = cursor
      }
      continue
    }
    if (scopes.some((scope) => scope.has(token.text))) continue
    if (decls.has(token.text)) refs.push({ name: token.text, start: token.start, end: token.end })
  }
  return { refs, locals }
}

/** Edits that turn `return x;` into `return Out(x);`. */
function wrapReturns(tokens: Token[]): Array<Span & { text: string }> {
  const edits: Array<Span & { text: string }> = []
  tokens.forEach((token, index) => {
    if (token.text !== 'return' || token.kind !== 'ident') return
    const first = tokens[index + 1]
    if (!first || first.text === ';') return
    let depth = 0
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const text = tokens[cursor]!.text
      if (text === '(' || text === '[') depth++
      if (text === ')' || text === ']') depth--
      if (text === ';' && depth === 0) {
        edits.push({ start: first.start, end: first.start, text: 'Out(' }, { start: tokens[cursor]!.start, end: tokens[cursor]!.start, text: ')' })
        return
      }
    }
  })
  return edits
}
