import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import type { SyncRunner } from '../sync/index.js'
import { FileMirror, MetaMirror } from './mirror.js'
import { forgeRoutes } from './routes/forge.js'
import { liteloaderRoutes } from './routes/liteloader.js'
import { mavenRoutes } from './routes/maven.js'
import { mojangRoutes } from './routes/mojang.js'
import { neoforgeRoutes } from './routes/neoforge.js'
import { optifineRoutes } from './routes/optifine.js'
import { passthroughRoutes } from './routes/passthrough.js'
import { statusRoutes } from './routes/status.js'

export function buildApp(ctx: AppContext, runner: SyncRunner): FastifyInstance {
  const app = Fastify({ loggerInstance: ctx.log as FastifyBaseLogger, trustProxy: true, routerOptions: { maxParamLength: 1000 } })
  const meta = new MetaMirror(ctx)
  const files = new FileMirror(ctx)

  mojangRoutes(app, ctx, meta, files)
  mavenRoutes(app, ctx, meta, files)
  forgeRoutes(app, ctx, files)
  neoforgeRoutes(app, ctx, meta, files)
  optifineRoutes(app, ctx, files)
  liteloaderRoutes(app, ctx, files)
  passthroughRoutes(app, ctx, meta, files)
  statusRoutes(app, ctx, runner)

  return app
}
