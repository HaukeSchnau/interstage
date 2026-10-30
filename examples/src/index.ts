import { mountEditor } from './editor/editor.ts'
import { highlight } from './highlight.ts'
import './style.css'

for (const pre of document.querySelectorAll<HTMLElement>('pre.code > code')) {
  pre.innerHTML = highlight(pre.textContent ?? '', 'ts', new Set())
}
mountEditor()
