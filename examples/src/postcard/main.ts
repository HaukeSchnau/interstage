import { tgpu } from 'typegpu'
import { capture, drawer, header, requestAdapter, type ContractFile } from '../shell.ts'
import { clothEffect } from './cloth.ts'
import { dustEffect } from './dust.ts'
import { drawElement, elementPlacer, unsupported } from './html-in-canvas.ts'
import { createPage, type Card, type Effect, type Pointer, type Scene } from './scene.ts'
import { waterEffect } from './water.ts'
import './style.css'

const status: NonNullable<Window['__interstage']> = { frames: 0, errors: [] }
window.__interstage = status
addEventListener('error', (event) => status.errors.push(String(event.message)))
addEventListener('unhandledrejection', (event) => status.errors.push(String(event.reason)))

function byId<T extends Element>(id: string, type: abstract new (...args: never[]) => T): T {
  const element = document.getElementById(id)
  if (!(element instanceof type)) throw new Error(`#${id} is missing`)
  return element
}

const canvas = byId('stage', HTMLCanvasElement)
const card = byId('card', HTMLElement)
const form = byId('postcard', HTMLFormElement)
const sent = byId('sent', HTMLElement)
const panel = document.querySelector<HTMLElement>('.panel')!
const hint = byId('hint', HTMLElement)
const modeButtons = [...panel.querySelectorAll<HTMLButtonElement>('button[data-mode]')]
const params = new URLSearchParams(location.search)

const sources = {
  ...import.meta.glob<string>(['./*.wgsl', './water.ts', './cloth.ts', './dust.ts'], { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob<string>('../../.contract/postcard/*.d.wgsl.ts', { query: '?raw', import: 'default', eager: true }),
}
const source = (path: string) => {
  const text = sources[path]
  if (text === undefined) throw new Error(`${path} is missing`)
  return text
}
const shader = (name: string): ContractFile => ({
  name: `${name}.wgsl`,
  shader: source(`./${name}.wgsl`),
  declarations: source(`../../.contract/postcard/${name}.d.wgsl.ts`),
})
const host = (name: string): ContractFile => ({ name: `${name}.ts`, source: source(`./${name}.ts`) })

document.body.append(header('Postcard'))
document.body.append(
  drawer([
    shader('stage'),
    shader('water'),
    host('water'),
    shader('cloth-sim'),
    shader('cloth-draw'),
    host('cloth'),
    shader('dust-sim'),
    shader('dust-draw'),
    host('dust'),
  ]),
)

// --- The postcard works as a plain form, with or without the canvas ------------------------------

const clock = byId('clock', HTMLTimeElement)
const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' })
const tick = () => {
  const now = new Date()
  clock.dateTime = now.toISOString()
  clock.textContent = time.format(now)
}
tick()
setInterval(tick, 1000)

form.addEventListener('change', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.name === 'stamp') {
    byId('stamp-face', HTMLElement).textContent = event.target.value
  }
})
form.addEventListener('input', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.name === 'postage') {
    byId('postage-value', HTMLOutputElement).value = `€${event.target.value}`
  }
})

const showReceipt = () => {
  const to = form.elements.namedItem('to')
  byId('sent-to', HTMLElement).textContent = (to instanceof HTMLInputElement && to.value.trim()) || 'nobody in particular'
  form.hidden = true
  sent.hidden = false
}
const showForm = () => {
  sent.hidden = true
  form.hidden = false
}

/** What Send and Write another do; the canvas replaces it with the dust. */
let turn = (swap: () => void) => swap()
form.addEventListener('submit', (event) => {
  event.preventDefault()
  turn(showReceipt)
})
byId('again', HTMLButtonElement).addEventListener('click', () => turn(showForm))

// --- The canvas -----------------------------------------------------------------------------------

/** Stops the canvas for good, once the page falls back to plain HTML. */
const halt = new AbortController()

function fallBack(reason: string) {
  halt.abort()
  status.errors.push(reason)
  const notice = byId('unsupported', HTMLElement)
  byId('unsupported-reason', HTMLElement).textContent = reason
  notice.append(card)
  notice.hidden = false
  canvas.hidden = true
  panel.hidden = true
}

const reason = unsupported(canvas)
if (reason) fallBack(reason)
else start().catch((error: unknown) => fallBack(error instanceof Error ? error.message : String(error)))

