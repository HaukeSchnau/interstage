import * as typegpu from 'typegpu'
import { tgpu, type TgpuRoot } from 'typegpu'
import { capture } from '../shell.ts'

declare global {
  // The modules that the editor's code imports, while it loads; see `load`. A `var` declaration
  // is what puts a property on `globalThis`'s type.
  var __interstageEditor: Record<string, object> | undefined
}

export type Preview = Awaited<ReturnType<typeof createPreview>>

interface Options {
  /** With `?capture=N`, every Nth frame is read back for scripts/check.ts. */
  captureAt: number
  /** Called when the running version throws while drawing. It stops. */
  onError: (message: string) => void
}

/**
 * Runs the editor's two files on the GPU, as the Vite plugin and a bundler would: `lamp.wgsl` as
 * the module interstage compiled from it, and `main.ts` with its imports pointed at that module,
 * at TypeGPU and at `./page`, the canvas next to the editor.
 */
export function createPreview(canvas: HTMLCanvasElement, device: GPUDevice, options: Options) {
  const format = navigator.gpu.getPreferredCanvasFormat()
  const canvasContext = canvas.getContext('webgpu')
  if (!canvasContext) throw new Error('The preview canvas has no WebGPU context.')
  canvasContext.configure({ device, format, alphaMode: 'opaque' })

  // Headless Chrome on Linux destroys a device as soon as it presents to a canvas, so `?capture`
  // draws into a texture instead. main.ts only reads `canvas`, and TypeGPU takes anything with
  // getCurrentTexture() for a context.
  let offscreen: GPUTexture | undefined
  const context =
    options.captureAt > 0 ? ({ canvas, getCurrentTexture: () => offscreen! } as Partial<GPUCanvasContext> as GPUCanvasContext) : canvasContext

  const pointer = { x: 0, y: 0 }
  const resize = () => {
    const ratio = Math.min(devicePixelRatio, 2)
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * ratio))
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * ratio))
    pointer.x = canvas.width / 2
    pointer.y = canvas.height * 0.62
    if (options.captureAt > 0) {
      offscreen?.destroy()
      offscreen = device.createTexture({
        size: [canvas.width, canvas.height],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      })
    }
  }
  resize()
  new ResizeObserver(resize).observe(canvas)
  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * canvas.width
    pointer.y = ((event.clientY - rect.top) / rect.height) * canvas.height
  })

  const status: NonNullable<Window['__interstage']> = { frames: 0, errors: [] }
  window.__interstage = status
  device.addEventListener('uncapturederror', (event) => status.errors.push(event.error.message))

  let running: { key: string; root: TgpuRoot; draw: (time: number) => void } | undefined
  const started = performance.now()
  const still = matchMedia('(prefers-reduced-motion: reduce)')
  const time = () => (still.matches ? 9 : (performance.now() - started) / 1000)

  let visible = true
  new IntersectionObserver(([entry]) => (visible = entry?.isIntersecting ?? true)).observe(canvas)
  const frame = () => {
    if (running && visible) {
      try {
        running.draw(time())
        status.frames++
        if (offscreen && status.frames % options.captureAt === 0) void capture(running.root, offscreen).then((url) => (status.capture = url))
      } catch (error) {
        running = undefined
        options.onError(error instanceof Error ? error.message : String(error))
      }
    }
    // A canvas paces frames to the GPU; offscreen, the queue would grow without bound on a slow one.
    if (offscreen) void device.queue.onSubmittedWorkDone().then(() => requestAnimationFrame(frame))
    else requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  return {
    /**
     * Runs a version of the two files, unless it is already running. It replaces the running
     * version only once its first frame drew without errors; otherwise it says what went wrong.
     */
    async run(key: string, shaderModule: string, main: string): Promise<string | undefined> {
      if (running?.key === key) return undefined
      const root = tgpu.initFromDevice({ device })
      const registered: { draw?: (time: number) => void } = {}
      const page = { root, context, format, pointer, onFrame: (draw: (time: number) => void) => (registered.draw = draw) }
      const modules: Record<string, object> = { typegpu, './page': page }
      globalThis.__interstageEditor = modules
      try {
        modules['./lamp.wgsl'] = await load(shaderModule)
        await load(main)
        const { draw } = registered
        if (!draw) throw new Error('main.ts never calls onFrame(), so there is nothing to draw.')
        device.pushErrorScope('validation')
        draw(time())
        const error = await device.popErrorScope()
        if (error) throw new Error(error.message)
        running?.root.destroy()
        running = { key, root, draw }
        return undefined
      } catch (error) {
        root.destroy()
        return error instanceof Error ? error.message : String(error)
      } finally {
        globalThis.__interstageEditor = undefined
      }
    },
  }
}

const IMPORT = /^[ \t]*import\s+(?:([\w$]+)\s*,?\s*)?(?:\*\s*as\s+([\w$]+)|\{([^}]*)\})?\s*from\s*(['"])([^'"]+)\4\s*;?/gm

/** Evaluates a module after turning its imports into reads of the editor's modules. */
async function load(code: string): Promise<object> {
  const linked = code.replace(IMPORT, (_, defaultName?: string, namespace?: string, named?: string, _quote?: string, specifier = '') => {
    if (!globalThis.__interstageEditor?.[specifier]) throw new Error(`There is no '${specifier}' here. The editor has typegpu, ./lamp.wgsl and ./page.`)
    const module = `globalThis.__interstageEditor[${JSON.stringify(specifier)}]`
    return [
      defaultName && `const ${defaultName} = ${module}.default;`,
      namespace && `const ${namespace} = ${module};`,
      named && `const { ${named.replace(/\s+as\s+/g, ': ')} } = ${module};`,
    ]
      .filter(Boolean)
      .join(' ')
  })
  const url = URL.createObjectURL(new Blob([linked], { type: 'text/javascript' }))
  try {
    return await import(/* @vite-ignore */ url)
  } finally {
    URL.revokeObjectURL(url)
  }
}
