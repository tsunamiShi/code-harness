import type { AgentProject, FilesystemAccessMode } from '../projects/project.ts'
import type { Tool } from '../runtime/types.ts'
import { createBashTool } from './bash-tool.ts'
import { createLspTool } from './lsp-tool.ts'
import { createFilesystemTools } from './filesystem-tools.ts'

/** Composes the Code Agent Tool set for the selected filesystem access mode. */
export function createCodeTools(
  project: AgentProject,
  accessMode: FilesystemAccessMode = 'scoped',
): readonly Tool[] {
  return [
    ...createFilesystemTools(project, accessMode),
    createLspTool(project, accessMode),
    ...(accessMode === 'full' ? [createBashTool(project, accessMode)] : []),
  ]
}