async function start() {
  const root = tgpu.initFromDevice({ device: await (await requestAdapter()).requestDevice() })
  root.device.addEventListener('uncapturederror', (event) => status.errors.push(event.error.message))
  void root.device.lost.then((info) => {
    if (info.reason !== 'destroyed') fallBack(`The GPU stopped responding: ${info.message}`)
  })

  const format = navigator.gpu.getPreferredCanvasFormat()
  // Drawing an element into a texture needs the canvas to have a configured context, even when
  // `?capture` draws offscreen: headless Chrome on Linux loses the device when a canvas presents.
  const context = root.configureContext({ canvas, format, alphaMode: 'opaque' })
  const captureAt = Number(params.get('capture') ?? 0)
  let offscreen: GPUTexture | undefined

  const texelScale = Math.min(2, Math.ceil(devicePixelRatio))
  const texels = { width: card.offsetWidth * texelScale, height: card.offsetHeight * texelScale }
  const page = createPage(root, texels.width, texels.height)
  canvas.addEventListener('paint', () => drawElement(root.device.queue, card, root.unwrap(page), texels.width, texels.height), {
    signal: halt.signal,
  })
  canvas.requestPaint?.()

  const pointer: Pointer = { x: 0, y: 0, dx: 0, dy: 0, seen: false }
  fitCanvas()
  const scene: Scene = {
    root,
    canvas,
    format,
    page,
    sampler: root.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
    card: layOut(),
    pointer,
    ratio: devicePixelRatio,
  }

  const dust = dustEffect(scene)
  const effects = { water: waterEffect(scene), cloth: clothEffect(scene), dust } satisfies Record<string, Effect>
  type Mode = keyof typeof effects
  const isMode = (value: string | null | undefined): value is Mode => !!value && value in effects
  let effect: Effect = effects.water

  const choose = (mode: Mode) => {
    effect = effects[mode]
    effect.enter()
    hint.textContent = effect.hint
    for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === mode))
  }
  for (const button of modeButtons) {
    button.addEventListener('click', () => {
      if (isMode(button.dataset.mode)) choose(button.dataset.mode)
    })
  }
  const requested = params.get('mode')
  choose(isMode(requested) ? requested : 'water')

  turn = (swap) => {
    if (effect !== dust) choose('dust')
    dust.scatter(swap)
  }

  // Pointer events from the card bubble up to the canvas, so one set of listeners sees both.
  canvas.addEventListener('pointermove', (event) => {
    pointer.x = event.clientX * scene.ratio
    pointer.y = event.clientY * scene.ratio
    pointer.seen = true
  })
  canvas.addEventListener('pointerdown', (event) => {
    pointer.x = event.clientX * scene.ratio
    pointer.y = event.clientY * scene.ratio
    if (effect.press?.(event.target)) {
      event.preventDefault()
      canvas.setPointerCapture(event.pointerId)
    }
  })
  canvas.addEventListener('pointerup', () => effect.release?.())
  canvas.addEventListener('pointercancel', () => effect.release?.())

  function layOut(): Card {
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    const margin = 24
    const top = document.querySelector('.demo-header')?.getBoundingClientRect().bottom ?? 0
    const side = panel.getBoundingClientRect()
    const cssWidth = card.offsetWidth
    const cssHeight = card.offsetHeight
    // Right of the panel when there's room, above it otherwise.
    const beside = width - side.right >= cssWidth * 0.6 + margin * 2
    const room = beside ? { left: side.right, bottom: height } : { left: 0, bottom: side.top }
    const fit = Math.max(0.3, Math.min(1, (width - room.left - margin * 2) / cssWidth, (room.bottom - top - margin * 2) / cssHeight))
    const centerX = beside ? Math.max(width / 2, room.left + margin + (cssWidth * fit) / 2) : width / 2
    const centerY = (top + room.bottom) / 2
    const ratio = devicePixelRatio
    return {
      x: Math.round((centerX - (cssWidth * fit) / 2) * ratio),
      y: Math.round((centerY - (cssHeight * fit) / 2) * ratio),
      width: Math.round(cssWidth * fit * ratio),
      height: Math.round(cssHeight * fit * ratio),
      scale: fit * ratio,
      cssWidth,
      cssHeight,
    }
  }

  function fitCanvas() {
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio))
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio))
  }

  const resize = () => {
    fitCanvas()
    scene.ratio = devicePixelRatio
    scene.card = layOut()
    if (captureAt > 0) {
      offscreen?.destroy()
      offscreen = root.device.createTexture({
        size: [canvas.width, canvas.height],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      })
    }
    for (const each of Object.values(effects)) each.resize()
  }
  resize()
  new ResizeObserver(resize).observe(canvas)

  let previous = performance.now()
  const started = previous
  let last = { x: pointer.x, y: pointer.y }
  const frame = (now: number) => {
    if (halt.signal.aborted) return
    const dt = Math.min((now - previous) / 1000, 1 / 20)
    previous = now
    pointer.dx = pointer.x - last.x
    pointer.dy = pointer.y - last.y
    last = { x: pointer.x, y: pointer.y }

    effect.update(dt, (now - started) / 1000)
    effect.draw(offscreen?.createView() ?? context)
    place()
    status.frames++
    if (offscreen && status.frames === captureAt) void capture(root, offscreen).then((url) => (status.capture = url))
    // A canvas paces frames to the GPU; offscreen, the queue would grow without bound on a slow one.
    if (offscreen) void root.device.queue.onSubmittedWorkDone().then(() => requestAnimationFrame(frame))
    else requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  const placeCard = elementPlacer(canvas, card)
  function place() {
    const placement = effect.placement()
    if (card.inert !== !placement) card.inert = !placement
    if (placement) placeCard(placement)
    // Where the card is drawn, so scripts/check.ts can click it there.
    status.placement = placement && [placement.a, placement.b, placement.c, placement.d, placement.e, placement.f]
  }
}
