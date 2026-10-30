import { d } from 'typegpu'
import { Lamp, layout0, fullscreen, glow } from './lamp.wgsl'
import { context, format, onFrame, pointer, root } from './page'

const lamp = root.createBuffer(Lamp).$usage('uniform')
const group = root.createBindGroup(layout0, { lamp })
const pipeline = root.createRenderPipeline({
  vertex: fullscreen,
  fragment: glow,
  targets: { format },
})

onFrame((time) => {
  lamp.write({
    size: d.vec2f(context.canvas.width, context.canvas.height),
    pointer: d.vec2f(pointer.x, pointer.y),
    time,
    melt: 0.17,
  })
  pipeline
    .with(group)
    .withColorAttachment({ view: context })
    .draw(3)
})
