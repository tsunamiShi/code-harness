import type { AgentProject, WorkspaceAccessMode } from '../projects/project.ts'
import type { Tool } from '../runtime/types.ts'
import { createBashTool } from './bash-tool.ts'
import { createLspTool } from './lsp-tool.ts'
import { createWorkspaceTools } from './workspace-tools.ts'

/** Composes the Code Agent Tool set for the selected filesystem access mode. */
export function createCodeTools(
  project: AgentProject,
  accessMode: WorkspaceAccessMode = 'scoped',
): readonly Tool[] {
  return [
    ...createWorkspaceTools(project, accessMode),
    createLspTool(project, accessMode),
    ...(accessMode === 'full' ? [createBashTool(project, accessMode)] : []),
  ]
}
