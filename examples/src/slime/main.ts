import { d } from 'typegpu'
import { demo, quality } from '../shell.ts'
import { slimeSimulation } from './simulation.ts'
import shader from './slime.wgsl?raw'
import declarations from '../../.contract/slime/slime.d.wgsl.ts?raw'
import host from './simulation.ts?raw'

const app = await demo({
  title: 'Slime',
  description: [
    "Hundreds of thousands of agents follow their own species' trail and avoid the others'. Hold the pointer down to draw them in.",
    'Each slider writes one field of <code>Params</code>, a struct in <code>slime.wgsl</code>. interstage declares that struct for TypeScript, so a slider can only write a field the shader has.',
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
  contract: [
    { name: 'slime.wgsl', shader, declarations },
    { name: 'simulation.ts', source: host },
  ],
})

const { values, pointer, canvas } = app
const simulation = slimeSimulation(app.root, app.format)
const size = () => ({
  scale: quality === 'low' ? 0.25 : Math.min(1, 1600 / canvas.width) * (canvas.width > 1200 ? 0.75 : 1),
  density: quality === 'low' ? 0.05 : 0.45,
})

let species = values.speciesCount
function reset() {
  species = values.speciesCount
  simulation.reset(d.vec2f(canvas.width, canvas.height), size(), values)
}

let resizeTimer: ReturnType<typeof setTimeout> | undefined
app.onResize(() => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(reset, 200)
})
reset()

app.run(({ dt }) => {
  if (values.speciesCount !== species) reset()
  simulation.step(dt, values, { x: pointer.x, y: pointer.y, pull: pointer.down })
  simulation.draw(app.target())
})
