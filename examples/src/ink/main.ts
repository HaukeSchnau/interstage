import { d } from 'typegpu'
import { demo, quality } from '../shell.ts'
import * as ink from './ink.wgsl'
import shader from './ink.wgsl?raw'
import declarations from '../../.contract/ink/ink.d.wgsl.ts?raw'
import host from './main.ts?raw'

const app = await demo({
  title: 'Ink',
  description: [
    'Drag through the water to push ink around. When you stop, an invisible brush keeps painting.',
    'Nine entry points share one shader module and one bind group layout, <code>layout1</code>. TypeScript checks that every buffer bound to it holds the type the shader reads.',
  ],
  controls: [
    { key: 'swirl', label: 'Swirl', wgsl: 'swirl', min: 0, max: 40, step: 1, value: 12 },
    { key: 'dyeDissipation', label: 'Fade', wgsl: 'dyeDissipation', min: 0, max: 2, step: 0.05, value: 0.35 },
    { key: 'velocityDissipation', label: 'Calm', wgsl: 'velocityDissipation', min: 0, max: 2, step: 0.05, value: 0.2 },
    { key: 'radius', label: 'Brush', wgsl: 'radius', min: 1, max: 12, step: 0.5, value: 4 },
    { key: 'iterations', label: 'Pressure passes', min: 4, max: 60, step: 1, value: quality === 'low' ? 10 : 30 },
  ],
  actions: [{ label: 'Clear the water', run: () => {
    world = createWorld()
  } }],
  contract: {
    shaders: [{ shaderName: 'ink.wgsl', shader, declarations }],
    host,
    hostName: 'main.ts',
  },
})

const { root, values, pointer } = app
const params = root.createBuffer(ink.Params).$usage('uniform')
const shared = root.createBindGroup(ink.layout0, { params })
const passes = {
  curl: root.createComputePipeline({ compute: ink.computeCurl }),
  vorticity: root.createComputePipeline({ compute: ink.confineVorticity }),
  splat: root.createComputePipeline({ compute: ink.splat }),
  advectVelocity: root.createComputePipeline({ compute: ink.advectVelocity }),
  advectDye: root.createComputePipeline({ compute: ink.advectDye }),
  divergence: root.createComputePipeline({ compute: ink.computeDivergence }),
  relax: root.createComputePipeline({ compute: ink.relaxPressure }),
  project: root.createComputePipeline({ compute: ink.project }),
}
const render = root.createRenderPipeline({ vertex: ink.fullscreen, fragment: ink.render, targets: { format: app.format } })

const flip = (side: 0 | 1) => (side === 0 ? 1 : 0)

function createWorld() {
  const rows = quality === 'low' ? 72 : 256
  const columns = Math.round((rows * app.canvas.width) / Math.max(1, app.canvas.height))
  const cells = rows * columns
  const vectors = () => root.createBuffer(d.arrayOf(d.vec2f, cells)).$usage('storage')
  const colors = () => root.createBuffer(d.arrayOf(d.vec4f, cells)).$usage('storage')
  const scalars = () => root.createBuffer(d.arrayOf(d.f32, cells)).$usage('storage')
  const velocity = [vectors(), vectors()] as const
  const dye = [colors(), colors()] as const
  const pressure = [scalars(), scalars()] as const
  const divergence = scalars()
  const curl = scalars()
  /** Which buffer of each pair is the input. */
  const current: Record<'velocity' | 'dye' | 'pressure', 0 | 1> = { velocity: 0, dye: 0, pressure: 0 }
  const groups = new Map<string, ReturnType<typeof bind>>()
  const bind = (v: 0 | 1, c: 0 | 1, p: 0 | 1) =>
    root.createBindGroup(ink.layout1, {
      velocityIn: velocity[v],
      velocityOut: velocity[flip(v)],
      dyeIn: dye[c],
      dyeOut: dye[flip(c)],
      pressureIn: pressure[p],
      pressureOut: pressure[flip(p)],
      divergence,
      curl,
    })
  const group = () => {
    const key = `${current.velocity}${current.dye}${current.pressure}`
    if (!groups.has(key)) groups.set(key, bind(current.velocity, current.dye, current.pressure))
    return groups.get(key)!
  }
  return { size: d.vec2f(columns, rows), current, group, buffers: [...velocity, ...dye, ...pressure, divergence, curl] }
}

