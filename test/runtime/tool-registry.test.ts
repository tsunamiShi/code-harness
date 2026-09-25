import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ToolRegistry,
  TOOL_EXECUTE_NAME,
  TOOL_SEARCH_NAME,
} from '../../src/runtime/tool-registry.ts'
import type { Message, Tool } from '../../src/runtime/types.ts'

test('keeps searchable schemas hidden and returns their contracts through ToolSearch', async () => {
  const read = tool('Read', 'Read a local file.')
  const sendEmail = tool('mcp__mail__send_email', 'Send an email message to a recipient.', {
    type: 'object',
    properties: { recipient: { type: 'string', description: 'Email recipient.' } },
    required: ['recipient'],
    additionalProperties: false,
  })
  const listEvents = tool('mcp__calendar__list_events', 'List calendar events in a date range.')
  const registry = new ToolRegistry({
    tools: [read],
    searchableTools: [sendEmail, listEvents],
  })

  assert.deepEqual(registry.descriptions().map(description => description.name), [
    'Read',
    TOOL_SEARCH_NAME,
    TOOL_EXECUTE_NAME,
  ])
  assert.equal(registry.get(sendEmail.description.name), undefined)

  const result = JSON.parse(await requireTool(registry, TOOL_SEARCH_NAME).execute({
    query: 'send email',
  })) as {
    matches: string[]
    tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
  }

  assert.equal(result.matches[0], 'mcp__mail__send_email')
  assert.deepEqual(result.tools[0], {
    name: 'mcp__mail__send_email',
    description: 'Send an email message to a recipient.',
    input_schema: sendEmail.description.parameters,
  })
  assert.equal(registry.get(sendEmail.description.name), undefined)
  assert.deepEqual(registry.descriptions().map(description => description.name), [
    'Read',
    TOOL_SEARCH_NAME,
    TOOL_EXECUTE_NAME,
  ])
})

test('uses explicit field weights to rank action names over verbose description matches', async () => {
  const registry = new ToolRegistry({
    tools: [],
    searchableTools: [
      tool('mcp__dingtalk_docs__insert_document_block', 'Insert text nodes into a document body.'),
      tool('mcp__dingtalk_docs__get_document_content', 'Get the complete content of one document.'),
      tool('mcp__dingtalk_docs__list_documents', 'List document metadata and recent nodes.'),
    ],
  })

  const result = JSON.parse(await requireTool(registry, TOOL_SEARCH_NAME).execute({
    query: 'get document content body text read nodes',
  })) as { matches: string[] }

  assert.equal(result.matches[0], 'mcp__dingtalk_docs__get_document_content')
})

test('tokenizes Chinese descriptions for manually weighted search', async () => {
  const registry = new ToolRegistry({
    tools: [],
    searchableTools: [
      tool('mcp__dingtalk__read_doc', '读取钉钉云文档内容'),
      tool('mcp__dingtalk__list_contacts', '查询钉钉组织通讯录'),
    ],
  })

  const result = JSON.parse(await requireTool(registry, TOOL_SEARCH_NAME).execute({
    query: '钉钉文档',
  })) as { matches: string[] }

  assert.equal(result.matches[0], 'mcp__dingtalk__read_doc')
})

test('searches only names, descriptions, parameter names, and parameter descriptions', async () => {
  const registry = new ToolRegistry({
    tools: [],
    searchableTools: [
      tool('mcp__billing__lookup', 'Look up a billing record.', {
        type: 'object',
        properties: {
          invoiceNumber: {
            type: 'string',
            description: 'Customer tax receipt identifier.',
            enum: ['schema-only-secret'],
            examples: [{ properties: { fakeParameter: { description: 'example-only-secret' } } }],
          },
        },
      }),
      tool('mcp__billing__refund', 'Refund a billing record.'),
    ],
  })
  const search = requireTool(registry, TOOL_SEARCH_NAME)

  const byName = JSON.parse(await search.execute({ query: 'invoice number' })) as { matches: string[] }
  const byDescription = JSON.parse(await search.execute({ query: 'tax receipt identifier' })) as { matches: string[] }
  const schemaOnly = JSON.parse(await search.execute({ query: 'schema-only-secret' })) as { matches: string[] }
  const exampleOnly = JSON.parse(await search.execute({ query: 'example-only-secret fake parameter' })) as { matches: string[] }

  assert.equal(byName.matches[0], 'mcp__billing__lookup')
  assert.equal(byDescription.matches[0], 'mcp__billing__lookup')
  assert.deepEqual(schemaOnly.matches, [])
  assert.deepEqual(exampleOnly.matches, [])
})

