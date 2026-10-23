import { d, std, tgpu } from 'typegpu'
import { demo } from '../shell.ts'
import * as atlas from './atlas.wgsl'
import shader from './atlas.wgsl?raw'
import declarations from '../../.contract/atlas/atlas.d.wgsl.ts?raw'
import host from './main.ts?raw'

const app = await demo({
  title: 'Atlas',
  description: [
    'A world that never ends. Drag to travel, scroll to zoom.',
    'The terrain is WGSL, in <code>atlas.wgsl</code>. This map is a fragment shader written in TypeScript that calls its <code>elevation</code> function: pass it anything but a <code>vec2f</code> and TypeScript refuses to compile.',
  ],
  controls: [
    { key: 'seaLevel', label: 'Sea level', wgsl: 'seaLevel', min: -0.3, max: 0.4, step: 0.01, value: 0.04 },
    { key: 'relief', label: 'Mountains', wgsl: 'relief', min: 0, max: 2, step: 0.05, value: 1 },
    { key: 'contours', label: 'Contour lines', wgsl: 'contours', min: 4, max: 40, step: 1, value: 16 },
    { key: 'zoom', label: 'Zoom', min: 0.5, max: 8, step: 0.1, value: 1 },
  ],
  actions: [{ label: 'Another world', run: () => (seed = Math.random() * 100) }],
  contract: {
    shaders: [{ shaderName: 'atlas.wgsl', shader, declarations }],
    host,
    hostName: 'main.ts',
  },
})

/** Lowland to snow, by height above sea level. */
const landColor = (height: number): d.v3f => {
  'use gpu'
  let color = std.mix(d.vec3f(0.78, 0.74, 0.55), d.vec3f(0.46, 0.55, 0.36), std.smoothstep(0, 0.18, height))
  color = std.mix(color, d.vec3f(0.42, 0.37, 0.29), std.smoothstep(0.2, 0.5, height))
  color = std.mix(color, d.vec3f(0.62, 0.6, 0.57), std.smoothstep(0.5, 0.7, height))
  return std.mix(color, d.vec3f(0.96, 0.95, 0.93), std.smoothstep(0.8, 0.92, height))
}

const map = tgpu.fragmentFn({ in: { position: d.builtin.position }, out: d.vec4f })((input) => {
  'use gpu'
  const view = atlas.layout0.$.view
  const pixel = view.scale / view.resolution.y
  const p = std.add(view.center, std.mul(std.sub(input.position.xy, std.mul(view.resolution, 0.5)), pixel))

  // WGSL functions are TypeGPU functions, so TypeScript shaders call them like any other.
  const height = atlas.elevation(p)
  const east = atlas.elevation(std.add(p, d.vec2f(pixel, 0)))
  const south = atlas.elevation(std.add(p, d.vec2f(0, pixel)))

  const normal = std.normalize(d.vec3f(((height - east) / pixel) * 0.3, ((height - south) / pixel) * 0.3, 1))
  const light = std.clamp(std.dot(normal, std.normalize(d.vec3f(-1, -1, 1.3))), 0, 1)

  let color = d.vec3f()
  if (height < 0) {
    const depth = -height
    color = std.mix(d.vec3f(0.33, 0.55, 0.62), d.vec3f(0.05, 0.13, 0.22), std.smoothstep(0, 0.35, depth))
    const ripple = std.sin(depth * 90 - view.time * 1.6) * 0.5 + 0.5
    color = std.add(color, d.vec3f(ripple * 0.04 * (1 - std.smoothstep(0, 0.08, depth))))
  } else {
    color = std.mul(landColor(height), 0.45 + 0.75 * light)
    // A contour line wherever the height crosses a multiple of the interval, one pixel wide.
    const steepness = std.length(d.vec2f(east - height, south - height)) * view.contours
    const band = std.abs(std.fract(height * view.contours + 0.5) - 0.5)
    const line = 1 - std.smoothstep(steepness * 0.6, steepness * 1.6, band)
    color = std.mul(color, 1 - 0.35 * line)
  }
  const coast = 1 - std.smoothstep(0, 0.006, std.abs(height))
  color = std.mix(color, d.vec3f(0.95, 0.92, 0.82), coast * 0.7)

  const edge = std.length(std.sub(std.div(input.position.xy, view.resolution), d.vec2f(0.5)))
  color = std.mul(color, 1 - 0.55 * std.smoothstep(0.35, 0.85, edge))
  return d.vec4f(color, 1)
})

const { root, values, pointer, canvas } = app
const view = root.createBuffer(atlas.View).$usage('uniform')
const bindings = root.createBindGroup(atlas.layout0, { view })
// A WGSL vertex stage and a TypeScript fragment stage in one pipeline.
const pipeline = root.createRenderPipeline({ vertex: atlas.fullscreen, fragment: map, targets: { format: app.format } })

let seed = 17.3
let time = 0
const center = { x: 0, y: 0 }
let wheelZoom = 1
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault()
    wheelZoom = Math.min(8, Math.max(0.15, wheelZoom * Math.exp(event.deltaY * 0.0015)))
  },
  { passive: false },
)

app.run(({ dt }) => {
  time += dt
  const scale = 4 * wheelZoom / values.zoom
  const aspect = canvas.width / canvas.height
  if (pointer.down) {
    center.x -= pointer.dx * aspect * scale
    center.y -= pointer.dy * scale
  } else {
    center.x += 0.04 * scale * dt
    center.y += 0.015 * scale * dt
  }
  view.write({
    center: d.vec2f(center.x, center.y),
    resolution: d.vec2f(canvas.width, canvas.height),
    scale,
    seaLevel: values.seaLevel,
    relief: values.relief,
    contours: values.contours,
    seed,
    time,
  })
  pipeline
    .with(bindings)
    .withColorAttachment({ view: app.target(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] })
    .draw(3)
})