let world = createWorld()
app.onResize(() => {
  for (const buffer of world.buffers) buffer.destroy()
  world = createWorld()
})

let hue = Math.random()
// Start as if the pointer had been idle, so that the first strokes come right away.
let idle = 1.5
let nextStroke = 0

/** An idle brush stroke: it travels along a curve for a moment, laying down ink and force. */
interface Stroke {
  x: number
  y: number
  angle: number
  turn: number
  remaining: number
  color: d.v3f
}
let strokes: Stroke[] = []

interface Splat {
  at: d.v2f
  force: d.v2f
  color: d.v3f
  /** Multiplies the brush size. */
  size: number
}

function writeParams(dt: number, splat: Splat) {
  params.write({
    size: world.size,
    canvas: d.vec2f(app.canvas.width, app.canvas.height),
    pointer: splat.at,
    force: splat.force,
    color: splat.color,
    radius: values.radius * splat.size * (world.size.y / 256),
    dt,
    velocityDissipation: values.velocityDissipation,
    dyeDissipation: values.dyeDissipation,
    swirl: values.swirl,
  })
}

function color(): d.v3f {
  hue = (hue + 0.61803) % 1
  const channel = (offset: number) => 0.5 + 0.5 * Math.cos(2 * Math.PI * (hue + offset))
  return d.vec3f(channel(0) * 4, channel(0.33) * 4, channel(0.67) * 4)
}

app.run(({ dt }) => {
  const tiles = [Math.ceil(world.size.x / ink.WORKGROUP), Math.ceil(world.size.y / ink.WORKGROUP)] as const
  const run = (pass: (typeof passes)[keyof typeof passes], swap: Array<keyof typeof world.current>) => {
    pass.with(shared).with(world.group()).dispatchWorkgroups(...tiles)
    for (const field of swap) world.current[field] = flip(world.current[field])
  }

  let splat: Splat | undefined
  const moving = pointer.down && Math.hypot(pointer.dx, pointer.dy) > 0
  idle = moving ? 0 : idle + dt
  if (moving) {
    splat = {
      at: d.vec2f(pointer.x * world.size.x, pointer.y * world.size.y),
      force: d.vec2f((0.6 * pointer.dx * world.size.x) / dt, (0.6 * pointer.dy * world.size.y) / dt),
      color: color(),
      size: 1,
    }
  } else if (idle > 1.5) {
    if ((nextStroke -= dt) <= 0) {
      nextStroke = 0.5 + Math.random() * 0.7
      strokes.push({
        x: 0.2 + Math.random() * 0.6,
        y: 0.2 + Math.random() * 0.6,
        angle: Math.random() * Math.PI * 2,
        turn: (Math.random() - 0.5) * 6,
        remaining: 0.35 + Math.random() * 0.35,
        color: color(),
      })
    }
    const stroke = strokes[0]
    if (stroke) {
      const speed = 0.45
      stroke.angle += stroke.turn * dt
      stroke.x += Math.cos(stroke.angle) * speed * dt * (world.size.y / world.size.x)
      stroke.y += Math.sin(stroke.angle) * speed * dt
      stroke.remaining -= dt
      splat = {
        at: d.vec2f(stroke.x * world.size.x, stroke.y * world.size.y),
        // Each frame nudges the water toward the brush's own speed.
        force: d.vec2f(Math.cos(stroke.angle) * speed * world.size.y * 0.3, Math.sin(stroke.angle) * speed * world.size.y * 0.3),
        color: d.vec3f(stroke.color.x * 0.22, stroke.color.y * 0.22, stroke.color.z * 0.22),
        size: 1.4,
      }
      if (stroke.remaining <= 0) strokes = strokes.slice(1)
    }
  }
  writeParams(dt, splat ?? { at: d.vec2f(-1e4), force: d.vec2f(), color: d.vec3f(), size: 1 })

  run(passes.curl, [])
  run(passes.vorticity, ['velocity'])
  if (splat) run(passes.splat, ['velocity', 'dye'])
  run(passes.advectVelocity, ['velocity'])
  run(passes.advectDye, ['dye'])
  run(passes.divergence, ['pressure'])
  for (let i = 0; i < values.iterations; i++) run(passes.relax, ['pressure'])
  run(passes.project, ['velocity'])

  render
    .with(shared)
    .with(world.group())
    .withColorAttachment({ view: app.target(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] })
    .draw(3)
})