test('supports CCB-style direct selection and required search terms', async () => {
  const registry = new ToolRegistry({
    tools: [],
    searchableTools: [
      tool('mcp__docs__read_document', 'Read a cloud document.'),
      tool('mcp__docs__delete_document', 'Delete a cloud document.'),
      tool('mcp__mail__read_message', 'Read an email message.'),
    ],
  })
  const search = requireTool(registry, TOOL_SEARCH_NAME)

  const selected = JSON.parse(await search.execute({
    query: 'select:mcp__docs__delete_document',
  })) as { matches: string[] }
  const required = JSON.parse(await search.execute({
    query: '+docs +read document',
  })) as { matches: string[] }

  assert.deepEqual(selected.matches, ['mcp__docs__delete_document'])
  assert.deepEqual(required.matches, ['mcp__docs__read_document'])
})

test('returns at most five matches', async () => {
  const registry = new ToolRegistry({
    tools: [],
    searchableTools: Array.from({ length: 8 }, (_, index) => (
      tool(`mcp__calendar__tool_${index}`, 'Manage a calendar event.')
    )),
  })

  const result = JSON.parse(await requireTool(registry, TOOL_SEARCH_NAME).execute({
    query: 'calendar event',
    limit: 10,
  })) as { matches: string[] }

  assert.equal(result.matches.length, 5)
})

test('blocks same-batch execution and validates target parameters before dispatch', async () => {
  let calls = 0
  const sendEmail = tool('mcp__mail__send_email', 'Send an email message.', {
    type: 'object',
    properties: {
      recipient: { type: 'string' },
      retries: { type: 'integer', minimum: 0 },
    },
    required: ['recipient'],
    additionalProperties: false,
  }, async arguments_ => {
    calls += 1
    return JSON.stringify(arguments_)
  })
  const registry = new ToolRegistry({ tools: [], searchableTools: [sendEmail] })
  const execute = requireTool(registry, TOOL_EXECUTE_NAME)

  await requireTool(registry, TOOL_SEARCH_NAME).execute({ query: 'send email' })
  await assert.rejects(
    execute.execute({ tool_name: sendEmail.description.name, params: { recipient: 'a@example.com' } }),
    /earlier model step/,
  )
  registry.finishToolCallBatch()

  await assert.rejects(
    execute.execute({ tool_name: sendEmail.description.name, params: {} }),
    /invalid parameters.*required property 'recipient'/i,
  )
  await assert.rejects(
    execute.execute({ tool_name: sendEmail.description.name, params: { recipient: 42 } }),
    /invalid parameters.*must be string/i,
  )
  await assert.rejects(
    execute.execute({
      tool_name: sendEmail.description.name,
      params: { recipient: 'a@example.com', unknown: true },
    }),
    /invalid parameters.*additional properties/i,
  )
  assert.equal(calls, 0)

  assert.equal(
    await execute.execute({
      tool_name: sendEmail.description.name,
      params: { recipient: 'a@example.com', retries: 1 },
    }),
    JSON.stringify({ recipient: 'a@example.com', retries: 1 }),
  )
  assert.equal(calls, 1)
})

