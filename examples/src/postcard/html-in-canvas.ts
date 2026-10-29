// The HTML-in-Canvas API (https://github.com/WICG/html-in-canvas), behind
// chrome://flags/#canvas-draw-element. It changed names during 2026, and Chrome releases carry
// different versions of it, so this file is the only place that knows them.

interface ElementGeometry {
  /** Maps the element's border box, in CSS pixels, to where the canvas draws it. */
  canvasTransform?: DOMMatrixInit
  preserveHitTestOrder?: boolean
}

declare global {
  interface HTMLCanvasElement {
    requestPaint?(): void
    updateElementGeometry?(element: Element, options?: ElementGeometry): void
  }

  interface GPUQueue {
    /** Since September 2026. */
    drawElementImageToTexture?(
      source: { source: Element },
      destination: { texture: GPUTexture; size: { width: number; height: number } },
    ): void
    /** Until September 2026, with a dictionary each; before November 2025, positional. */
    copyElementImageToTexture?(
      ...args:
        | [source: { source: Element }, destination: { destination: { texture: GPUTexture }; width: number; height: number }]
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

/** Draws the element's latest snapshot into the texture, scaled to `width` × `height` texels. */
export function drawElement(queue: GPUQueue, element: Element, texture: GPUTexture, width: number, height: number) {
  if (queue.drawElementImageToTexture) {
    queue.drawElementImageToTexture({ source: element }, { texture, size: { width, height } })
    return
  }
  try {
    queue.copyElementImageToTexture?.({ source: element }, { destination: { texture }, width, height })
  } catch {
    queue.copyElementImageToTexture?.(element, width, height, { texture })
  }
}

/** Tells hit testing, focus and accessibility where the element is drawn, in CSS pixels of the canvas. */
export function placeElement(canvas: HTMLCanvasElement, element: HTMLElement, transform: DOMMatrix) {
  if (canvas.updateElementGeometry) canvas.updateElementGeometry(element, { canvasTransform: transform })
  else element.style.transform = transform.toString()
}
