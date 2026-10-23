import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { fixture, positionOf } from './helpers.ts'
import { languageServer, where } from './lsp.ts'

const project = fixture('basic')
const shader = readFileSync(`${project}/src/particles.wgsl`, 'utf8')
const main = readFileSync(`${project}/src/main.ts`, 'utf8')
let server: Awaited<ReturnType<typeof languageServer>>

/** `file:line:character` of `marker` in a fixture file, moved `offset` characters in. */
const at = (file: 'src/particles.wgsl' | 'src/main.ts', marker: string, offset = 0) => {
  const { line, column } = positionOf(file === 'src/main.ts' ? main : shader, marker)
  return `${file}:${line}:${column + offset}`
}

before(async () => {
  server = await languageServer(project)
  server.open('src/main.ts')
  server.open('src/particles.wgsl')
})
after(() => server.close())

test('go to definition on an imported struct opens its WGSL declaration', async () => {
  assert.deepEqual(where(await server.definition('src/main.ts', 'Particle, layout0')), [at('src/particles.wgsl', 'struct Particle', 7)])
})

test('renaming a WGSL function renames its calls in other shader functions and in TypeScript', async () => {
  const edits = where(await server.rename('src/particles.wgsl', 'fn wrap', 'wrapAround', 3))
  assert.deepEqual(edits, [
    at('src/main.ts', 'wrap }'),
    at('src/main.ts', 'return wrap(p)', 7),
    at('src/main.ts', '  wrap(p)', 2),
    at('src/particles.wgsl', 'fn wrap', 3),
    at('src/particles.wgsl', '= wrap(', 2),
  ].sort())
})

test('renaming a struct member in TypeScript renames it in the shader too', async () => {
  const edits = where(await server.rename('src/main.ts', 'particle.velocity', 'speed', 9))
  const shaderUses = [...shader.matchAll(/\.velocity\b/g)].map((match) => {
    const { line, column } = positionOf(shader.slice(0, match.index) + '\0', '\0')
    return `src/particles.wgsl:${line}:${column + 1}`
  })
  assert.deepEqual(edits, [at('src/main.ts', 'particle.velocity', 9), at('src/particles.wgsl', 'velocity: vec2f'), ...shaderUses].sort())
})

test('references to a binding include bind group entries and its uses in every shader function', async () => {
  const refs = where(await server.references('src/particles.wgsl', 'var<uniform> params', 13))
  const uses = [...shader.matchAll(/\bparams\./g)].map((match) => {
    const { line, column } = positionOf(shader.slice(0, match.index) + '\0', '\0')
    return `src/particles.wgsl:${line}:${column}`
  })
  const bindGroupKeys = [at('src/main.ts', 'params }'), at('src/main.ts', 'params: root.createBuffer(Params)')]
  assert.deepEqual(refs, [at('src/particles.wgsl', 'var<uniform> params', 13), ...bindGroupKeys, ...uses].sort())
})
