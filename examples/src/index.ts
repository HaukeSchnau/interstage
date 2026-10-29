import { highlight } from './highlight.ts'
import shader from './slime/slime.wgsl?raw'
import declarations from '../.contract/slime/slime.d.wgsl.ts?raw'
import './style.css'

// The code pair shows the real files: the Params struct and what tsc declares for it.
const struct = /struct Params \{[\s\S]*?\n\}/.exec(shader)![0]
const declared = /export declare const Params: [\s\S]*?\n\}>;/.exec(declarations)![0]
const shared = new Set(struct.match(/\w+/g))
document.querySelector('#pair-wgsl')!.innerHTML = highlight(struct, 'wgsl', shared)
document.querySelector('#pair-ts')!.innerHTML = highlight(declared, 'ts', shared)
for (const pre of document.querySelectorAll<HTMLElement>('pre.code > code')) {
  pre.innerHTML = highlight(pre.textContent ?? '', 'ts', new Set())
}
