import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'
import type { OptiFineEntry } from '../../db/models.js'
import { parseAdloadx } from '../../parsers/optifine.js'
import { notFound, type FileMirror, type FileTarget } from '../mirror.js'

function toOptiFineJson(e: OptiFineEntry) {
  return {
    _id: e._id.toHexString(),
    __v: e.__v,
    mcversion: e.mcversion,
    patch: e.patch,
    type: e.type,
    filename: e.filename,
    forge: e.forge,
  }
}

/** OptiFine jars are only reachable through a tokenised link on the adloadx page. */
export function optifineTarget(ctx: AppContext, e: OptiFineEntry): FileTarget {
  const base = ctx.config.upstreams.optifine
  return {
    key: `optifine/${e.filename}`,
    filename: e.filename,
    urls: async () => {
      const html = await ctx.http.getText(`${base}/adloadx?f=${encodeURIComponent(e.filename)}`, {
        headers: { accept: 'text/html' },
      })
      const link = parseAdloadx(html)
      if (!link) throw new Error(`no download link for ${e.filename}`)
      return [`${base}/${link}`]
    },
  }
}

export function optifineRoutes(app: FastifyInstance, ctx: AppContext, files: FileMirror): void {
  const { db } = ctx

  app.get('/optifine/versionList', async () => {
    return (await db.optifine.find().sort({ order: 1 }).toArray()).map(toOptiFineJson)
  })

  app.get<{ Params: { mcversion: string } }>('/optifine/:mcversion', async (req) => {
    return (await db.optifine.find({ mcversion: req.params.mcversion }).sort({ order: 1 }).toArray()).map(toOptiFineJson)
  })

  app.get<{ Params: { mcversion: string; type: string; patch: string } }>('/optifine/:mcversion/:type/:patch', async (req, reply) => {
    const { mcversion, type, patch } = req.params
    const e = await db.optifine.findOne({ mcversion, type, patch })
    return e ? files.serve(req, reply, optifineTarget(ctx, e)) : notFound(reply)
  })
}
