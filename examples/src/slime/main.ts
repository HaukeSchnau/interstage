import { d } from 'typegpu'
import { demo, quality } from '../shell.ts'
import * as slime from './slime.wgsl'
import shader from './slime.wgsl?raw'
import declarations from '../../.contract/slime/slime.d.wgsl.ts?raw'
import host from './main.ts?raw'

const app = await demo({
  title: 'Slime',
  description: [
    "Hundreds of thousands of agents follow their own species' trail and avoid the others'. Hold the pointer down to draw them in.",
    'Each slider writes one field of <code>Params</code>, a struct declared in <code>slime.wgsl</code>. TypeScript knows those fields because interstage reads the shader.',
  ],
  controls: [
    { key: 'speed', label: 'Speed', wgsl: 'speed', min: 10, max: 160, step: 1, value: 60 },
    { key: 'sensorAngle', label: 'Sensor angle', wgsl: 'sensorAngle', min: 0.1, max: 1.4, step: 0.01, value: 0.6 },
    { key: 'sensorDistance', label: 'Sensor distance', wgsl: 'sensorDistance', min: 2, max: 40, step: 0.5, value: 14 },
    { key: 'turnSpeed', label: 'Turn speed', wgsl: 'turnSpeed', min: 1, max: 40, step: 0.5, value: 18 },
    { key: 'decay', label: 'Decay', wgsl: 'decay', min: 0.02, max: 1, step: 0.01, value: 0.22 },
    { key: 'speciesCount', label: 'Species', wgsl: 'speciesCount', min: 1, max: 3, step: 1, value: 3 },
  ],
  actions: [{ label: 'Scatter again', run: () => reset() }],
  contract: {
    shaders: [{ shaderName: 'slime.wgsl', shader, declarations }],
    host,
    hostName: 'main.ts',
  },
})

const { root, values, pointer } = app
const params = root.createBuffer(slime.Params).$usage('uniform')
const shared = root.createBindGroup(slime.layout0, { params })

const pipelines = {
  scatter: root.createComputePipeline({ compute: slime.scatter }),
  clear: root.createComputePipeline({ compute: slime.clear }),
  step: root.createComputePipeline({ compute: slime.step }),
  diffuse: root.createComputePipeline({ compute: slime.diffuse }),
  render: root.createRenderPipeline({ vertex: slime.fullscreen, fragment: slime.render, targets: { format: app.format } }),
}

let world = createWorld(app.canvas.width, app.canvas.height)
let species = values.speciesCount
let time = 0

function createWorld(canvasWidth: number, canvasHeight: number) {
  const scale = quality === 'low' ? 0.25 : Math.min(1, 1600 / canvasWidth) * (canvasWidth > 1200 ? 0.75 : 1)
  const size = d.vec2f(Math.max(64, Math.round(canvasWidth * scale)), Math.max(64, Math.round(canvasHeight * scale)))
  const agentCount = Math.round(size.x * size.y * (quality === 'low' ? 0.05 : 0.45))
  const agents = root.createBuffer(d.arrayOf(slime.Agent, agentCount)).$usage('storage')
  const trails = [0, 1].map(() => root.createBuffer(d.arrayOf(d.vec4f, size.x * size.y)).$usage('storage'))
  const groups = [0, 1].map((i) => root.createBindGroup(slime.layout1, { agents, trail: trails[i]!, trailNext: trails[1 - i]! }))
  return { canvasWidth, canvasHeight, size, agentCount, agents, trails, groups, current: 0 }
}

function writeParams(dt: number) {
  params.write({
    size: world.size,
    canvas: d.vec2f(app.canvas.width, app.canvas.height),
    pointer: d.vec2f(pointer.x * world.size.x, pointer.y * world.size.y),
    time,
    dt,
    speed: values.speed,
    sensorAngle: values.sensorAngle,
    sensorDistance: values.sensorDistance,
    turnSpeed: values.turnSpeed,
    deposit: 1.6,
    decay: values.decay,
    pointerForce: pointer.down ? 6 : 0,
    agentCount: world.agentCount,
    speciesCount: values.speciesCount,
  })
}

const agentGroups = () => Math.ceil(world.agentCount / slime.WORKGROUP)
const tiles = () => [Math.ceil(world.size.x / slime.TILE), Math.ceil(world.size.y / slime.TILE)] as const

function reset() {
  writeParams(0)
  pipelines.scatter.with(shared).with(world.groups[0]!).dispatchWorkgroups(agentGroups())
  pipelines.clear.with(shared).with(world.groups[0]!).dispatchWorkgroups(...tiles())
}

let resizeTimer: ReturnType<typeof setTimeout> | undefined
app.onResize((width, height) => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    if (width === world.canvasWidth && height === world.canvasHeight) return
    for (const buffer of [world.agents, ...world.trails]) buffer.destroy()
    world = createWorld(width, height)
    reset()
  }, 200)
})

reset()
app.run(({ dt }) => {
  time += dt
  if (values.speciesCount !== species) {
    species = values.speciesCount
    reset()
  }
  writeParams(dt)
  const group = world.groups[world.current]!
  pipelines.step.with(shared).with(group).dispatchWorkgroups(agentGroups())
  pipelines.diffuse.with(shared).with(group).dispatchWorkgroups(...tiles())
  world.current = 1 - world.current
  pipelines.render
    .with(shared)
    .with(world.groups[world.current]!)
    .withColorAttachment({ view: app.target(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] })
    .draw(3)
})
