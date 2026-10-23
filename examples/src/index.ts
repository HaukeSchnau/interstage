import { d, tgpu } from 'typegpu'
import { highlight } from './highlight.ts'
import { slimeSimulation } from './slime/simulation.ts'
import shader from './slime/slime.wgsl?raw'
import declarations from '../.contract/slime/slime.d.wgsl.ts?raw'
import './style.css'

// The code pair shows the real files: the Params struct and what tsc declares for it.
const struct = /struct Params \{[\s\S]*?\n\}/.exec(shader)![0]
const declared = /export declare const Params: [\s\S]*?\n\}>;/.exec(declarations)![0]
const shared = new Set(struct.match(/\w+/g))
document.querySelector('#pair-wgsl')!.innerHTML = highlight(struct, 'wgsl', shared)
document.querySelector('#pair-ts')!.innerHTML = highlight(declared, 'ts', shared)
for (const pre of document.querySelectorAll<HTMLElement>('pre.code > code')) {
  pre.innerHTML = highlight(pre.textContent ?? '', 'ts', new Set())
}

const canvas = document.querySelector<HTMLCanvasElement>('#hero')!
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

async function hero() {
  if (!navigator.gpu) return
  const root = await tgpu.init()
  const format = navigator.gpu.getPreferredCanvasFormat()
  const context = root.configureContext({ canvas, format, alphaMode: 'premultiplied' })
  const simulation = slimeSimulation(root, format)
  const behaviour = { speed: 45, sensorAngle: 0.55, sensorDistance: 12, turnSpeed: 14, decay: 0.3, speciesCount: 3 }
  const pointer = { x: 0.5, y: 0.5, pull: false }

  const resize = () => {
    const ratio = Math.min(devicePixelRatio, 1.5)
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio))
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio))
    simulation.reset(d.vec2f(canvas.width, canvas.height), { scale: 0.5, density: 0.3 }, behaviour)
  }
  resize()
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(resize, 250)
  }).observe(canvas)
  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect()
    pointer.x = (event.clientX - rect.left) / rect.width
    pointer.y = (event.clientY - rect.top) / rect.height
  })
  canvas.addEventListener('pointerdown', () => (pointer.pull = true))
  addEventListener('pointerup', () => (pointer.pull = false))

  if (reducedMotion) {
    for (let i = 0; i < 240; i++) simulation.step(1 / 60, behaviour)
    simulation.draw(context)
    return
  }
  let previous = performance.now()
  let visible = true
  new IntersectionObserver(([entry]) => (visible = entry?.isIntersecting ?? true)).observe(canvas)
  const tick = (now: number) => {
    const dt = Math.min((now - previous) / 1000, 1 / 20)
    previous = now
    if (visible) {
      simulation.step(dt, behaviour, pointer)
      simulation.draw(context)
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

hero().catch(() => canvas.classList.add('still'))
