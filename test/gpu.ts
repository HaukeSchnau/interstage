import { tgpu, type TgpuRoot } from 'typegpu'
import { create, globals } from 'webgpu'

Object.assign(globalThis, globals)

// Dawn shuts down when the object `create` returns is garbage collected.
const dawn = create([])
let shared: Promise<TgpuRoot> | undefined

/** A TypeGPU root on Dawn, the WebGPU implementation inside Chrome. */
export function gpu(): Promise<TgpuRoot> {
  shared ??= (async () => {
    const adapter = await dawn.requestAdapter()
    if (!adapter) {
      throw new Error('No WebGPU adapter. Dawn uses Metal on macOS and Vulkan on Linux, where VK_ICD_FILENAMES must name a driver.')
    }
    return tgpu.initFromDevice({ device: await adapter.requestDevice() })
  })()
  return shared
}

/** Tint's errors for a WGSL program. */
export async function compileErrors(root: TgpuRoot, code: string): Promise<string[]> {
  const info = await root.device.createShaderModule({ code }).getCompilationInfo()
  return info.messages.filter((message) => message.type === 'error').map((message) => `${message.lineNum}:${message.linePos} ${message.message}`)
}

/** Renders a pipeline into a 4×4 rgba8unorm texture and returns its pixels. */
export async function renderPixels(root: TgpuRoot, draw: (view: GPUTextureView) => void): Promise<Uint8Array> {
  const { device } = root
  const texture = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
  draw(texture.createView())
  const buffer = device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const encoder = device.createCommandEncoder()
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [4, 4])
  device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const pixels = new Uint8Array(buffer.getMappedRange().slice(0, 16))
  buffer.destroy()
  texture.destroy()
  return pixels
}
