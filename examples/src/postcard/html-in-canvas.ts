// The HTML-in-Canvas API (https://github.com/WICG/html-in-canvas), behind
// chrome://flags/#canvas-draw-element. It changed names during 2026, and Chrome releases carry
// different versions of it, so this file is the only place that knows them.

interface CopyDestination {
  destination: { texture: GPUTexture }
  width: number
  height: number
}

interface ElementGeometry {
  /** Maps the element's border box, in CSS pixels, to where the canvas draws it. */
  canvasTransform?: DOMMatrixInit
  preserveHitTestOrder?: boolean
}

declare global {
  interface HTMLCanvasElement {
    requestPaint?(): void
    updateElementGeometry?(element: Element, options?: ElementGeometry): void
    /** With one argument since late August 2026; before that, it also took a transform to convert. */
    getElementTransform?(element: Element): DOMMatrix
  }

  interface GPUQueue {
    /** Since September 2026; for a while before, with copyElementImageToTexture()'s destination. */
    drawElementImageToTexture?(
      source: { source: Element },
      destination: { texture: GPUTexture; size: { width: number; height: number } } | CopyDestination,
    ): void
    /** Until September 2026, with a dictionary each; before November 2025, positional. */
    copyElementImageToTexture?(
      ...args:
        | [source: { source: Element }, destination: CopyDestination]
        | [element: Element, width: number, height: number, destination: { texture: GPUTexture }]
    ): void
  }
}

/** Why this browser can't run the page, or undefined when it can. */
export function unsupported(canvas: HTMLCanvasElement): string | undefined {
  if (!('gpu' in navigator)) return 'This browser has no WebGPU.'
  if (canvas.requestPaint === undefined) return "This browser can't draw HTML into a canvas yet."
  if (!('drawElementImageToTexture' in GPUQueue.prototype) && !('copyElementImageToTexture' in GPUQueue.prototype)) {
    return 'This browser draws HTML into 2D canvases, but not into WebGPU textures yet.'
  }
  return undefined
}

type Draw = (queue: GPUQueue, element: Element, texture: GPUTexture, width: number, height: number) => void

const missing = (name: string) => new TypeError(`GPUQueue has no ${name}()`)

/** The ways to draw an element into a texture, newest first. A browser rejects the others with a TypeError. */
const dialects: Draw[] = [
  (queue, element, texture, width, height) => {
    if (!queue.drawElementImageToTexture) throw missing('drawElementImageToTexture')
    queue.drawElementImageToTexture({ source: element }, { texture, size: { width, height } })
  },
  (queue, element, texture, width, height) => {
    if (!queue.drawElementImageToTexture) throw missing('drawElementImageToTexture')
    queue.drawElementImageToTexture({ source: element }, { destination: { texture }, width, height })
  },
  (queue, element, texture, width, height) => {
    if (!queue.copyElementImageToTexture) throw missing('copyElementImageToTexture')
    queue.copyElementImageToTexture({ source: element }, { destination: { texture }, width, height })
  },
  (queue, element, texture, width, height) => {
    if (!queue.copyElementImageToTexture) throw missing('copyElementImageToTexture')
    queue.copyElementImageToTexture(element, width, height, { texture })
  },
]
let dialect: Draw | undefined

/** Draws the element's latest snapshot into the texture, scaled to `width` × `height` texels. */
export function drawElement(queue: GPUQueue, element: Element, texture: GPUTexture, width: number, height: number) {
  if (dialect) return dialect(queue, element, texture, width, height)
  for (const each of dialects) {
    try {
      each(queue, element, texture, width, height)
      dialect = each
      return
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
    }
  }
  throw new Error("This browser can't draw an element into a WebGPU texture in any way this page knows.")
}

/**
 * Returns a function that tells hit testing, focus and accessibility where the element is drawn,
 * as a transform of its border box into CSS pixels of the canvas.
 */
export function elementPlacer(canvas: HTMLCanvasElement, element: HTMLElement): (transform: DOMMatrix) => void {
  const update = canvas.updateElementGeometry?.bind(canvas)
  if (update && followsCanvasTransforms(canvas, element)) return (transform) => update(element, { canvasTransform: transform })
  // The older model hit-tests the element where its CSS transform puts it, once
  // updateElementGeometry() has made it hit-testable, in the versions that have that.
  element.style.transformOrigin = '0 0'
  return (transform) => {
    update?.(element, { canvasTransform: transform })
    element.style.transform = transform.toString()
  }
}

/**
 * Chrome 154 to 156 have updateElementGeometry() but only hit-test by its transform with
 * experimental web platform features on; otherwise, and in Chrome 153 and older, an element is
 * hit-tested where its CSS transform puts it. The one-argument getElementTransform() comes with the
 * newer model, and calling it without that model is a TypeError. Once browsers before 157 are gone,
 * updateElementGeometry() alone will do.
 */
function followsCanvasTransforms(canvas: HTMLCanvasElement, element: Element) {
  try {
    canvas.getElementTransform?.(element)
    return true
  } catch (error) {
    return !(error instanceof TypeError)
  }
}
