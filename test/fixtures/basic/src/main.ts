import { d, tgpu, type TgpuRoot } from 'typegpu'
import { COUNT, CORNERS, UP, WORKGROUP, Params, Particle, layout0, layout1, simulate, vs, fs, wrap } from './particles.wgsl'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

// Constants are JavaScript values. Scalars keep their literal type.
export type Constants = [
  Expect<Equal<typeof COUNT, 4096>>,
  Expect<Equal<typeof WORKGROUP, 64>>,
  Expect<Equal<typeof UP, d.v2f>>,
  Expect<Equal<typeof CORNERS, d.v2f[]>>,
]

// Structs are TypeGPU schemas with the shader's member types.
export type Schemas = [
  Expect<Equal<d.Infer<typeof Particle>, { position: d.v2f; velocity: d.v2f; age: number }>>,
  Expect<Equal<d.Infer<typeof Params>, { dt: number; gravity: d.v2f }>>,
]

declare const root: TgpuRoot

const particles = root.createBuffer(d.arrayOf(Particle, COUNT)).$usage('storage')
const params = root.createBuffer(Params, { dt: 0.016, gravity: d.vec2f(0, -9.8) }).$usage('uniform')
const simulation = root.createBindGroup(layout0, { particles, params })
const drawing = root.createBindGroup(layout1, { particlesIn: particles })

root.createComputePipeline({ compute: simulate }).with(simulation).dispatchWorkgroups(COUNT / WORKGROUP)
root.createRenderPipeline({ vertex: vs, fragment: fs, targets: { format: 'rgba8unorm' } }).with(drawing)

// @ts-expect-error The shader binds `params` as a uniform, and this buffer has no uniform usage.
root.createBindGroup(layout0, { particles, params: root.createBuffer(Params) })

// @ts-expect-error The shader binds an array of particles here.
root.createBindGroup(layout1, { particlesIn: params })

// @ts-expect-error `gravity` is a vec2f in the shader.
params.write({ dt: 0.016, gravity: d.vec3f(0, -9.8, 0) })

// WGSL functions are typed TypeGPU functions that TypeScript shaders can call.
export const wrapAll = tgpu.fn([d.vec2f], d.vec2f)((p) => {
  'use gpu'
  return wrap(p)
})

export const wrongArgument = tgpu.fn([d.vec3f])((p) => {
  'use gpu'
  // @ts-expect-error `wrap` takes a vec2f.
  wrap(p)
})

export const speedOf = (particle: d.Infer<typeof Particle>) => particle.velocity
