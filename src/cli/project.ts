import { mysqlOptionsFromEnvironment } from './config.ts'
import { primaryRoot, ProjectCatalog } from '../projects/project.ts'
import { MysqlAgentStore } from '../storage/mysql-agent-store.ts'
import { readProjectCommand } from './project-arguments.ts'

const store = await MysqlAgentStore.connect(mysqlOptionsFromEnvironment())
const catalog = new ProjectCatalog(store)

try {
  const command = readProjectCommand(process.argv.slice(2))
  if (command.kind === 'create') {
    const project = await catalog.create(command)
    printProject(project)
  } else if (command.kind === 'list') {
    const projects = await catalog.list()
    if (projects.length === 0) {
      console.log('No projects.')
    } else {
      for (const project of projects) {
        console.log(`${project.id}\t${project.name}\t${primaryRoot(project).path}`)
      }
    }
  } else if (command.kind === 'show') {
    printProject(await catalog.get(command.projectId))
  } else {
    printProject(await catalog.attach(command.projectId, command.path))
  }
} finally {
  await store.close()
}

function printProject(project: Awaited<ReturnType<ProjectCatalog['get']>>): void {
  console.log(`Project: ${project.name}`)
  console.log(`ID: ${project.id}`)
  for (const root of project.roots) console.log(`${root.role}: ${root.path}`)
}
