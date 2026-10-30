import { tgpu, type TgpuRoot } from 'typegpu'
import { highlight } from './highlight.ts'
import './style.css'

export interface Control {
  key: string
  label: string
  /** The shader value the control writes, shown next to its label. */
  wgsl?: string
  min: number
  max: number
  step: number
  value: number
}

/** A tab in the drawer: a `.wgsl` file with the declarations `tsc` emits for it, or TypeScript that uses them. */
export type ContractFile = { name: string; shader: string; declarations: string } | { name: string; source: string }

export interface DemoOptions<Controls extends readonly Control[]> {
  title: string
  description: string[]
  controls: Controls
  actions?: Array<{ label: string; run: () => void }>
  contract: ContractFile[]
}

export interface Pointer {
  /** Position in [0, 1], y pointing down. */
  x: number
  y: number
  /** Movement since the previous frame, in the same units. */
  dx: number
  dy: number
  down: boolean
  /** Whether the pointer has been over the canvas at all. */
  seen: boolean
}

export interface Frame {
  time: number
  dt: number
  index: number
}

declare global {
  interface Window {
    /** Read by `scripts/check.ts` to verify each demo in a headless browser. */
    __interstage?: {
      frames: number
      errors: string[]
      capture?: string
      /** The postcard's drawn position, as a 2D matrix from the card's box to CSS pixels. */
      placement?: number[] | undefined
    }
  }
}

const params = new URLSearchParams(location.search)

/** `?quality=low` keeps software renderers responsive. */
export const quality: 'low' | 'high' = params.get('quality') === 'low' ? 'low' : 'high'

