import assert from 'node:assert/strict'
import test from 'node:test'

import { createMarkdownRenderer } from '../../src/cli/markdown.ts'

test('renders headings, lists, emphasis, and code as terminal text', () => {
  const render = createMarkdownRenderer({ width: 80 })

  const output = render([
    '# Result',
    '',
    '- first',
    '- **second**',
    '',
    '```ts',
    'const answer = 42',
    '```',
  ].join('\n'))

  assert.match(output, /Result/)
  assert.match(output, /first/)
  assert.match(output, /second/)
  assert.match(output, /const answer = 42/)
  assert.doesNotMatch(output, /# Result/)
  assert.doesNotMatch(output, /\*\*second\*\*/)
  assert.doesNotMatch(output, /```/)
})
