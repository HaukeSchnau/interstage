import type { TgpuRoot } from 'typegpu'

/** The texture that holds the card's latest snapshot, drawn by the HTML-in-Canvas API. */
export const createPage = (root: TgpuRoot, width: number, height: number) =>
  root.createTexture({ size: [width, height], format: 'rgba8unorm' }).$usage('sampled', 'render')

export type Page = ReturnType<typeof createPage>

export interface Card {
  /** The card's rectangle on the canvas, in device pixels. */
  x: number
  y: number
  width: number
  height: number
  /** Device pixels per CSS pixel of the card. */
  scale: number
  /** The card element's own size, in CSS pixels. */
  cssWidth: number
  cssHeight: number
}

export interface Pointer {
  /** Position on the canvas, in device pixels. */
  x: number
  y: number
  /** Movement since the previous frame, in device pixels. */
  dx: number
  dy: number
  /** Whether the pointer has been over the canvas at all. */
  seen: boolean
}

/** Where an effect draws: the canvas, or an offscreen texture when capturing. */
export type Target = GPUCanvasContext | GPUTextureView

export interface Scene {
  root: TgpuRoot
  canvas: HTMLCanvasElement
  format: GPUTextureFormat
  page: Page
  sampler: ReturnType<TgpuRoot['createSampler']>
  card: Card
  pointer: Pointer
  /** Device pixels per CSS pixel of the canvas. */
  ratio: number
}

export interface Effect {
  /** What the effect invites the visitor to do. */
  readonly hint: string
  enter(): void
  resize(): void
  update(dt: number, time: number): void
  draw(target: Target): void
  /** Where the card's border box is drawn, in CSS pixels of the canvas, or undefined while it can't be used. */
  placement(): DOMMatrix | undefined
  /** A press on the canvas; true when the effect takes it, so the page doesn't select text. */
  press?(target: EventTarget | null): boolean
  release?(): void
}

/** The card where it lies flat, as CSS pixels of the canvas. */
export function flat(scene: Scene): DOMMatrix {
  const { card, ratio } = scene
  return new DOMMatrix().translate(card.x / ratio, card.y / ratio).scale(card.scale / ratio)
}
