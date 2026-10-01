import type { SyncTaskName } from '../config.js'
import type { AppContext } from '../context.js'
import { syncAuthlibInjector } from './authlib-injector.js'
import { syncFabric } from './fabric.js'
import { syncForge } from './forge.js'
import { syncJava } from './java.js'
import { syncLiteLoader } from './liteloader.js'
import { syncMojang } from './mojang.js'
import { syncNeoForge } from './neoforge.js'
import { syncOptiFine } from './optifine.js'
import type { SyncFn, SyncStats } from './types.js'

export const SYNC_TASKS: Record<SyncTaskName, SyncFn> = {
  mojang: syncMojang,
  java: syncJava,
  forge: syncForge,
  neoforge: syncNeoForge,
  optifine: syncOptiFine,
  liteloader: syncLiteLoader,
  fabric: syncFabric,
  'authlib-injector': syncAuthlibInjector,
}

export class AlreadyRunningError extends Error {
  override name = 'AlreadyRunningError'
}

/** Runs sync tasks (one instance of each at a time) and records their outcome in `sync_state`. */
export class SyncRunner {
  private readonly running = new Set<SyncTaskName>()
  private readonly timers: NodeJS.Timeout[] = []

  constructor(private readonly ctx: AppContext) {}

  isRunning(name: SyncTaskName): boolean {
    return this.running.has(name)
  }

  async run(name: SyncTaskName): Promise<SyncStats> {
    if (this.running.has(name)) throw new AlreadyRunningError(`${name} is already running`)
    this.running.add(name)
    const { db } = this.ctx
    const log = this.ctx.log.child({ task: name })
    const started = new Date()
    log.info('sync started')
    await db.syncState.updateOne({ _id: name }, { $set: { status: 'running', lastStartedAt: started } }, { upsert: true })
    try {
      const stats = await SYNC_TASKS[name](this.ctx, log)
      const finished = new Date()
      const lastDurationMs = finished.getTime() - started.getTime()
      await db.syncState.updateOne(
        { _id: name },
        { $set: { status: 'success', lastFinishedAt: finished, lastSuccessAt: finished, lastDurationMs, lastError: null, stats } },
      )
      log.info({ stats, ms: lastDurationMs }, 'sync finished')
      return stats
    } catch (err) {
      const finished = new Date()
      await db.syncState.updateOne(
        { _id: name },
        {
          $set: {
            status: 'failed',
            lastFinishedAt: finished,
            lastDurationMs: finished.getTime() - started.getTime(),
            lastError: err instanceof Error ? err.message : String(err),
          },
        },
      )
      log.error({ err }, 'sync failed')
      throw err
    } finally {
      this.running.delete(name)
    }
  }

  /** Schedules every enabled task at its interval (and immediately if SYNC_ON_START). */
  start(): void {
    const { config } = this.ctx
    for (const name of config.enabledTasks) {
      const tick = () => void this.run(name).catch(() => undefined)
      if (config.syncOnStart) tick()
      this.timers.push(setInterval(tick, config.syncIntervals[name] * 60_000))
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers.length = 0
  }
}
