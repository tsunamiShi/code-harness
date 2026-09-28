#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arguments_ = process.argv.slice(2)

const helpTopic = readHelpTopic(arguments_)
if (helpTopic !== undefined) {
  const help = helpText(helpTopic)
  if (help === undefined) {
    console.error(`Unknown help topic: ${helpTopic.join(' ')}`)
    console.error('Run `ai-agent help` to list available commands.')
    process.exit(1)
  }
  console.log(help)
  process.exit(0)
}

if (arguments_.includes('--version')) {
  const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
  console.log(packageJson.version)
  process.exit(0)
}

const envPath = resolve(packageRoot, '.env')
if (existsSync(envPath)) loadEnvFile(envPath)

const command = arguments_[0] === 'project' ? 'project' : 'chat'
const commandArguments = arguments_[0] === 'project' || arguments_[0] === 'chat'
  ? arguments_.slice(1)
  : arguments_
const entrypoint = resolve(packageRoot, 'src', 'cli', `${command}.ts`)

await import('tsx/esm')
process.argv = [process.execPath, entrypoint, ...commandArguments]
await import(pathToFileURL(entrypoint).href)

function readHelpTopic(arguments_) {
  if (arguments_[0] === 'help') return arguments_.slice(1)
  const helpIndex = arguments_.indexOf('--help')
  return helpIndex === -1 ? undefined : arguments_.slice(0, helpIndex)
}

function helpText(topic) {
  const key = topic.join(' ')
  if (key === '') return rootHelp()
  if (key === 'chat') return chatHelp()
  if (key === 'project') return projectHelp()
  if (key === 'project create') return projectCreateHelp()
  if (key === 'project list') return projectListHelp()
  if (key === 'project show') return projectShowHelp()
  if (key === 'project attach') return projectAttachHelp()
  if (key === 'help') return helpCommandHelp()
  return undefined
}

function rootHelp() {
  return [
    'AI Agent CLI',
    '',
    'Usage:',
    '  ai-agent [chat options]',
    '  ai-agent chat [options]',
    '  ai-agent project <command>',
    '  ai-agent help [command]',
    '  ai-agent --version',
    '',
    'Commands:',
    '  chat               Start a conversation. This is the default command.',
    '  project create     Create a persistent Project.',
    '  project list       List Projects.',
    '  project show       Show one Project and its roots.',
    '  project attach     Attach another root to a Project.',
    '  help               Show all commands or detailed help for one command.',
    '',
    'Chat options:',
    '  --project <id>     Start a new Session for an existing Project.',
    '  --session <id>     Resume an existing Session.',
    '  --full-access      Allow filesystem access outside Project roots and enable Bash.',
    '  --mcp-config <path>  Connect MCP servers from the selected configuration.',
    '  --web-fetch        Enable WebFetch for exact http(s) URLs (default: enabled).',
    '  --no-web-fetch     Disable WebFetch for this process.',
    '  --no-web-search    Disable WebSearch for this process.',
    '',
    'Interactive commands:',
    '  /resume            Select another Session from the current Project.',
    '  /retry             Continue the current failed or interrupted Turn.',
    '  /compact           Create a Context Checkpoint from completed work.',
    '  /help              Show interactive commands.',
    '  /exit              Exit the CLI.',
    '',
    'Run `ai-agent help <command>` for details, for example `ai-agent help project create`.',
  ].join('\n')
}

function chatHelp() {
  return [
    'Usage:',
    '  ai-agent [chat] [--project <project-id> | --session <session-id>] [--full-access] [--mcp-config <path>] [--no-web-fetch] [--no-web-search]',
    '',
    'Starts an interactive conversation.',
    'Without --project or --session, the current directory becomes the Project primary root.',
    'The first launch creates that Project; later launches from the same canonical path reuse it.',
    '',
    'Options:',
    '  --project <id>       Start a new Session for an existing Project.',
    '  --session <id>       Resume an existing Session.',
    '  --full-access        Allow access outside Project roots and enable Bash.',
    '  --mcp-config <path>  Connect MCP servers from this configuration.',
    '  --web-fetch          Enable WebFetch for exact http(s) URLs (default: enabled).',
    '  --no-web-fetch       Disable WebFetch for this process.',
    '  --no-web-search      Disable WebSearch for this process.',
    '',
    'Interactive commands:',
    '  /resume              Select another Session from the current Project.',
    '  /retry               Continue the current failed or interrupted Turn.',
    '  /compact             Create a Context Checkpoint from completed work.',
    '  /help                Show interactive commands.',
    '  /exit                Exit the CLI.',
  ].join('\n')
}

function projectHelp() {
  return [
    'Usage:',
    '  ai-agent project <command>',
    '',
    'Commands:',
    '  create  Create a Project with one primary root and optional attached roots.',
    '  list    List Project IDs, names, and primary roots.',
    '  show    Show one Project and all of its roots.',
    '  attach  Attach another directory to an existing Project.',
    '',
    'Run `ai-agent help project <command>` for command-specific arguments.',
  ].join('\n')
}

function projectCreateHelp() {
  return [
    'Usage:',
    '  ai-agent project create --name <name> --primary <path> [--root <path> ...]',
    '',
    'Options:',
    '  --name <name>      Project display name.',
    '  --primary <path>   Primary working directory.',
    '  --root <path>      Additional attached root; may be repeated.',
  ].join('\n')
}

function projectListHelp() {
  return [
    'Usage:',
    '  ai-agent project list',
    '',
    'Lists every persistent Project as ID, name, and primary root.',
  ].join('\n')
}

function projectShowHelp() {
  return [
    'Usage:',
    '  ai-agent project show <project-id>',
    '',
    'Shows the selected Project and all primary or attached roots.',
  ].join('\n')
}

function projectAttachHelp() {
  return [
    'Usage:',
    '  ai-agent project attach <project-id> --path <directory>',
    '',
    'Attaches one canonical directory to an existing Project.',
  ].join('\n')
}

function helpCommandHelp() {
  return [
    'Usage:',
    '  ai-agent help [chat | project [create | list | show | attach]]',
    '',
    'Shows the complete command index or detailed help for one command.',
  ].join('\n')
}
