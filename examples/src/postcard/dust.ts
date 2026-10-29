import { d } from 'typegpu'
import { flat, type Effect, type Scene } from './scene.ts'
import * as draw from './dust-draw.wgsl'
import * as sim from './dust-sim.wgsl'
import { createStage } from './stage.ts'

/** Seconds of scattering before the page changes underneath and the motes turn home. */
const SCATTER = 2.4
const RETURN = 2.6
/** At most this many motes across the card. */
const ACROSS = 320

type Phase = { name: 'still' } | { name: 'scattering'; time: number; swap: () => void } | { name: 'returning'; time: number }

export interface Dust extends Effect {
  /** Blows the card away, runs `swap` to change the page while it's gone, and brings it back. */
  scatter(swap: () => void): void
}

export function dustEffect(scene: Scene): Dust {
  const { root } = scene
  const breeze = root.createBuffer(sim.Breeze).$usage('uniform')
  const specks = root.createBuffer(draw.Specks).$usage('uniform')
  const air = root.createBindGroup(sim.layout0, { breeze })
  const look = root.createBindGroup(draw.layout0, { specks, page: scene.page })
  const gather = root.createComputePipeline({ compute: sim.gather })
  const drift = root.createComputePipeline({ compute: sim.drift })
  const speck = root.createRenderPipeline({
    vertex: draw.speckVertex,
    fragment: draw.speckFragment,
    targets: {
      format: scene.format,
      blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
    },
  })
  const backdrop = createStage(scene)
  const [texelsAcross = 1, texelsDown = 1] = scene.page.props.size

  const createCloud = () => {
    const { card } = scene
    const across = Math.min(ACROSS, Math.round(card.width / 2))
    const grid = d.vec2u(across, Math.round((across * card.cssHeight) / card.cssWidth))
    const motes = root.createBuffer(d.arrayOf(sim.Mote, grid.x * grid.y)).$usage('storage')
    return {
      grid,
      motes,
      flying: root.createBindGroup(sim.layout1, { motes }),
      drawn: root.createBindGroup(draw.layout1, { motes }),
      tiles: Math.ceil((grid.x * grid.y) / sim.WORKGROUP),
    }
  }
  let cloud = createCloud()
  let phase: Phase = { name: 'still' }

  const writeBreeze = (time: number, dt: number, returning: boolean) => {
    const { card } = scene
    breeze.write({
      card: d.vec4f(card.x, card.y, card.width, card.height),
      grid: cloud.grid,
      time,
      dt,
      returning: returning ? 1 : 0,
      scale: card.scale,
    })
  }

  const settle = () => {
    if (phase.name === 'scattering') phase.swap()
    phase = { name: 'still' }
  }

  return {
    hint: 'Press Send. The card blows away as dust, one speck per patch of the page, and comes back as a receipt.',
    enter: settle,
    resize() {
      settle()
      cloud.motes.destroy()
      cloud = createCloud()
    },
    scatter(swap) {
      if (phase.name !== 'still') return
      writeBreeze(0, 0, false)
      gather.with(air).with(cloud.flying).dispatchWorkgroups(cloud.tiles)
      phase = { name: 'scattering', time: 0, swap }
    },
    update(dt) {
      if (phase.name === 'still') return
      phase.time += dt
      if (phase.name === 'scattering' && phase.time >= SCATTER) {
        phase.swap()
        phase = { name: 'returning', time: 0 }
      } else if (phase.name === 'returning' && phase.time >= RETURN) {
        phase = { name: 'still' }
        return
      }
      writeBreeze(phase.time, dt, phase.name === 'returning')
      drift.with(air).with(cloud.flying).dispatchWorkgroups(cloud.tiles)
    },
    draw(target) {
      if (phase.name === 'still') {
        backdrop(target, { cardOpacity: 1, shadowOpacity: 1 })
        return
      }
      const shadow = phase.name === 'scattering' ? Math.max(0, 1 - phase.time / 0.8) : Math.min(1, phase.time / 1.6)
      backdrop(target, { cardOpacity: 0, shadowOpacity: shadow })
      const { card, canvas } = scene
      specks.write({
        canvas: d.vec2f(canvas.width, canvas.height),
        card: d.vec4f(card.x, card.y, card.width, card.height),
        grid: cloud.grid,
        texels: d.vec2f(texelsAcross, texelsDown),
        scale: card.scale,
      })
      speck
        .with(look)
        .with(cloud.drawn)
        .withColorAttachment({ view: target, loadOp: 'load', storeOp: 'store' })
        .draw(6 * cloud.grid.x * cloud.grid.y)
    },
    placement: () => (phase.name === 'still' ? flat(scene) : undefined),
  }
}
