import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { bracketMatching } from '@codemirror/language'
import { setDiagnostics, type Diagnostic } from '@codemirror/lint'
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, highlightActiveLine, highlightActiveLineGutter, hoverTooltip, keymap, lineNumbers, type DecorationSet } from '@codemirror/view'
import { compile, type CompileResult } from 'interstage'
import { highlight } from '../highlight.ts'
import { requestAdapter } from '../shell.ts'
import { startChecker } from './checker.ts'
import type { Problem } from './checker.worker.ts'
import { createPreview, type Preview } from './preview.ts'
import sampleMain from './sample/main.ts?raw'
import sampleShader from './sample/lamp.wgsl?raw'
import { highlighting, theme, wgsl } from './theme.ts'

type File = 'lamp.wgsl' | 'main.ts'

interface Shown extends Problem {
  file: File
}

/** Scripted edits for the buttons above the editor: each pair replaces the first match in lamp.wgsl. */
const TRIES = {
  color: [['const AMBER = vec3f(0.95, 0.69, 0.21);', 'const AMBER = vec3f(1.0, 0.33, 0.3);']],
  field: [
    ['  melt: f32,\n}', '  melt: f32,\n  shine: f32,\n}'],
    ['exp(-abs(field - 1.0) * 5.0) * 0.7', 'exp(-abs(field - 1.0) * 5.0) * lamp.shine'],
  ],
  rename: [
    ['  melt: f32,', '  goo: f32,'],
    ['lamp.melt * lamp.melt', 'lamp.goo * lamp.goo'],
  ],
  reserved: [
    ['let body = ', 'let target = '],
    ['(body + rim', '(target + rim'],
  ],
} satisfies Record<string, Array<[find: string, replace: string]>>

const isTry = (name: string | undefined): name is keyof typeof TRIES => name !== undefined && name in TRIES

/** Whether each edit finds its text, after the ones before it. */
function applies(edits: ReadonlyArray<readonly [string, string]>, text: string) {
  for (const [find, replace] of edits) {
    if (!text.includes(find)) return false
    text = text.replace(find, replace)
  }
  return true
}

const element = <T extends HTMLElement>(id: string, type: abstract new () => T): T => {
  const found = document.getElementById(id)
  if (!(found instanceof type)) throw new Error(`#${id} is missing`)
  return found
}

