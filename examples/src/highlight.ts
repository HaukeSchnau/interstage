const KEYWORDS = {
  wgsl: new Set('alias break case const const_assert continue continuing default diagnostic discard else enable fn for if let loop override requires return struct switch var while true false'.split(' ')),
  ts: new Set('import export from as const let var function return if else for while new type interface declare typeof keyof extends in of true false null undefined await async default readonly'.split(' ')),
}

const WGSL_TYPES = /^(?:[iuf]32|f16|bool|vec[234][iufh]?|mat[234]x[234][fh]?|array|atomic|ptr|sampler(?:_comparison)?|texture_\w+|function|private|workgroup|uniform|storage|read|write|read_write)$/

const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|(@\w+)|(\b(?:0[xX][\da-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)[iufh]?\b)|([A-Za-z_]\w*)/g

const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)

/** Minimal syntax highlighting. Identifiers in `shared` can be highlighted across files. */
export function highlight(code: string, language: 'wgsl' | 'ts', shared: Set<string>): string {
  let html = ''
  let cursor = 0
  for (const match of code.matchAll(TOKEN)) {
    html += escape(code.slice(cursor, match.index))
    cursor = match.index + match[0].length
    const [text, comment, string, attribute, number, word] = match
    const span = (kind: string) => `<span class="${kind}">${escape(text)}</span>`
    if (comment) html += span('c')
    else if (string) html += span('s')
    else if (attribute) html += span('k')
    else if (number) html += span('n')
    else if (word && KEYWORDS[language].has(word)) html += span('k')
    else if (word && language === 'wgsl' && WGSL_TYPES.test(word)) html += span('t')
    else if (word) html += `<span class="id" data-name="${word}"${shared.has(word) ? ' data-shared' : ''}>${word}</span>`
  }
  return html + escape(code.slice(cursor))
}
