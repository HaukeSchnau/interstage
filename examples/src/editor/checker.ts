import type { CheckerApi, Reply } from './checker.worker.ts'

export type Checker = ReturnType<typeof startChecker>

/** Starts TypeScript in a worker. `ready` resolves with its version once it has loaded. */
export function startChecker() {
  const worker = new Worker(new URL('./checker.worker.ts', import.meta.url), { type: 'module' })
  const waiting = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>()
  let next = 0

  const ready = new Promise<string>((resolve, reject) => {
    worker.addEventListener('error', (event) => reject(new Error(event.message || 'The TypeScript worker failed to start.')))
    worker.addEventListener('message', ({ data }: MessageEvent<Reply>) => {
      if ('ready' in data) return resolve(data.ready)
      const call = waiting.get(data.id)
      waiting.delete(data.id)
      if ('error' in data) call?.reject(new Error(data.error))
      else call?.resolve(data.result)
    })
  })

  function call<Method extends keyof CheckerApi>(method: Method, ...args: Parameters<CheckerApi[Method]>) {
    const id = next++
    return new Promise<ReturnType<CheckerApi[Method]>>((resolve, reject) => {
      // The worker answers with what `method` returned, which postMessage can't carry as a type.
      waiting.set(id, { resolve: resolve as (result: unknown) => void, reject })
      worker.postMessage({ id, method, args })
    })
  }

  return { ready, call }
}
