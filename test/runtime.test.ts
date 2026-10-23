import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { d, tgpu } from 'typegpu'
import * as compute from './fixtures/runtime/compute.wgsl'
import * as builtins from './fixtures/runtime/builtins.wgsl'
import * as structs from './fixtures/runtime/structs.wgsl'
import * as particles from './fixtures/basic/src/particles.wgsl'
import { compileErrors, gpu } from './gpu.ts'

// Render passes are checked in the browser (`examples/scripts/check.ts`): Dawn's render path
// crashes under Node with software Vulkan drivers, while shader compilation and compute work.

after(async () => (await gpu()).destroy())

test('every entry point resolves to WGSL that Tint accepts', async () => {
  const root = await gpu()
  const programs = [
    tgpu.resolve([particles.simulate]),
    tgpu.resolve([particles.vs, particles.fs]),
    tgpu.resolve([compute.main]),
    tgpu.resolve([structs.vs, structs.fs]),
    tgpu.resolve([builtins.vs, builtins.fs]),
  ]
  for (const code of programs) assert.deepEqual(await compileErrors(root, code), [], code)
})

test('a compute entry point runs with its constants, helper and binding', async () => {
  const root = await gpu()
  const items = root.createBuffer(d.arrayOf(compute.Item, compute.N)).$usage('storage')
  const bindGroup = root.createBindGroup(compute.layout0, { items })
  root.createComputePipeline({ compute: compute.main }).with(bindGroup).dispatchWorkgroups(compute.N / compute.HALF_N)

  const result = await items.read()
  const expected = (index: number) => index * compute.SCALE + compute.OFFSETS[index % 2]!.y
  assert.deepEqual(result[5], { value: expected(5), doubled: expected(5) * 2 })
  assert.deepEqual(result[compute.N - 1], { value: expected(compute.N - 1), doubled: expected(compute.N - 1) * 2 })
})
