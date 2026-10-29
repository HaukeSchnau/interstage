import { d } from 'typegpu'
import type { Scene, Target } from './scene.ts'
import * as stage from './stage.wgsl'

/** Draws the table, the card's shadow and the card lying flat, for effects that draw on top. */
export function createStage(scene: Scene) {
  const { root } = scene
  const params = root.createBuffer(stage.Stage).$usage('uniform')
  const group = root.createBindGroup(stage.layout0, { stage: params, page: scene.page, pageSampler: scene.sampler })
  const pipeline = root.createRenderPipeline({ vertex: stage.fullscreen, fragment: stage.backdrop, targets: { format: scene.format } })

  return (target: Target, look: { cardOpacity: number; shadowOpacity: number }) => {
    const { card } = scene
    params.write({
      canvas: d.vec2f(scene.canvas.width, scene.canvas.height),
      card: d.vec4f(card.x, card.y, card.width, card.height),
      scale: card.scale,
      ...look,
    })
    pipeline.with(group).withColorAttachment({ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }).draw(3)
  }
}
