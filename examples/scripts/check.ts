// Loads every example in Chromium and checks that it draws frames without WebGPU errors.
// Run after `pnpm run build`, or set ORIGIN to check a deployment. CHROME names the browser; on
// Linux without a GPU, Chromium's SwiftShader renders WebGPU.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { chromium } from 'playwright-core'

const demos = ['slime', 'ink', 'sculpture', 'atlas']
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

const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  args: [
    '--enable-unsafe-webgpu',
    ...(process.platform === 'linux'
      ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']
      : []),
  ],
})
const page = await browser.newPage({ viewport: { width: 640, height: 360 } })

// A cold GPU process answers the first adapter requests with null, and a device made while it
// starts up is lost soon after. Waiting for it here keeps that out of the results.
await page.goto(`${origin}/`)
await page.waitForFunction(async () => Boolean(await navigator.gpu?.requestAdapter()), undefined, { timeout: 30_000, polling: 500 })
await page.waitForTimeout(2000)

let failures = 0
for (const demo of demos) {
  const started = performance.now()
  await page.goto(`${origin}/${demo}/?quality=low&capture=45`)
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
  const ok = result.errors.length === 0 && result.lit > 0.01
  if (!ok) failures++
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${demo}: ${result.frames} frames, ${(result.lit * 100).toFixed(0)}% lit, ${seconds}s${result.errors.length ? `\n     ${result.errors.join('\n     ')}` : ''}`)
}

await browser.close()
if (server.listening) server.close()
process.exitCode = failures > 0 ? 1 : 0
