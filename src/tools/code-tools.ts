import type { AgentProject, FilesystemAccessMode } from '../projects/project.ts'
import type { Tool } from '../runtime/types.ts'
import { createBashTool } from './bash-tool.ts'
import { createLspTool } from './lsp-tool.ts'
import { createFilesystemTools } from './filesystem-tools.ts'
import { createWebFetchTool } from './web-fetch-tool.ts'
import { createWebSearchTool } from './web-search-tool.ts'

export interface CodeToolOptions {
  /** Exposes the default-on WebFetch Tool unless the current process opted out. */
  webFetch?: boolean
  /** Exposes the WebSearch Tool when a search API key is configured. */
  webSearch?: { apiKey: string; endpoint?: string; model?: string }
}

/** Composes the Code Agent Tool set for the selected filesystem access mode. */
export function createCodeTools(
  project: AgentProject,
  accessMode: FilesystemAccessMode = 'scoped',
  options: CodeToolOptions = {},
): readonly Tool[] {
  return [
    ...createFilesystemTools(project, accessMode),
    createLspTool(project, accessMode),
    ...(options.webFetch === true ? [createWebFetchTool()] : []),
    ...(options.webSearch === undefined
      ? []
      : [createWebSearchTool({
          apiKey: options.webSearch.apiKey,
          ...(options.webSearch.endpoint === undefined ? {} : { endpoint: options.webSearch.endpoint }),
          ...(options.webSearch.model === undefined ? {} : { model: options.webSearch.model }),
        })]),
    ...(accessMode === 'full' ? [createBashTool(project, accessMode)] : []),
  ]
}
