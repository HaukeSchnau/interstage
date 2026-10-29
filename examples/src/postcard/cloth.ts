import { d } from 'typegpu'
import { mat4, vec4, type Mat4 } from 'wgpu-matrix'
import { flat, type Effect, type Scene } from './scene.ts'
import * as draw from './cloth-draw.wgsl'
import * as sim from './cloth-sim.wgsl'
import { createStage } from './stage.ts'

const GRID = d.vec2u(30, 40)
const STEP = 1 / 120
/** Spring relaxations per step; even, so the result lands back in `points`. */
const RELAXATIONS = 24
const FIELD_OF_VIEW = Math.PI / 6

/** Presses on these stay with the form instead of grabbing the cloth. */
const CONTROLS = 'input, textarea, button, select, label'

export function clothEffect(scene: Scene): Effect {
  const { root } = scene
  const count = GRID.x * GRID.y
  const physics = root.createBuffer(sim.Physics).$usage('uniform')
  const camera = root.createBuffer(draw.Camera).$usage('uniform')
  const createPoints = () => root.createBuffer(d.arrayOf(d.vec4f, count)).$usage('storage')
  const points = createPoints()
  const relaxed = createPoints()
  const previous = createPoints()
  const grab = root.createBuffer(d.atomic(d.u32)).$usage('storage')

  const world = root.createBindGroup(sim.layout0, { physics })
  const forward = root.createBindGroup(sim.layout1, { points, relaxed, previous, grab })
  const backward = root.createBindGroup(sim.layout1, { points: relaxed, relaxed: points, previous, grab })
  const look = root.createBindGroup(draw.layout0, { camera, page: scene.page, pageSampler: scene.sampler })
  const mesh = root.createBindGroup(draw.layout1, { points })

  const hang = root.createComputePipeline({ compute: sim.hang })
  const pick = root.createComputePipeline({ compute: sim.pick })
  const integrate = root.createComputePipeline({ compute: sim.integrate })
  const relax = root.createComputePipeline({ compute: sim.relax })
  const fold = root.createRenderPipeline({
    vertex: draw.foldVertex,
    fragment: draw.foldFragment,
    targets: { format: scene.format },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    // The grid's triangles wind clockwise on screen when the printed side faces the camera.
    primitive: { cullMode: 'none', frontFace: 'cw' },
  })
  const backdrop = createStage(scene)
  const tiles = Math.ceil(count / sim.WORKGROUP)

  const createDepth = () => root.createTexture({ size: [scene.canvas.width, scene.canvas.height], format: 'depth24plus' }).$usage('render')
  let depth = createDepth()
  let viewProjection: Mat4 = mat4.identity()
  let holding = false
  let behind = 0
  let corners: DOMMatrix | undefined
  let reading = false

  /** World units are the card's CSS pixels; the camera stands where the flat card fills its rectangle. */
  const aim = () => {
    const { card, canvas } = scene
    const distance = canvas.height / card.scale / 2 / Math.tan(FIELD_OF_VIEW / 2)
    const projection = mat4.perspective(FIELD_OF_VIEW, canvas.width / canvas.height, distance * 0.25, distance * 4)
    const view = mat4.lookAt([0, 0, distance], [0, 0, 0], [0, 1, 0])
    const centerX = card.x + card.width / 2
    const centerY = card.y + card.height / 2
    const shift = mat4.translation([(centerX / canvas.width) * 2 - 1, 1 - (centerY / canvas.height) * 2, 0])
    viewProjection = mat4.multiply(shift, mat4.multiply(projection, view))
  }

  const writePhysics = (time: number) => {
    const { pointer, canvas } = scene
    physics.write({
      viewProjection,
      inverseViewProjection: mat4.inverse(viewProjection),
      size: d.vec2f(scene.card.cssWidth, scene.card.cssHeight),
      grid: GRID,
      canvas: d.vec2f(canvas.width, canvas.height),
      pointer: d.vec2f((pointer.x / canvas.width) * 2 - 1, 1 - (pointer.y / canvas.height) * 2),
      time,
      dt: STEP,
      wind: 1,
      holding: holding ? 1 : 0,
    })
  }

  const toCanvas = (x: number, y: number, z: number) => {
    const clip = vec4.transformMat4([x, y, z, 1], viewProjection)
    const ratio = scene.ratio
    return new DOMPoint((((clip[0]! / clip[3]!) + 1) / 2) * (scene.canvas.width / ratio), ((1 - clip[1]! / clip[3]!) / 2) * (scene.canvas.height / ratio))
  }

  /** Hit testing gets an affine map, so it follows three corners of the cloth, read back a frame late. */
  const follow = async () => {
    if (reading) return
    reading = true
    const at = await points.read()
    reading = false
    const topLeft = at[0]
    const topRight = at[GRID.x - 1]
    const bottomLeft = at[(GRID.y - 1) * GRID.x]
    if (!topLeft || !topRight || !bottomLeft) return
    const origin = toCanvas(topLeft.x, topLeft.y, topLeft.z)
    const across = toCanvas(topRight.x, topRight.y, topRight.z)
    const down = toCanvas(bottomLeft.x, bottomLeft.y, bottomLeft.z)
    const { cssWidth, cssHeight } = scene.card
    corners = new DOMMatrix([
      (across.x - origin.x) / cssWidth,
      (across.y - origin.y) / cssWidth,
      (down.x - origin.x) / cssHeight,
      (down.y - origin.y) / cssHeight,
      origin.x,
      origin.y,
    ])
  }

  const settle = () => {
    aim()
    writePhysics(0)
    hang.with(world).with(forward).dispatchWorkgroups(tiles)
    corners = undefined
  }

  return {
    hint: 'Grab the card outside its fields and pull. The fields still take typing while it sways.',
    enter: settle,
    resize() {
      depth.destroy()
      depth = createDepth()
      settle()
    },
    update(dt, time) {
      behind = Math.min(behind + dt, STEP * 4)
      for (; behind >= STEP; behind -= STEP) {
        writePhysics(time)
        integrate.with(world).with(forward).dispatchWorkgroups(tiles)
        for (let i = 0; i < RELAXATIONS; i += 2) {
          relax.with(world).with(forward).dispatchWorkgroups(tiles)
          relax.with(world).with(backward).dispatchWorkgroups(tiles)
        }
      }
      void follow()
    },
    draw(target) {
      backdrop(target, { cardOpacity: 0, shadowOpacity: 0 })
      camera.write({ viewProjection, grid: GRID })
      fold
        .with(look)
        .with(mesh)
        .withColorAttachment({ view: target, loadOp: 'load', storeOp: 'store' })
        .withDepthStencilAttachment({ view: depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' })
        .draw((GRID.x - 1) * (GRID.y - 1) * 6)
    },
    placement: () => corners ?? flat(scene),
    press(target) {
      if (target instanceof Element && target.closest(CONTROLS)) return false
      holding = true
      grab.write(0xffffffff)
      writePhysics(0)
      pick.with(world).with(forward).dispatchWorkgroups(tiles)
      return true
    },
    release() {
      holding = false
    },
  }
}
