import { d, type TgpuRoot } from 'typegpu'
import * as slime from './slime.wgsl'

/** The fields of the shader's `Params` that the sliders control. */
export type Behaviour = Pick<d.Infer<typeof slime.Params>, 'speed' | 'sensorAngle' | 'sensorDistance' | 'turnSpeed' | 'decay' | 'speciesCount'>

export interface Size {
  /** Trail cells per canvas pixel. */
  scale: number
  /** Agents per trail cell. */
  density: number
}

/** The slime mold of slime.wgsl, ready to step and draw on a canvas of any size. */
export function slimeSimulation(root: TgpuRoot, format: GPUTextureFormat) {
  const params = root.createBuffer(slime.Params).$usage('uniform')
  const shared = root.createBindGroup(slime.layout0, { params })
  const pipelines = {
    scatter: root.createComputePipeline({ compute: slime.scatter }),
    clear: root.createComputePipeline({ compute: slime.clear }),
    step: root.createComputePipeline({ compute: slime.step }),
    diffuse: root.createComputePipeline({ compute: slime.diffuse }),
    render: root.createRenderPipeline({ vertex: slime.fullscreen, fragment: slime.render, targets: { format } }),
  }

  const createWorld = (canvas: d.v2f, { scale, density }: Size) => {
    const size = d.vec2f(Math.max(64, Math.round(canvas.x * scale)), Math.max(64, Math.round(canvas.y * scale)))
    const agentCount = Math.round(size.x * size.y * density)
    const agents = root.createBuffer(d.arrayOf(slime.Agent, agentCount)).$usage('storage')
    const trails = [0, 1].map(() => root.createBuffer(d.arrayOf(d.vec4f, size.x * size.y)).$usage('storage'))
    const groups = [0, 1].map((i) => root.createBindGroup(slime.layout1, { agents, trail: trails[i]!, trailNext: trails[1 - i]! }))
    return { canvas, size, agentCount, buffers: [agents, ...trails], groups, current: 0 }
  }

  let world: ReturnType<typeof createWorld> | undefined
  let time = 0
  const agentGroups = () => Math.ceil(world!.agentCount / slime.WORKGROUP)
  const tiles = () => [Math.ceil(world!.size.x / slime.TILE), Math.ceil(world!.size.y / slime.TILE)] as const

  const writeParams = (dt: number, behaviour: Behaviour, pointer?: { x: number; y: number; pull: boolean }) => {
    const { size, canvas, agentCount } = world!
    const values: d.Infer<typeof slime.Params> = {
      ...behaviour,
      size,
      canvas,
      pointer: d.vec2f((pointer?.x ?? 0) * size.x, (pointer?.y ?? 0) * size.y),
      time,
      dt,
      deposit: 1.6,
      pointerForce: pointer?.pull ? 6 : 0,
      agentCount,
    }
    params.write(values)
  }

  return {
    /** Starts over on a canvas of this size. */
    reset(canvas: d.v2f, size: Size, behaviour: Behaviour) {
      for (const buffer of world?.buffers ?? []) buffer.destroy()
      world = createWorld(canvas, size)
      writeParams(0, behaviour)
      pipelines.scatter.with(shared).with(world.groups[0]!).dispatchWorkgroups(agentGroups())
      pipelines.clear.with(shared).with(world.groups[0]!).dispatchWorkgroups(...tiles())
    },
    step(dt: number, behaviour: Behaviour, pointer?: { x: number; y: number; pull: boolean }) {
      time += dt
      writeParams(dt, behaviour, pointer)
      const current = world!
      pipelines.step.with(shared).with(current.groups[current.current]!).dispatchWorkgroups(agentGroups())
      pipelines.diffuse.with(shared).with(current.groups[current.current]!).dispatchWorkgroups(...tiles())
      current.current = 1 - current.current
    },
    draw(target: GPUCanvasContext | GPUTextureView) {
      const current = world!
      pipelines.render
        .with(shared)
        .with(current.groups[current.current]!)
        .withColorAttachment({ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] })
        .draw(3)
    },
  }
}
