import type { TgpuRoot } from 'typegpu'

// What the editor on the home page gives main.ts: a TypeGPU root on your GPU and the preview's canvas.

export declare const root: TgpuRoot
export declare const context: GPUCanvasContext
export declare const format: GPUTextureFormat
/** The pointer over the preview, in canvas pixels. */
export declare const pointer: { readonly x: number; readonly y: number }
/** Calls `draw` every frame with the seconds since the preview started. */
export declare function onFrame(draw: (time: number) => void): void
