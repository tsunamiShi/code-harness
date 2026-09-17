import { mysqlOptionsFromEnvironment } from './config.ts'
import { MysqlAgentStore } from './mysql-agent-store.ts'
import { primaryRoot, ProjectCatalog } from './project.ts'

const store = await MysqlAgentStore.connect(mysqlOptionsFromEnvironment())
const catalog = new ProjectCatalog(store)

try {
  const [command, ...arguments_] = process.argv.slice(2)
  if (command === 'create') {
    const input = readCreateArguments(arguments_)
    const project = await catalog.create(input)
    printProject(project)
  } else if (command === 'list') {
    const projects = await catalog.list()
    if (projects.length === 0) {
      console.log('No projects.')
    } else {
      for (const project of projects) {
        console.log(`${project.id}\t${project.name}\t${primaryRoot(project).path}`)
      }
    }
  } else if (command === 'show' && arguments_.length === 1 && arguments_[0]) {
    printProject(await catalog.get(arguments_[0]))
  } else {
    throw new Error(usage())
  }
} finally {
  await store.close()
}

function readCreateArguments(arguments_: readonly string[]): {
  name: string
  primaryPath: string
  additionalPaths: readonly string[]
} {
  let name: string | undefined
  let primaryPath: string | undefined
  const additionalPaths: string[] = []

  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index]
    const value = arguments_[index + 1]
    if (!value) throw new Error(usage())
    if (flag === '--name' && name === undefined) name = value
    else if (flag === '--primary' && primaryPath === undefined) primaryPath = value
    else if (flag === '--root') additionalPaths.push(value)
    else throw new Error(`Unknown or duplicate option: ${flag}\n${usage()}`)
  }

  if (!name || !primaryPath) throw new Error(usage())
  return { name, primaryPath, additionalPaths }
}

function printProject(project: Awaited<ReturnType<ProjectCatalog['get']>>): void {
  console.log(`Project: ${project.name}`)
  console.log(`ID: ${project.id}`)
  for (const root of project.roots) console.log(`${root.role}: ${root.path}`)
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm project create --name <name> --primary <path> [--root <path> ...]',
    '  pnpm project list',
    '  pnpm project show <project-id>',
  ].join('\n')
}
