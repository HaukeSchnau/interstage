// Loads every example in Chromium and checks that it draws frames without WebGPU errors. The home
// page's editor also has to report a type error once the shader changes, and the postcard has to
// take a click, typing and a press of Send where the canvas draws it.
// Run after `pnpm run build`, or set ORIGIN to check a deployment. CHROME names the browser; on
// Linux without a GPU, Chromium's SwiftShader renders WebGPU.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { chromium, type Page } from 'playwright-core'

const linux = process.platform === 'linux'
const features = (...names: string[]) => `--enable-features=${[...names, ...(linux ? ['Vulkan'] : [])].join(',')}`
const runs = [
  // chrome://flags#canvas-draw-element with experimental web platform features. The other pages
  // need neither.
  { label: '', args: [features('CanvasDrawElement'), '--enable-experimental-web-platform-features'], demos: ['editor', 'slime', 'ink', 'sculpture', 'atlas', 'postcard'] },
  // canvas-draw-element alone, all the postcard asks for. Chrome 156 and older then hit-test drawn
  // elements where their CSS transform puts them, not where updateElementGeometry() says.
  { label: ' with only canvas-draw-element', args: [features('CanvasDrawElement')], demos: ['postcard'] },
]
const viewports: Record<string, { width: number; height: number }> = {
  editor: { width: 1280, height: 800 },
  // The postcard needs room beside its panel, or the panel covers the card's Send button.
  postcard: { width: 1024, height: 640 },
}
const dist = join(import.meta.dirname, '../dist')
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.webp': 'image/webp' }

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname
  const file = join(dist, path.endsWith('/') ? `${path}index.html` : path)
  const body = await readFile(file).catch(() => undefined)
  if (body) response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body)
  else response.writeHead(404).end()
})
if (!process.env.ORIGIN) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = process.env.ORIGIN ?? `http://127.0.0.1:${(server.address() as { port: number }).port}`

let failures = 0
for (const run of runs) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME,
    args: [
      '--enable-unsafe-webgpu',
      ...(linux ? ['--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface'] : []),
      ...run.args,
    ],
  })
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } })

  // A cold GPU process answers the first adapter requests with null, and a device made while it
  // starts up is lost soon after. Waiting for it here keeps that out of the results.
  await page.goto(`${origin}/?capture=600`)
  await page.waitForFunction(async () => Boolean(await navigator.gpu?.requestAdapter()), undefined, { timeout: 30_000, polling: 500 })
  await page.waitForTimeout(2000)

  for (const demo of run.demos) {
    const started = performance.now()
    await page.setViewportSize(viewports[demo] ?? { width: 640, height: 360 })
    await page.goto(demo === 'editor' ? `${origin}/?capture=45` : `${origin}/${demo}/?quality=low&capture=45`)
    // The editor's lamp only draws while it is on screen.
    if (demo === 'editor') await page.locator('#lamp').scrollIntoViewIfNeeded()
    const result = await page
      .waitForFunction(() => window.__interstage?.capture ?? (window.__interstage?.errors.length ? 'failed' : undefined), undefined, { timeout: 180_000, polling: 1000 })
      .then(() => page.evaluate(async () => {
        const { frames, errors, capture } = window.__interstage!
        if (!capture) return { frames, errors, lit: 0 }
        const image = new Image()
        image.src = capture
        await image.decode()
        const canvas = new OffscreenCanvas(image.width, image.height)
        const context = canvas.getContext('2d')!
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, image.width, image.height).data
        let lit = 0
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! + pixels[i + 1]! + pixels[i + 2]! > 24) lit++
        return { frames, errors, lit: lit / (pixels.length / 4) }
      }))
      .catch((error: Error) => ({ frames: 0, errors: [error.message], lit: 0 }))
    if (demo === 'editor' && result.errors.length === 0) result.errors.push(...(await useEditor(page)))
    if (demo === 'postcard' && result.errors.length === 0) result.errors.push(...(await usePostcard(page)))
    const ok = result.errors.length === 0 && result.lit > 0.01
    if (!ok) failures++
    const seconds = ((performance.now() - started) / 1000).toFixed(1)
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${demo}${run.label}: ${result.frames} frames, ${(result.lit * 100).toFixed(0)}% lit, ${seconds}s${result.errors.length ? `\n     ${result.errors.join('\n     ')}` : ''}`)
  }
  await browser.close()
}

/** Renames a field in the shader, which TypeScript should then report in main.ts. */
async function useEditor(page: Page): Promise<string[]> {
  try {
    await page.waitForFunction(() => /checked main\.ts/.test(document.querySelector('#checker-status')?.textContent ?? ''), undefined, { timeout: 120_000 })
    await page.click('[data-try="rename"]')
    await page.waitForFunction(() => document.querySelector('#problem-list')?.textContent?.includes("'melt' does not exist"), undefined, { timeout: 60_000 })
    return []
  } catch (error) {
    return [`The editor didn't report the renamed field: ${error instanceof Error ? error.message : String(error)}`]
  }
}

/** Clicks the drawn name field, types a name and clicks the drawn Send button. */
async function usePostcard(page: Page): Promise<string[]> {
  try {
    await clickDrawn(page, 'input[name=to]')
    if (!(await page.evaluate(() => document.activeElement?.getAttribute('name') === 'to'))) throw new Error('a click on the drawn name field missed it')
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('the check')
    await clickDrawn(page, 'button[type=submit]')
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('#card')?.inert && document.querySelector('#sent-to')?.textContent === 'the check', undefined, { timeout: 120_000 })
    return []
  } catch (error) {
    return [`The postcard didn't take input: ${error instanceof Error ? error.message : String(error)}`]
  }
}

/**
 * Clicks the middle of a control on the card where the canvas draws it, which the page reports as
 * the card's placement. Chrome's own idea of where the control is, which a locator would use,
 * is what this checks.
 */
async function clickDrawn(page: Page, selector: string) {
  const point = await page.evaluate((selector) => {
    const card = document.querySelector<HTMLElement>('#card')
    const control = card?.querySelector<HTMLElement>(selector)
    const placement = window.__interstage?.placement
    if (!card || !control || !placement) throw new Error(`${selector} or the card's placement is missing`)
    // Layout offsets, which transforms leave alone.
    const offset = (node: HTMLElement) => {
      let x = 0
      let y = 0
      for (let at: Element | null = node; at instanceof HTMLElement; at = at.offsetParent) {
        x += at.offsetLeft
        y += at.offsetTop
      }
      return { x, y }
    }
    const inCard = { x: offset(control).x - offset(card).x + control.offsetWidth / 2, y: offset(control).y - offset(card).y + control.offsetHeight / 2 }
    const drawn = new DOMMatrix(placement).transformPoint(inCard)
    return { x: drawn.x, y: drawn.y }
  }, selector)
  await page.mouse.click(point.x, point.y)
}

if (server.listening) server.close()
process.exitCode = failures > 0 ? 1 : 0
