import {
  Marked,
  type MarkedExtension,
  type RendererObject,
} from 'marked'
import { markedTerminal } from 'marked-terminal'

export interface MarkdownRendererOptions {
  width: number
}

/** Creates an isolated Markdown renderer for terminal Final Content previews. */
export function createMarkdownRenderer(options: MarkdownRendererOptions): (source: string) => string {
  const extension = markedTerminal({
    width: options.width,
    reflowText: true,
    showSectionPrefix: false,
  }) as unknown as MarkedExtension
  extension.renderer = {
    ...extension.renderer,
    list: renderList,
  }
  const parser = new Marked(extension)

  return source => {
    const rendered = parser.parse(source, { async: false })
    return rendered.trimEnd()
  }
}

const renderList: NonNullable<RendererObject['list']> = function (list) {
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
    return `    ${marker} ${checkbox}${content}`
  })
  return `${items.join('\n')}\n\n`
}
