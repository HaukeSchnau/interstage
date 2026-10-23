import { DiagnosticCode, type Diagnostic } from './compile.ts'

export type Validator = (source: string) => Promise<Diagnostic[]>

/**
 * Compiles shaders with Dawn, Chrome's WebGPU implementation, through the optional `webgpu`
 * package. Its WGSL compiler, Tint, reports what the parser here doesn't check: types, overloads,
 * uniformity and the rules of each shader stage.
 */
export async function createValidator(): Promise<Validator> {
  let webgpu: typeof import('webgpu')
  try {
    webgpu = await import('webgpu')
  } catch {
    throw new Error("Shader validation needs the 'webgpu' package; install it next to interstage")
  }
  const adapter = await webgpu.create([]).requestAdapter()
  if (!adapter) {
    throw new Error('Shader validation found no WebGPU adapter. On Linux, Dawn needs a Vulkan driver, such as Mesa lavapipe named by VK_ICD_FILENAMES')
  }
  const device = await adapter.requestDevice({
    requiredFeatures: adapter.features.has('shader-f16') ? ['shader-f16'] : [],
  })

  return async (source) => {
    device.pushErrorScope('validation')
    const module = device.createShaderModule({ code: source })
    const [info] = await Promise.all([module.getCompilationInfo(), device.popErrorScope()])
    return info.messages
      .filter((message) => message.type === 'error')
      .map((message) => ({
        message: message.message,
        start: message.offset,
        end: message.offset + message.length,
        code: DiagnosticCode.Shader,
      }))
  }
}
