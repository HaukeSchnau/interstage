import assert from 'node:assert/strict'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { fixture, positionOf, tsc } from './helpers.ts'

test('a project that uses its shaders correctly type-checks', async () => {
  const { code, output } = await tsc(fixture('basic'))
  assert.equal(output, '')
  assert.equal(code, 0)
})

test('changing a shader breaks the TypeScript that relies on it', async () => {
  const project = copyFixture('basic', 'contract')
  edit(`${project}/src/particles.wgsl`, '  gravity: vec2f,', '  gravity: vec3f,')

  const { output } = await tsc(project)
  const main = readFileSync(`${project}/src/main.ts`, 'utf8')
  const at = (marker: string) => `src/main.ts(${positionOf(main, marker).line},`
  assert.deepEqual(errorLocations(output), [
    `${at('Expect<Equal<d.Infer<typeof Params>')} TS2344`,
    `${at('root.createBuffer(Params, {')} TS2769`,
    `${at('// @ts-expect-error `gravity` is a vec2f')} TS2578`,
  ])
})

test('a type error in the generated module points into the shader', async () => {
  const project = copyFixture('basic', 'unknown-type')
  edit(`${project}/src/particles.wgsl`, '  gravity: vec2f,', '  gravity: Vec5,')

  const { output } = await tsc(project)
  const shader = readFileSync(`${project}/src/particles.wgsl`, 'utf8')
  const { line, column } = positionOf(shader, 'Vec5')
  assert.match(output, new RegExp(`src/particles\\.wgsl\\(${line},${column}\\): error TS2304: Cannot find name 'Vec5'`))
})

test('mistakes in a shader are reported where they are in the .wgsl file', async () => {
  const { output } = await tsc(fixture('diagnostics'))
  assert.deepEqual(output.trim().split('\n'), [
    'src/broken.wgsl(7,10): error wgsl2: Pipeline-overridable constants are not supported yet; use const',
    "src/broken.wgsl(10,11): error wgsl3: @binding(0) is already used by 'light' in @group(0)",
    "src/broken.wgsl(12,16): error wgsl1: Expected an expression, found ';'",
    'src/broken.wgsl(15,6): error wgsl2: TypeGPU only has square f32 matrices (mat2x2f, mat3x3f, mat4x4f)',
    'src/broken.wgsl(19,25): error wgsl4: An array size must be an integer constant',
    "src/broken.wgsl(24,9): error wgsl5: 'LIMIT' shadows the module-scope constant that this function also uses; rename one of them",
    'src/broken.wgsl(31,10): error wgsl3: An entry point parameter needs @builtin or @location, or a struct type whose members have them',
  ])
})

test('with validation on, errors from Tint are reported in the .wgsl file', async () => {
  const { output } = await tsc(fixture('validated'))
  const shader = readFileSync(`${fixture('validated')}/src/light.wgsl`, 'utf8')
  const { line, column } = positionOf(shader, 'return light.color')
  assert.equal(
    output.trim(),
    `src/light.wgsl(${line},${column}): error wgsl100: return statement type must match its function return type, returned 'vec3<f32>', expected 'f32'`,
  )
})

test('with validation on and no GPU driver, the option says why it cannot validate', async () => {
  const { output } = await tsc(fixture('validated'), { VK_ICD_FILENAMES: '/nonexistent' })
  assert.match(output, /^tsconfig\.json\(\d+,\d+\): error wgsl6: Shader validation found no WebGPU adapter/)
})

function copyFixture(name: string, as: string): string {
  const target = new URL(`.tmp/${as}`, import.meta.url).pathname
  rmSync(target, { recursive: true, force: true })
  cpSync(fixture(name), target, { recursive: true })
  return target
}

function edit(file: string, from: string, to: string) {
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes(from), `${file} contains ${from}`)
  writeFileSync(file, text.replace(from, to))
}

/** `src/main.ts(24,` and the error code of every diagnostic, in order. */
function errorLocations(output: string): string[] {
  return [...output.matchAll(/^(\S+\(\d+,)\d+\): error (\w+)/gm)].map((match) => `${match[1]} ${match[2]}`)
}