export function mountEditor() {
  const shaderTab = element('tab-shader', HTMLButtonElement)
  const moduleTab = element('tab-module', HTMLButtonElement)
  const mainTab = element('tab-main', HTMLElement)
  const problemList = element('problem-list', HTMLUListElement)
  const problemCount = element('problem-count', HTMLElement)
  const checkerStatus = element('checker-status', HTMLElement)
  const lamp = element('lamp', HTMLCanvasElement)
  const lampStatus = element('lamp-status', HTMLElement)
  const tryButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-try]')]

  const checker = startChecker()
  let typescript: string | undefined
  let device: GPUDevice | undefined
  let preview: Preview | undefined
  const problems: Record<'shader' | 'main' | 'preview', Shown[]> = { shader: [], main: [], preview: [] }

  let lastCompile: { source: string; result: CompileResult } | undefined
  const compiled = (source: string) => {
    if (lastCompile?.source !== source) lastCompile = { source, result: compile(source) }
    return lastCompile.result
  }

  // --- The three panes --------------------------------------------------------------------------

  const common: Extension[] = [lineNumbers(), highlightActiveLineGutter(), highlighting, theme, EditorView.lineWrapping]
  const editable: Extension[] = [
    ...common,
    history(),
    highlightActiveLine(),
    bracketMatching(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        schedule()
        refreshTries()
      }
    }),
  ]

  const shaderView = new EditorView({
    parent: element('shader-editor', HTMLElement),
    state: EditorState.create({
      doc: sampleShader,
      extensions: [...editable, wgsl, hoverTooltip(shaderHover), EditorView.contentAttributes.of({ 'aria-label': 'lamp.wgsl' })],
    }),
  })

  const flash = StateEffect.define<number[]>()
  const flashes = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, transaction) {
      for (const effect of transaction.effects) {
        if (effect.is(flash)) return Decoration.set(effect.value.map((line) => Decoration.line({ class: 'cm-changed' }).range(transaction.state.doc.line(line).from)))
      }
      return value.map(transaction.changes)
    },
    provide: (field) => EditorView.decorations.from(field),
  })
  const moduleView = new EditorView({
    parent: element('module-view', HTMLElement),
    state: EditorState.create({
      doc: compiled(sampleShader).code,
      extensions: [
        ...common,
        javascript(),
        flashes,
        EditorState.readOnly.of(true),
        EditorView.contentAttributes.of({ 'aria-label': 'lamp.wgsl as tsc reads it' }),
      ],
    }),
  })

  const mainView = new EditorView({
    parent: element('main-editor', HTMLElement),
    state: EditorState.create({
      doc: sampleMain,
      extensions: [
        ...editable,
        javascript({ typescript: true }),
        hoverTooltip(mainHover, { hoverTime: 250 }),
        autocompletion({ override: [complete], icons: false }),
        keymap.of([{ key: 'F12', run: (view) => (void goToDefinition(view.state.selection.main.head), true) }]),
        EditorView.domEventHandlers({
          mousedown(event, view) {
            if (!(event.metaKey || event.ctrlKey)) return false
            const position = view.posAtCoords(event)
            if (position === null) return false
            event.preventDefault()
            void goToDefinition(position)
            return true
          },
        }),
        EditorView.contentAttributes.of({ 'aria-label': 'main.ts' }),
      ],
    }),
  })

  const showTab = (tab: 'shader' | 'module') => {
    shaderTab.setAttribute('aria-selected', String(tab === 'shader'))
    moduleTab.setAttribute('aria-selected', String(tab === 'module'))
    shaderView.dom.parentElement!.hidden = tab !== 'shader'
    moduleView.dom.parentElement!.hidden = tab !== 'module'
    if (tab === 'module') moduleTab.removeAttribute('data-changed')
  }
  shaderTab.addEventListener('click', () => showTab('shader'))
  moduleTab.addEventListener('click', () => showTab('module'))
  for (const tab of [shaderTab, moduleTab]) {
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const other = tab === shaderTab ? moduleTab : shaderTab
      other.focus()
      other.click()
    })
  }

  const showModule = (code: string) => {
    const previous = moduleView.state.doc.toString()
    if (code === previous) return
    const before = new Set(previous.split('\n'))
    const changed = code.split('\n').flatMap((line, index) => (line.trim() && !before.has(line) ? [index + 1] : []))
    moduleView.dispatch({ changes: { from: 0, to: previous.length, insert: code } })
    moduleView.dispatch({ effects: flash.of(changed) })
    if (shaderTab.getAttribute('aria-selected') === 'true') moduleTab.dataset.changed = ''
  }

  // --- Hovers, completions and go-to-definition ----------------------------------------------

  function shaderHover(view: EditorView, position: number) {
    const { code, mappings } = compiled(view.state.doc.toString())
    const mapping = mappings.find(([, , start, length]) => start <= position && position <= start + length)
    if (!mapping) return null
    const [generated, , start, length] = mapping
    const statementStart = code.lastIndexOf('\n\n', generated) + 2
    const statementEnd = code.indexOf('\n\n', generated)
    const statement = code.slice(statementStart, statementEnd < 0 ? undefined : statementEnd).trim()
    return { pos: start, end: start + length, above: true, create: () => tooltip('What interstage writes for it, and tsc reads', statement) }
  }

  async function mainHover(view: EditorView, position: number) {
    if (!typescript) return null
    const info = await checker.call('hover', view.state.doc.toString(), position)
    if (!info) return null
    return { pos: info.from, end: info.to, above: true, create: () => tooltip(undefined, info.signature, info.documentation) }
  }

  async function complete(context: CompletionContext): Promise<CompletionResult | null> {
    const word = context.matchBefore(/[\w$]*/)
    if (!word || !typescript) return null
    if (word.from === word.to && !context.explicit && context.state.sliceDoc(word.from - 1, word.from) !== '.') return null
    const entries = await checker.call('complete', context.state.doc.toString(), context.pos)
    if (context.aborted) return null
    return {
      from: word.from,
      options: entries.map((entry) => ({ label: entry.label, detail: entry.kind, boost: Math.max(-99, 50 - entry.rank) })),
      validFor: /^[\w$]*$/,
    }
  }

  async function goToDefinition(position: number) {
    if (!typescript) return
    const definition = await checker.call('definition', mainView.state.doc.toString(), position)
    if (definition?.file === 'main') {
      mainView.dispatch({ selection: { anchor: definition.from, head: definition.to }, scrollIntoView: true })
    } else if (definition?.file === 'shader') {
      // The definition is in the module interstage compiled; its mappings lead back to the shader.
      const { mappings } = compiled(shaderView.state.doc.toString())
      const mapping = mappings.find(([start, length]) => start <= definition.from && definition.from < start + length)
      if (!mapping) return
      const [, , start, length] = mapping
      showTab('shader')
      shaderView.dispatch({ selection: { anchor: start, head: start + length }, scrollIntoView: true })
      shaderView.focus()
    }
  }

  // --- Checking and running -------------------------------------------------------------------

  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void update(), 150)
  }

  async function update() {
    const current = ++generation
    const shader = shaderView.state.doc.toString()
    const main = mainView.state.doc.toString()
    const { code, diagnostics } = compiled(shader)
    showModule(code)

    problems.preview = []
    problems.shader =
      diagnostics.length > 0
        ? diagnostics.map((diagnostic) => ({ file: 'lamp.wgsl', from: diagnostic.start, to: diagnostic.end, message: diagnostic.message, code: `wgsl${diagnostic.code}` }))
        : await browserProblems(shader)
    if (current !== generation) return
    if (!typescript) return render('Waiting for TypeScript before running your changes.')

    const check = await checker.call('check', main, code)
    if (current !== generation) return
    problems.main = check.problems.map((problem) => ({ ...problem, file: 'main.ts' }))
    checkerStatus.textContent = `TypeScript ${typescript} checked main.ts in ${Math.max(1, Math.round(check.milliseconds))} ms.`
    if (!preview) return render(undefined)
    if (problems.shader.length > 0 || problems.main.length > 0) return render('Showing the last version without problems.')

    const error = await preview.run(`${shader}\0${main}`, code, await checker.call('transpile', main))
    if (current !== generation) return
    if (error) problems.preview = [{ file: 'main.ts', from: 0, to: 0, message: error, code: 'runtime' }]
    render(error ? 'Showing the last version that ran.' : undefined)
  }

  async function browserProblems(source: string): Promise<Shown[]> {
    if (!device) return []
    device.pushErrorScope('validation')
    const info = await device.createShaderModule({ code: source }).getCompilationInfo()
    await device.popErrorScope()
    return info.messages
      .filter((message) => message.type === 'error')
      .map((message) => ({ file: 'lamp.wgsl', from: message.offset, to: message.offset + message.length, message: message.message, code: 'browser' }))
  }

  function render(held: string | undefined) {
    const all = [...problems.shader, ...problems.main, ...problems.preview]
    for (const [view, file] of [
      [shaderView, 'lamp.wgsl'],
      [mainView, 'main.ts'],
    ] as const) {
      const length = view.state.doc.length
      const diagnostics = all
        .filter((problem) => problem.file === file && problem.code !== 'runtime')
        .map((problem): Diagnostic => {
          const from = Math.min(problem.from, length)
          return { from, to: Math.min(Math.max(problem.to, from + 1), length), severity: 'error', message: `${problem.code}: ${problem.message}` }
        })
      view.dispatch(setDiagnostics(view.state, diagnostics))
    }
    shaderTab.toggleAttribute('data-problems', problems.shader.length > 0)
    mainTab.toggleAttribute('data-problems', problems.main.length > 0)

    problemCount.textContent = all.length === 0 ? 'None' : String(all.length)
    if (all.length === 0 && typescript) {
      const item = document.createElement('li')
      item.className = 'empty'
      item.textContent = preview ? 'Nothing to fix, so the lamp runs this version.' : 'Nothing to fix.'
      problemList.replaceChildren(item)
    } else problemList.replaceChildren(
      ...all.map((problem) => {
        const item = document.createElement('li')
        const button = document.createElement('button')
        button.type = 'button'
        const view = problem.file === 'lamp.wgsl' ? shaderView : mainView
        const line = view.state.doc.lineAt(Math.min(problem.from, view.state.doc.length))
        const where = problem.code === 'runtime' ? 'preview' : `${problem.file}(${line.number},${problem.from - line.from + 1})`
        const source = problem.code === 'browser' ? "your browser's WGSL compiler" : problem.code === 'runtime' ? 'running main.ts' : ''
        button.innerHTML = `<span class="where"></span> <span class="code"></span> <span class="message"></span>${source ? ' <span class="source"></span>' : ''}`
        button.querySelector('.where')!.textContent = where
        button.querySelector('.code')!.textContent = problem.code === 'browser' ? 'error' : `error ${problem.code}`
        button.querySelector('.message')!.textContent = problem.message
        if (source) button.querySelector('.source')!.textContent = `(${source})`
        button.addEventListener('click', () => {
          if (problem.file === 'lamp.wgsl') showTab('shader')
          view.dispatch({ selection: { anchor: Math.min(problem.from, view.state.doc.length) }, scrollIntoView: true })
          view.focus()
        })
        item.append(button)
        return item
      }),
    )
    if (preview) lampStatus.textContent = held ?? 'Drawn by the code in the editor. Move the pointer over it.'
  }

  // --- Scripted edits ---------------------------------------------------------------------------

  let playing = false
  function refreshTries() {
    const text = shaderView.state.doc.toString()
    for (const button of tryButtons) {
      const name = button.dataset.try
      button.disabled = playing || (isTry(name) ? !applies(TRIES[name], text) : text === sampleShader && mainView.state.doc.toString() === sampleMain)
    }
  }

  async function play(edits: ReadonlyArray<readonly [string, string]>) {
    playing = true
    refreshTries()
    showTab('shader')
    const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
    for (const [find, replace] of edits) {
      const at = shaderView.state.doc.toString().indexOf(find)
      if (at < 0) break
      // Type only what differs, the way a person would.
      let same = 0
      while (same < find.length && find[same] === replace[same]) same++
      let tail = 0
      while (tail < find.length - same && tail < replace.length - same && find.at(-1 - tail) === replace.at(-1 - tail)) tail++
      const from = at + same
      const insert = replace.slice(same, replace.length - tail)
      shaderView.dispatch({ selection: { anchor: from, head: at + find.length - tail }, scrollIntoView: true })
      await pause(450)
      shaderView.dispatch({ changes: { from, to: at + find.length - tail }, selection: { anchor: from } })
      for (const [index, char] of [...insert].entries()) {
        shaderView.dispatch({ changes: { from: from + index, insert: char }, selection: { anchor: from + index + 1 }, scrollIntoView: true })
        await pause(55)
      }
      await pause(300)
    }
    playing = false
    refreshTries()
  }

  for (const button of tryButtons) {
    button.addEventListener('click', () => {
      const name = button.dataset.try
      if (isTry(name)) return void play(TRIES[name])
      shaderView.dispatch({ changes: { from: 0, to: shaderView.state.doc.length, insert: sampleShader } })
      mainView.dispatch({ changes: { from: 0, to: mainView.state.doc.length, insert: sampleMain } })
    })
  }
  refreshTries()

  // --- Start ------------------------------------------------------------------------------------

  checkerStatus.textContent = 'Loading TypeScript 6 to check main.ts…'
  checker.ready.then(
    (version) => {
      typescript = version
      void update()
    },
    (error: Error) => (checkerStatus.textContent = `TypeScript didn't load: ${error.message}`),
  )

  void (async () => {
    try {
      if (!navigator.gpu) throw new Error('This browser has no WebGPU.')
      device = await (await requestAdapter()).requestDevice()
      const captureAt = Number(new URLSearchParams(location.search).get('capture') ?? 0)
      preview = createPreview(lamp, device, {
        captureAt,
        onError: (message) => {
          problems.preview = [{ file: 'main.ts', from: 0, to: 0, message, code: 'runtime' }]
          render('Stopped. Fix main.ts to start it again.')
        },
      })
      // The sample type-checks in CI, so it runs before TypeScript has loaded here.
      const error = await preview.run(`${sampleShader}\0${sampleMain}`, compiled(sampleShader).code, sampleMain)
      if (error) problems.preview = [{ file: 'main.ts', from: 0, to: 0, message: error, code: 'runtime' }]
      render(undefined)
    } catch (error) {
      lamp.hidden = true
      lampStatus.textContent = `The preview needs WebGPU, which it couldn't get: ${error instanceof Error ? error.message : String(error)} The editor still checks both files.`
    }
  })()
}

function tooltip(caption: string | undefined, code: string, documentation?: string) {
  const dom = document.createElement('div')
  dom.className = 'hover'
  if (caption) {
    const heading = document.createElement('p')
    heading.className = 'hover-caption'
    heading.textContent = caption
    dom.append(heading)
  }
  const pre = document.createElement('pre')
  pre.className = 'code'
  pre.innerHTML = highlight(code, 'ts', new Set())
  dom.append(pre)
  if (documentation) {
    const notes = document.createElement('p')
    notes.className = 'hover-notes'
    notes.textContent = documentation
    dom.append(notes)
  }
  return { dom }
}
