import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'
import { neoforgeArtifactPath } from '../../parsers/neoforge.js'
import { NEOFORGE_NS } from '../../sync/neoforge.js'
import { notFound, queryString, restPath, type FileMirror, type MetaMirror } from '../mirror.js'

export function neoforgeRoutes(app: FastifyInstance, ctx: AppContext, meta: MetaMirror, files: FileMirror): void {
  const { db, config } = ctx

  // NeoForge versions for a Minecraft version
  app.get<{ Params: { mcversion: string } }>('/neoforge/list/:mcversion', async (req) => {
    const list = await db.neoforge.find({ mcversion: req.params.mcversion }).sort({ order: 1 }).toArray()
    return list.map((v) => ({
      _id: v._id.toHexString(),
      __v: v.__v,
      rawVersion: v.rawVersion,
      version: v.version,
      mcversion: v.mcversion,
      installerPath: v.installerPath,
    }))
  })

  // /neoforge/version/20.4.237/download/installer.jar (version may be the raw or the normalized one)
  app.get<{ Params: { version: string; file: string } }>('/neoforge/version/:version/download/:file', async (req, reply) => {
    const { version, file } = req.params
    const dot = file.lastIndexOf('.')
    if (dot <= 0) return notFound(reply)
    const v = await db.neoforge.findOne({ $or: [{ rawVersion: version }, { version }] })
    if (!v) return notFound(reply)
    const path = neoforgeArtifactPath(v.artifact, v.rawVersion, file.slice(0, dot), file.slice(dot + 1))
    return files.serve(req, reply, {
      key: `maven/${path}`,
      urls: [`${config.upstreams.neoforgeMaven}/releases/${path}`],
      filename: path.slice(path.lastIndexOf('/') + 1),
    })
  })

  // maven.neoforged.net pass-through, e.g. /neoforge/meta/api/maven/details/releases/net/neoforged/neoforge
  app.get('/neoforge/meta/*', (req, reply) => {
    const p = restPath(req, '/neoforge/meta')
    if (!p) return notFound(reply)
    const qs = queryString(req)
    return meta.serve(req, reply, NEOFORGE_NS, `/${p.path}${qs}`, [`${config.upstreams.neoforgeMaven}/${p.raw}${qs}`])
  })
}