test('reports an invalid target contract without dispatching the tool', async () => {
  let calls = 0
  const broken = tool('mcp__broken__tool', 'Broken contract.', {
    type: 'not-a-json-schema-type',
  }, async () => {
    calls += 1
    return 'should not execute'
  })
  const registry = new ToolRegistry({ tools: [], searchableTools: [broken] })

  await requireTool(registry, TOOL_SEARCH_NAME).execute({ query: 'broken' })
  registry.finishToolCallBatch()
  await assert.rejects(
    requireTool(registry, TOOL_EXECUTE_NAME).execute({
      tool_name: broken.description.name,
      params: {},
    }),
    /invalid parameter contract/i,
  )
  assert.equal(calls, 0)
})

test('restores current and legacy search discoveries without exposing target schemas', async () => {
  const sendEmail = tool('mcp__mail__send_email', 'Send an email message.')
  const registry = new ToolRegistry({ tools: [], searchableTools: [sendEmail] })
  const messages: Message[] = [
    {
      role: 'assistant',
      toolCalls: [{ id: 'search-1', name: 'ToolSearchBM25', arguments: { query: 'email' } }],
    },
    {
      role: 'tool',
      toolCallId: 'search-1',
      content: JSON.stringify({ query: 'email', matches: ['mcp__mail__send_email'] }),
    },
  ]

  registry.restore(messages)

  assert.deepEqual(registry.descriptions().map(description => description.name), [
    TOOL_SEARCH_NAME,
    TOOL_EXECUTE_NAME,
  ])
  assert.equal(registry.get(sendEmail.description.name), undefined)
  assert.equal(await requireTool(registry, TOOL_EXECUTE_NAME).execute({
    tool_name: sendEmail.description.name,
    params: {},
  }), 'mcp__mail__send_email completed')
})

test('validates facade arguments and reserved-name collisions', async () => {
  const registry = new ToolRegistry({
    tools: [],
    searchableTools: [tool('mcp__mail__send_email', 'Send an email message.')],
  })
  const search = requireTool(registry, TOOL_SEARCH_NAME)

  await assert.rejects(search.execute({ query: '' }), /query must be a non-empty string/)
  const execute = requireTool(registry, TOOL_EXECUTE_NAME)
  await assert.rejects(execute.execute({ tool_name: '', params: {} }), /tool_name must be a non-empty string/)
  await assert.rejects(execute.execute({ tool_name: 'missing', params: {} }), /unknown deferred tool/)
  assert.throws(
    () => new ToolRegistry({
      tools: [tool(TOOL_SEARCH_NAME, 'Conflicting user tool.')],
      searchableTools: [tool('deferred', 'Deferred tool.')],
    }),
    /Duplicate tool name: ToolSearch/,
  )
  assert.throws(
    () => new ToolRegistry({
      tools: [tool(TOOL_EXECUTE_NAME, 'Conflicting user tool.')],
      searchableTools: [tool('deferred', 'Deferred tool.')],
    }),
    /Duplicate tool name: ExecuteTool/,
  )
})

test('reports the deferred tool effect through ExecuteTool', () => {
  const observe = tool('mcp__docs__read', 'Read a document.')
  const execute = { ...tool('mcp__docs__delete', 'Delete a document.'), effect: 'execute' as const }
  const registry = new ToolRegistry({ tools: [], searchableTools: [observe, execute] })

  assert.equal(registry.effectForCall({
    name: TOOL_EXECUTE_NAME,
    arguments: { tool_name: observe.description.name, params: {} },
  }), 'observe')
  assert.equal(registry.effectForCall({
    name: TOOL_EXECUTE_NAME,
    arguments: { tool_name: execute.description.name, params: {} },
  }), 'execute')
  assert.equal(registry.effectForCall({ name: TOOL_EXECUTE_NAME, arguments: {} }), 'execute')
})

function tool(
  name: string,
  description: string,
  parameters: Record<string, unknown> = { type: 'object' },
  execute: Tool['execute'] = async () => `${name} completed`,
): Tool {
  return {
    effect: 'observe',
    description: { name, description, parameters },
    execute,
  }
}

function requireTool(registry: ToolRegistry, name: string): Tool {
  const result = registry.get(name)
  assert.ok(result)
  return result
}
