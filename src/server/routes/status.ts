import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { ALL_SYNC_TASKS, type SyncTaskName } from '../../config.js'
import type { AppContext } from '../../context.js'
import type { SyncRunner } from '../../sync/index.js'

function tokenMatches(header: string | undefined, token: string): boolean {
  const a = Buffer.from(header ?? '')
  const b = Buffer.from(`Bearer ${token}`)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function statusRoutes(app: FastifyInstance, ctx: AppContext, runner: SyncRunner): void {
  const { db, config } = ctx

  app.get('/_haru/status', async () => {
    const states = new Map((await db.syncState.find().toArray()).map((s) => [s._id, s]))
    const [mojang, forge, neoforge, optifine, liteloader, documents, files] = await Promise.all([
      db.mojangVersions.estimatedDocumentCount(),
      db.forgeBuilds.estimatedDocumentCount(),
      db.neoforge.estimatedDocumentCount(),
      db.optifine.estimatedDocumentCount(),
      db.liteloader.estimatedDocumentCount(),
      db.documents.estimatedDocumentCount(),
      ctx.files.count(),
    ])
    return {
      tasks: ALL_SYNC_TASKS.map((name) => {
        const { _id, ...state } = states.get(name) ?? { _id: name }
        return {
          name: _id,
          enabled: config.enabledTasks.includes(name),
          intervalMinutes: config.syncIntervals[name],
          running: runner.isRunning(name),
          ...state,
        }
      }),
      counts: { mojang, forge, neoforge, optifine, liteloader, documents, files },
    }
  })

  // trigger a sync: POST /_haru/sync/forge with "Authorization: Bearer <ADMIN_TOKEN>"
  app.post<{ Params: { task: string } }>('/_haru/sync/:task', async (req, reply) => {
    if (!config.adminToken || !tokenMatches(req.headers.authorization, config.adminToken)) {
      return reply.code(401).send({ statusCode: 401, error: 'Unauthorized', message: 'invalid admin token' })
    }
    const task = req.params.task as SyncTaskName
    if (!ALL_SYNC_TASKS.includes(task)) return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'unknown task' })
    if (runner.isRunning(task)) return reply.code(409).send({ statusCode: 409, error: 'Conflict', message: 'already running' })
    void runner.run(task).catch(() => undefined)
    return reply.code(202).send({ task, status: 'started' })
  })
}