export async function demo<const Controls extends readonly Control[]>(options: DemoOptions<Controls>) {
  document.title = `${options.title} · an interstage example`
  document.body.classList.add('demo')
  const status: NonNullable<Window['__interstage']> = { frames: 0, errors: [] }
  window.__interstage = status
  addEventListener('error', (event) => status.errors.push(String(event.message)))
  addEventListener('unhandledrejection', (event) => status.errors.push(String(event.reason)))

  const canvas = document.createElement('canvas')
  canvas.id = 'stage'
  document.body.append(canvas)
  document.body.append(header(options.title))
  // The contract is worth reading without WebGPU too, so it comes before the GPU.
  document.body.append(drawer(options.contract))

  let root: TgpuRoot
  try {
    if (!navigator.gpu) throw new Error('This browser has no WebGPU.')
    root = tgpu.initFromDevice({ device: await (await requestAdapter()).requestDevice() })
  } catch (error) {
    fallback(error)
    throw error
  }
  root.device.addEventListener('uncapturederror', (event) => status.errors.push(event.error.message))
  void root.device.lost.then((info) => {
    if (info.reason !== 'destroyed') fallback(new Error(`The GPU stopped responding: ${info.message}`))
  })

  const captureAt = Number(params.get('capture') ?? 0)
  const format = navigator.gpu.getPreferredCanvasFormat()
  // Headless Chrome on Linux destroys a device as soon as it presents to a canvas, so `?capture`
  // renders into a texture of the same format that scripts/check.ts reads back.
  const context = captureAt > 0 ? undefined : root.configureContext({ canvas, format, alphaMode: 'premultiplied' })
  let offscreen: GPUTexture | undefined

  const values = Object.fromEntries(options.controls.map((control) => [control.key, control.value])) as {
    [Key in Controls[number]['key']]: number
  }
  document.body.append(panel(options, values))

  const resizeListeners: Array<(width: number, height: number) => void> = []
  const resize = () => {
    const ratio = Math.min(devicePixelRatio, quality === 'low' ? 1 : 2)
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio))
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio))
    if (!context) {
      offscreen?.destroy()
      offscreen = root.device.createTexture({
        size: [canvas.width, canvas.height],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      })
    }
    for (const listener of resizeListeners) listener(canvas.width, canvas.height)
  }
  new ResizeObserver(resize).observe(canvas)
  resize()

  const pointer: Pointer = { x: 0.5, y: 0.5, dx: 0, dy: 0, down: false, seen: false }
  let last = { x: 0.5, y: 0.5 }
  const move = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect()
    pointer.x = (event.clientX - rect.left) / rect.width
    pointer.y = (event.clientY - rect.top) / rect.height
    pointer.seen = true
  }
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerdown', (event) => {
    move(event)
    last = { x: pointer.x, y: pointer.y }
    pointer.down = true
    canvas.setPointerCapture(event.pointerId)
  })
  const release = () => (pointer.down = false)
  canvas.addEventListener('pointerup', release)
  canvas.addEventListener('pointercancel', release)

  return {
    root,
    canvas,
    format,
    /** Where this frame is drawn: the canvas, or the texture that `?capture` reads back. */
    target: (): GPUCanvasContext | GPUTextureView => context ?? offscreen!.createView(),
    values,
    pointer,
    onResize(listener: (width: number, height: number) => void) {
      resizeListeners.push(listener)
      listener(canvas.width, canvas.height)
    },
    run(frame: (frame: Frame) => void) {
      let previous = performance.now()
      const start = previous
      const tick = (now: number) => {
        const dt = Math.min((now - previous) / 1000, 1 / 20)
        previous = now
        pointer.dx = pointer.x - last.x
        pointer.dy = pointer.y - last.y
        last = { x: pointer.x, y: pointer.y }
        frame({ time: (now - start) / 1000, dt, index: status.frames })
        status.frames++
        if (offscreen && status.frames === captureAt) void capture(root, offscreen).then((url) => (status.capture = url))
        // A canvas paces frames to the GPU; offscreen, the queue would grow without bound on a slow
        // one, and the next page would wait for it to drain.
        if (offscreen) void root.device.queue.onSubmittedWorkDone().then(() => requestAnimationFrame(tick))
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
  }
}

/** Reads back the frame just drawn, for `scripts/check.ts`. */
export async function capture(root: TgpuRoot, texture: GPUTexture): Promise<string> {
  const { width, height, format } = texture
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256
  const buffer = root.device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const encoder = root.device.createCommandEncoder()
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height])
  root.device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const rows = new Uint8Array(buffer.getMappedRange())
  const pixels = new ImageData(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = y * bytesPerRow + x * 4
      const to = (y * width + x) * 4
      const [r, g, b] = format === 'bgra8unorm' ? [rows[from + 2]!, rows[from + 1]!, rows[from]!] : [rows[from]!, rows[from + 1]!, rows[from + 2]!]
      pixels.data.set([r, g, b, 255], to)
    }
  }
  buffer.destroy()
  const canvas = new OffscreenCanvas(width, height)
  canvas.getContext('2d')!.putImageData(pixels, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.readAsDataURL(blob)
  })
}

export function header(title: string): HTMLElement {
  const element = document.createElement('header')
  element.className = 'demo-header'
  element.innerHTML = `<a class="home" href="../">interstage</a><h1></h1><button class="contract-toggle" type="button" aria-pressed="false" aria-controls="contract">Show the shaders</button>`
  element.querySelector('h1')!.textContent = title
  return element
}

function panel<Controls extends readonly Control[]>(options: DemoOptions<Controls>, values: Record<string, number>): HTMLElement {
  const element = document.createElement('section')
  element.className = 'panel'
  element.setAttribute('aria-label', 'Controls')
  for (const paragraph of options.description) {
    const p = document.createElement('p')
    p.innerHTML = paragraph
    element.append(p)
  }
  for (const control of options.controls) {
    const label = document.createElement('label')
    label.className = 'control'
    const decimals = Math.max(0, -Math.floor(Math.log10(control.step)))
    label.innerHTML = `<span></span><output></output><input type="range">`
    label.querySelector('span')!.innerHTML = control.wgsl ? `${control.label} <code>${control.wgsl}</code>` : control.label
    const input = label.querySelector('input')!
    const output = label.querySelector('output')!
    Object.assign(input, { min: control.min, max: control.max, step: control.step, value: control.value })
    output.textContent = control.value.toFixed(decimals)
    input.addEventListener('input', () => {
      values[control.key] = Number(input.value)
      output.textContent = Number(input.value).toFixed(decimals)
    })
    element.append(label)
  }
  if (options.actions?.length) {
    const actions = document.createElement('div')
    actions.className = 'actions'
    for (const action of options.actions) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = action.label
      button.addEventListener('click', action.run)
      actions.append(button)
    }
    element.append(actions)
  }
  return element
}

