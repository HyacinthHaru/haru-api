import { existsSync } from 'node:fs'
import { ALL_SYNC_TASKS, loadConfig, type SyncTaskName } from './config.js'
import { closeContext, createContext } from './context.js'
import { createLogger } from './logger.js'
import { SyncRunner } from './sync/index.js'

if (existsSync('.env')) process.loadEnvFile('.env')

const [command, ...args] = process.argv.slice(2)
if (command !== 'sync') {
  console.error(`usage: cli sync [${ALL_SYNC_TASKS.join('|')}]...`)
  process.exit(1)
}

const config = loadConfig()
const tasks = (args.length ? args : config.enabledTasks) as SyncTaskName[]
const unknown = tasks.filter((t) => !ALL_SYNC_TASKS.includes(t))
if (unknown.length) {
  console.error(`unknown task: ${unknown.join(', ')}`)
  process.exit(1)
}

const ctx = await createContext(config, createLogger(config.logLevel))
const runner = new SyncRunner(ctx)
let failed = false
for (const task of tasks) {
  try {
    await runner.run(task)
  } catch {
    failed = true
  }
}
await closeContext(ctx)
process.exit(failed ? 1 : 0)
