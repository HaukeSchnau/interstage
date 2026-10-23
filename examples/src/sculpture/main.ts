import { d } from 'typegpu'
import { demo } from '../shell.ts'
import * as sculpture from './sculpture.wgsl'
import shader from './sculpture.wgsl?raw'
import declarations from '../../.contract/sculpture/sculpture.d.wgsl.ts?raw'
import host from './main.ts?raw'

const app = await demo({
  title: 'Sculpture',
  description: [
    'A sphere carved into a gyroid, with three drops of the same material melting into it. Drag to turn the camera.',
    'The whole picture is one fragment shader. Its inputs are <code>Scene</code>, a uniform struct, and TypeScript fills it in by name.',
  ],
  controls: [
    { key: 'blend', label: 'Melt', wgsl: 'blend', min: 0.01, max: 1.2, step: 0.01, value: 0.55 },
    { key: 'lattice', label: 'Lattice', wgsl: 'lattice', min: 2, max: 12, step: 0.1, value: 5.5 },
    { key: 'thickness', label: 'Thickness', wgsl: 'thickness', min: 0.01, max: 0.15, step: 0.005, value: 0.045 },
    { key: 'hue', label: 'Hue', wgsl: 'hue', min: 0, max: 1, step: 0.01, value: 0.58 },
  ],
  contract: {
    shaders: [{ shaderName: 'sculpture.wgsl', shader, declarations }],
    host,
    hostName: 'main.ts',
  },
})

const { root, values, pointer } = app
const scene = root.createBuffer(sculpture.Scene).$usage('uniform')
const bindings = root.createBindGroup(sculpture.layout0, { scene })
const pipeline = root.createRenderPipeline({ vertex: sculpture.fullscreen, fragment: sculpture.shade, targets: { format: app.format } })

const camera = { yaw: 0.6, pitch: 0.25, spin: 0.12 }
let time = 0

app.run(({ dt }) => {
  time += dt
  if (pointer.down) {
    camera.yaw -= pointer.dx * 5
    camera.pitch = Math.min(1.2, Math.max(-0.1, camera.pitch + pointer.dy * 3))
    camera.spin = -pointer.dx * 5 / Math.max(dt, 1e-3) * 0.2
  } else {
    camera.spin += (0.12 - camera.spin) * Math.min(1, dt * 1.5)
    camera.yaw += camera.spin * dt
  }

  scene.write({
    resolution: d.vec2f(app.canvas.width, app.canvas.height),
    time,
    yaw: camera.yaw,
    pitch: camera.pitch,
    distance: 5.4,
    blend: values.blend,
    lattice: values.lattice,
    thickness: values.thickness,
    hue: values.hue,
  })
  pipeline
    .with(bindings)
    .withColorAttachment({ view: app.target(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] })
    .draw(3)
})