export function drawer(files: ContractFile[]): HTMLElement {
  const element = document.createElement('aside')
  element.className = 'contract'
  element.id = 'contract'
  element.dataset.open = 'false'
  element.innerHTML = `
    <header>
      <div class="row"><h2>Shaders and their types</h2><button type="button" class="close">Close</button></div>
      <p>A <span class="wgsl-mark">WGSL</span> tab shows the shader as written, then the declarations interstage writes for it.
      Those declarations are all <code>tsc</code> knows about the file. A <span class="ts-mark">TypeScript</span> tab shows code
      that uses them. Hover a name to see it on both sides.</p>
      <div class="tabs" role="tablist"></div>
    </header>
    <pre class="code" tabindex="0"></pre>`
  const tabs = element.querySelector('.tabs')!
  const pre = element.querySelector('pre')!
  const views = files.map((file) =>
    'shader' in file
      ? {
          name: file.name,
          language: 'wgsl',
          html: () => {
            const shared = sharedNames(file.shader, file.declarations)
            return `${highlight(file.shader, 'wgsl', shared)}\n\n<span class="c">// The declarations interstage writes for ${file.name}, which is what tsc sees</span>\n\n${highlight(file.declarations, 'ts', shared)}`
          },
        }
      : { name: file.name, language: 'ts', html: () => highlight(file.source, 'ts', new Set()) },
  )
  const select = (index: number) => {
    pre.innerHTML = views[index]!.html()
    pre.scrollTop = 0
    tabs.querySelectorAll('button').forEach((button, i) => button.setAttribute('aria-selected', String(i === index)))
  }
  views.forEach((view, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.role = 'tab'
    button.dataset.language = view.language
    button.textContent = view.name
    button.addEventListener('click', () => select(index))
    tabs.append(button)
  })
  select(0)

  pre.addEventListener('pointerover', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('.id[data-shared]')
    pre.querySelectorAll('.lit').forEach((node) => node.classList.remove('lit'))
    if (target) pre.querySelectorAll(`.id[data-name="${target.dataset.name}"]`).forEach((node) => node.classList.add('lit'))
  })

  const toggle = () => {
    const open = element.dataset.open !== 'true'
    element.dataset.open = String(open)
    document.querySelector('.contract-toggle')?.setAttribute('aria-pressed', String(open))
  }
  queueMicrotask(() => document.querySelector('.contract-toggle')?.addEventListener('click', toggle))
  element.querySelector('.close')!.addEventListener('click', toggle)
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && element.dataset.open === 'true') toggle()
  })
  return element
}

/** Names written in both files. The highlighter only marks plain identifiers with them. */
function sharedNames(shader: string, declarations: string): Set<string> {
  const declared = new Set(declarations.match(/[A-Za-z_]\w*/g))
  return new Set(shader.match(/[A-Za-z_]\w*/g)?.filter((word) => declared.has(word)))
}

/** A GPU process that is still starting can answer null, so the first requests get a second chance. */
export async function requestAdapter(): Promise<GPUAdapter> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const adapter = await navigator.gpu.requestAdapter()
    if (adapter) return adapter
    await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
  }
  throw new Error('The browser found no GPU adapter.')
}

function fallback(error: unknown) {
  const element = document.createElement('div')
  element.className = 'fallback'
  element.innerHTML = `<div><h2>This demo needs WebGPU</h2><p></p><p>It runs in current Chrome and Edge, and in Safari 26 on macOS and iOS. The shaders, top right, open everywhere.</p><p><a href="../">Back to the examples</a></p></div>`
  element.querySelector('p')!.textContent = error instanceof Error ? error.message : String(error)
  document.body.append(element)
}
