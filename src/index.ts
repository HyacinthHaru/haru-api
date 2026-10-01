import { existsSync } from 'node:fs'
import { loadConfig } from './config.js'
import { closeContext, createContext } from './context.js'
import { createLogger } from './logger.js'
import { buildApp } from './server/app.js'
import { SyncRunner } from './sync/index.js'

if (existsSync('.env')) process.loadEnvFile('.env')

const config = loadConfig()
const log = createLogger(config.logLevel)
const ctx = await createContext(config, log)
const runner = new SyncRunner(ctx)
const app = buildApp(ctx, runner)

await app.listen({ host: config.host, port: config.port })
runner.start()

const shutdown = async () => {
  runner.stop()
  await app.close()
  await closeContext(ctx)
  process.exit(0)
}
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
