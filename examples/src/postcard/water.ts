import { d } from 'typegpu'
import { flat, type Effect, type Scene } from './scene.ts'
import * as water from './water.wgsl'

/** Device pixels per cell of the simulation grid. */
const CELL = 4

export function waterEffect(scene: Scene): Effect {
  const { root } = scene
  const params = root.createBuffer(water.Water).$usage('uniform')
  const shared = root.createBindGroup(water.layout0, { water: params, page: scene.page, pageSampler: scene.sampler })
  const ripple = root.createComputePipeline({ compute: water.ripple })
  const shade = root.createRenderPipeline({ vertex: water.fullscreen, fragment: water.shade, targets: { format: scene.format } })

  const createSheet = () => {
    const grid = d.vec2f(Math.ceil(scene.canvas.width / CELL), Math.ceil(scene.canvas.height / CELL))
    const heights = [0, 1, 2].map(() => root.createBuffer(d.arrayOf(d.f32, grid.x * grid.y)).$usage('storage'))
    // Rotation k reads heights k and the one before, and writes the one after.
    const groups = [0, 1, 2].map((k) =>
      root.createBindGroup(water.layout1, {
        heights: heights[k]!,
        previousHeights: heights[(k + 2) % 3]!,
        nextHeights: heights[(k + 1) % 3]!,
      }),
    )
    return { grid, heights, groups, current: 0 }
  }
  let sheet = createSheet()
  let nextDrop = 0

  return {
    hint: 'Move the pointer over the card to stir the water. The form underneath keeps working.',
    enter() {},
    resize() {
      for (const buffer of sheet.heights) buffer.destroy()
      sheet = createSheet()
    },
    update(dt) {
      const { pointer, card } = scene
      const speed = Math.hypot(pointer.dx, pointer.dy) / card.scale
      nextDrop -= dt
      const drop = nextDrop <= 0
      if (drop) nextDrop = 0.25 + Math.random() * 0.9
      params.write({
        canvas: d.vec2f(scene.canvas.width, scene.canvas.height),
        grid: sheet.grid,
        card: d.vec4f(card.x, card.y, card.width, card.height),
        pointer: d.vec2f(pointer.x / CELL, pointer.y / CELL),
        drop: d.vec2f(Math.random() * sheet.grid.x, Math.random() * sheet.grid.y),
        pointerForce: pointer.seen ? Math.min(speed * 0.06, 1.6) : 0,
        dropForce: drop ? 0.6 + Math.random() * 1.2 : 0,
        damping: 0.986,
        scale: card.scale,
      })
      const tiles = [Math.ceil(sheet.grid.x / water.WORKGROUP), Math.ceil(sheet.grid.y / water.WORKGROUP)] as const
      ripple.with(shared).with(sheet.groups[sheet.current]!).dispatchWorkgroups(...tiles)
      sheet.current = (sheet.current + 1) % 3
    },
    draw(target) {
      shade
        .with(shared)
        .with(sheet.groups[sheet.current]!)
        .withColorAttachment({ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] })
        .draw(3)
    },
    placement: () => flat(scene),
  }
}
