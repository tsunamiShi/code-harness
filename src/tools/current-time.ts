import type { Tool } from '../types.ts'

export const currentTimeTool: Tool = {
  description: {
    name: 'get_current_time',
    description: 'Return the current date and time in an IANA time zone.',
    parameters: {
      type: 'object',
      properties: {
        timeZone: {
          type: 'string',
          description: 'An IANA time zone such as Asia/Shanghai.',
        },
      },
      required: ['timeZone'],
      additionalProperties: false,
    },
  },
  async execute(arguments_) {
    const timeZone = readTimeZone(arguments_)
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'full',
        timeStyle: 'long',
        timeZone,
      }).format(new Date())
    } catch (error: unknown) {
      throw new Error(`Invalid IANA time zone: ${timeZone}`, { cause: error })
    }
  },
}

function readTimeZone(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('get_current_time arguments must be an object')
  }
  const timeZone = Reflect.get(value, 'timeZone')
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new Error('get_current_time requires a non-empty timeZone')
  }
  return timeZone
}
