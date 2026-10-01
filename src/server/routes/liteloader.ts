import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'
import type { LiteLoaderEntry } from '../../db/models.js'
import { liteloaderJarPaths } from '../../parsers/liteloader.js'
import { compareVersions } from '../../parsers/version.js'
import { notFound, type FileMirror } from '../mirror.js'

function toLiteLoaderJson(e: LiteLoaderEntry) {
  return {
    _id: e._id.toHexString(),
    __v: e.__v,
    mcversion: e.mcversion,
    build: e.build,
    hash: e.hash,
    type: e.type,
    version: e.version,
  }
}

export function liteloaderRoutes(app: FastifyInstance, ctx: AppContext, files: FileMirror): void {
  const { db, config } = ctx

  // all versions, or the newest one for ?mcversion=
  app.get<{ Querystring: { mcversion?: string } }>('/liteloader/list', async (req, reply) => {
    const { mcversion } = req.query
    if (mcversion) {
      const e = await db.liteloader.find({ mcversion }).sort({ timestamp: -1 }).limit(1).next()
      return e ? toLiteLoaderJson(e) : notFound(reply)
    }
    const all = await db.liteloader.find().toArray()
    return all.sort((a, b) => compareVersions(a.mcversion, b.mcversion) || a.timestamp - b.timestamp).map(toLiteLoaderJson)
  })

  // ?version=1.12.2-SNAPSHOT
  app.get<{ Querystring: { version?: string } }>('/liteloader/download', async (req, reply) => {
    const { version } = req.query
    const e = version ? await db.liteloader.findOne({ version }) : null
    if (!e) return notFound(reply)
    const file = typeof e.build.file === 'string' ? e.build.file : `liteloader-${e.version}.jar`
    return files.serve(req, reply, {
      key: `maven/com/mumfrey/liteloader/${e.version}/${file}`,
      urls: liteloaderJarPaths(e).map((p) => `${config.upstreams.liteloader}${p}`),
      filename: file,
    })
  })
}
