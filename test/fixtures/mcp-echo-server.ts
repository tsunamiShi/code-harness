import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

serveStdio(() => {
  const server = new McpServer({ name: 'ai-agent-test-server', version: '1.0.0' })

  server.registerTool(
    'echo',
    {
      description: 'Echo text with the configured prefix',
      inputSchema: fromJsonSchema<{ text: string }>({
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({
      content: [{ type: 'text', text: `${process.env.MCP_TEST_PREFIX ?? 'missing'}:${text}` }],
    }),
  )

  server.registerTool(
    'inspect',
    {
      description: 'Return text and structured content',
      inputSchema: fromJsonSchema<Record<string, never>>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
    },
    async () => ({
      content: [{ type: 'text', text: 'structured' }],
      structuredContent: { ok: true },
    }),
  )

  server.registerTool(
    'fail',
    {
      description: 'Return an MCP tool-level error',
      inputSchema: fromJsonSchema<Record<string, never>>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
    },
    async () => ({
      content: [{ type: 'text', text: 'requested failure' }],
      isError: true,
    }),
  )

  return server
})
