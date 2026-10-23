import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

const production = 'prod'

// `alchemy dev` keeps its state in .alchemy/, so it needs no Cloudflare account.
const state = Layer.unwrap(
  Effect.gen(function* () {
    return (yield* Alchemy.ALCHEMY_DEV) ? Alchemy.localState() : Cloudflare.state()
  }).pipe(Effect.orDie),
)

/**
 * The examples, built by Vite and served by Cloudflare's asset layer without a script. Production
 * answers at interstage.schnau.dev. Any other stage, such as pr-12, is a Worker Preview of
 * production.
 */
export default Alchemy.Stack(
  'Interstage',
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack
    const site = yield* Cloudflare.Website.StaticSite('Site', {
      command: 'pnpm run build',
      outdir: 'dist',
      // The build reads the library in the parent directory too, which the memo's default of
      // hashing this directory would miss.
      memo: false,
      compatibility: { date: '2026-10-01' },
      ...(stage === production
        ? { name: 'interstage', workersDev: { enabled: false, previewsEnabled: true }, domain: 'interstage.schnau.dev' }
        : { preview: { of: yield* Cloudflare.Worker.ref('Site', { stage: production }) } }),
    })
    return { url: site.url }
  }),
)
