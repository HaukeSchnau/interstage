import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

const KEYWORDS = new Set(
  'alias break case const const_assert continue continuing default diagnostic discard else enable fn for if let loop override requires return struct switch var while true false'.split(' '),
)
const TYPES = /^(?:[iuf]32|f16|bool|vec[234][iufh]?|mat[234]x[234][fh]?|array|atomic|ptr|sampler(?:_comparison)?|texture_\w+|function|private|workgroup|uniform|storage|read|write|read_write)$/

/** WGSL tokens, enough to color the editor's shader. */
export const wgsl = StreamLanguage.define<{ comment: boolean }>({
  name: 'wgsl',
  startState: () => ({ comment: false }),
  token(stream, state) {
    if (state.comment) {
      state.comment = !stream.match(/^.*?\*\//)
      if (state.comment) stream.skipToEnd()
      return 'comment'
    }
    if (stream.eatSpace()) return null
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match('/*')) {
      state.comment = true
      return 'comment'
    }
    if (stream.match(/^@\w+/)) return 'meta'
    if (stream.match(/^(?:0[xX][\da-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)[iufh]?/)) return 'number'
    if (stream.match(/^[A-Za-z_]\w*/)) {
      const word = stream.current()
      if (KEYWORDS.has(word)) return 'keyword'
      if (TYPES.test(word)) return 'typeName'
      return stream.peek() === '(' ? 'variableName.function' : 'variableName'
    }
    stream.next()
    return null
  },
  languageData: { commentTokens: { line: '//' } },
})

/** The site's code colors, as on the code blocks below the editor. */
export const highlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [tags.keyword, tags.meta, tags.modifier, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: '#c9a6ff' },
    { tag: [tags.typeName, tags.className, tags.standard(tags.typeName)], color: '#8fd6c7' },
    { tag: [tags.number, tags.bool, tags.null], color: '#f0a58f' },
    { tag: [tags.string, tags.special(tags.string)], color: '#b9d98b' },
    { tag: tags.comment, color: '#77736c', fontVariationSettings: "'MONO' 1, 'CASL' 1" },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#f3efe6' },
  ]),
)

export const theme = EditorView.theme(
  {
    '&': { color: 'var(--chalk)', backgroundColor: 'transparent', fontSize: '0.8125rem', height: '100%' },
    '.cm-scroller': { fontFamily: 'var(--sans)', fontVariationSettings: "'MONO' 1, 'CASL' 0", lineHeight: '1.6' },
    '.cm-content': { padding: '0.75rem 0', caretColor: 'var(--chalk)' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#4a4843', border: 'none', paddingLeft: '0.5rem' },
    '.cm-activeLine': { backgroundColor: 'rgb(255 255 255 / 0.025)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--graphite)' },
    '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--chalk)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgb(127 182 255 / 0.22)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-lintRange-error': {
      backgroundImage: 'none',
      textDecoration: 'underline wavy #ff6f61',
      textDecorationSkipInk: 'none',
      textUnderlineOffset: '0.25em',
    },
    '.cm-tooltip': {
      backgroundColor: '#111110',
      color: 'var(--chalk)',
      border: '1px solid var(--seam)',
      borderRadius: '8px',
      boxShadow: '0 12px 32px rgb(0 0 0 / 0.5)',
      maxWidth: 'min(36rem, 90vw)',
    },
    '.cm-tooltip-lint': { padding: '0' },
    '.cm-diagnostic': { padding: '0.5rem 0.75rem', borderLeft: '3px solid #ff6f61', fontSize: '0.8125rem' },
    '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--sans)', fontVariationSettings: "'MONO' 1", fontSize: '0.8125rem' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'rgb(127 182 255 / 0.2)', color: 'var(--chalk)' },
    '.cm-completionIcon': { display: 'none' },
    '.cm-completionDetail': { color: 'var(--graphite)', fontStyle: 'normal', marginLeft: '1em' },
  },
  { dark: true },
)
