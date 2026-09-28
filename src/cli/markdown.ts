import {
  Marked,
  type MarkedExtension,
  type RendererObject,
} from 'marked'
import { markedTerminal } from 'marked-terminal'

import { createColor, type TraceColor } from './colors.ts'

export interface MarkdownRendererOptions {
  width: number
  colors?: boolean | undefined
}

/** Creates an isolated Markdown renderer for terminal Final Content previews. */
export function createMarkdownRenderer(options: MarkdownRendererOptions): (source: string) => string {
  const color = createColor(options.colors === true)
  const extension = markedTerminal({
    width: options.width,
    reflowText: true,
    showSectionPrefix: false,
    firstHeading: color.boldCyan,
    heading: color.boldCyan,
    strong: color.bold,
    em: color.italic,
    codespan: color.yellow,
    code: color.yellow,
    blockquote: color.dimItalic,
    link: color.cyan,
    href: color.underline,
  }) as unknown as MarkedExtension
  extension.renderer = {
    ...extension.renderer,
    list: renderList(color),
  }
  const parser = new Marked(extension)

  return source => {
    const rendered = parser.parse(source, { async: false })
    return rendered.trimEnd()
  }
}

const renderList = (color: TraceColor): NonNullable<RendererObject['list']> => function (list) {
  const start = typeof list.start === 'number' ? list.start : 1
  const items = list.items.map((item, index) => {
    const content = item.tokens.map(token => {
      if (token.type === 'text' && token.tokens) {
        return this.parser.parseInline(token.tokens)
      }
      return this.parser.parse([token])
    }).join('').trim()
    const marker = list.ordered ? `${start + index}.` : '*'
    const checkbox = item.task ? `[${item.checked ? 'X' : ' '}] ` : ''
    return `    ${color.cyan(marker)} ${checkbox}${content}`
  })
  return `${items.join('\n')}\n\n`
}
