import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppContext } from '../../context.js'
import type { ForgeBuildEntry } from '../../db/models.js'
import { forgeArtifactPath, preferredForgeFile } from '../../parsers/forge.js'
import { compareVersions } from '../../parsers/version.js'
import { notFound, type FileMirror } from '../mirror.js'

export function toForgeJson(b: ForgeBuildEntry) {
  return {
    _id: b._id.toHexString(),
    __v: b.__v,
    build: b.build,
    branch: b.branch,
    files: b.files,
    mcversion: b.mcversion,
    modified: b.modified ? b.modified.toISOString() : null,
    version: b.version,
  }
}

export function forgeRoutes(app: FastifyInstance, ctx: AppContext, files: FileMirror): void {
  const { db, config } = ctx

  const serveArtifact = (req: FastifyRequest, reply: FastifyReply, longVersion: string, category: string, format: string) => {
    const path = forgeArtifactPath(longVersion, category, format)
    return files.serve(req, reply, {
      key: `maven/${path}`,
      urls: [`${config.upstreams.forgeMaven}/${path}`],
      filename: path.slice(path.lastIndexOf('/') + 1),
    })
  }

  // Minecraft versions that have Forge builds
  app.get('/forge/minecraft', async () => {
    const versions = (await db.forgeBuilds.distinct('mcversion')) as string[]
    return versions.sort(compareVersions)
  })

  // Forge builds for a Minecraft version
  app.get<{ Params: { version: string } }>('/forge/minecraft/:version', async (req) => {
    const builds = await db.forgeBuilds.find({ mcversion: req.params.version }).sort({ build: 1 }).toArray()
    return builds.map(toForgeJson)
  })

  // Forge builds, newest first, paginated
  app.get<{ Params: { offset: string; limit: string } }>('/forge/list/:offset/:limit', async (req, reply) => {
    const offset = Number(req.params.offset)
    const limit = Number(req.params.limit)
    if (!Number.isInteger(offset) || !Number.isInteger(limit) || offset < 0 || limit < 0) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'offset and limit must be non-negative integers' })
    }
    const builds = await db.forgeBuilds.find().sort({ build: -1 }).skip(offset).limit(Math.min(limit, 1000)).toArray()
    return builds.map(toForgeJson)
  })

  // the most recently released build
  app.get('/forge/last', async (_req, reply) => {
    const b = await db.forgeBuilds.find().sort({ modified: -1, build: -1 }).limit(1).next()
    return b ? toForgeJson(b) : notFound(reply)
  })

  // promotions (<mc>-latest / <mc>-recommended) with the build they point at
  app.get('/forge/promos', async () => {
    const promos = await db.forgePromos.find().toArray()
    if (promos.length === 0) return []
    const builds = await db.forgeBuilds
      .find({ $or: promos.map((p) => ({ mcversion: p.mcversion, version: p.version })) })
      .toArray()
    const byKey = new Map(builds.map((b) => [`${b.mcversion}\u0000${b.version}`, b]))
    return promos
      .sort((a, b) => compareVersions(a.mcversion, b.mcversion) || a._id.localeCompare(b._id))
      .map((p) => {
        const build = byKey.get(`${p.mcversion}\u0000${p.version}`)
        return { name: p._id, build: build ? toForgeJson(build) : null }
      })
  })

  // download by build number (installer, or universal/client for very old builds)
  app.get<{ Params: { build: string } }>('/forge/download/:build', async (req, reply) => {
    const b = await db.forgeBuilds.findOne({ build: Number(req.params.build) })
    const file = b && preferredForgeFile(b.files)
    if (!b || !file) return notFound(reply)
    return serveArtifact(req, reply, b.longVersion, file.category, file.format)
  })

  // download by version: ?mcversion=1.20.1&version=47.2.0[&branch=][&category=installer][&format=jar]
  app.get<{ Querystring: { mcversion?: string; version?: string; branch?: string; category?: string; format?: string } }>(
    '/forge/download',
    async (req, reply) => {
      const { mcversion, version, branch, category = 'installer', format = 'jar' } = req.query
      if (!mcversion || !version) {
        return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'mcversion and version are required' })
      }
      const longVersion = `${mcversion}-${version}${branch ? `-${branch}` : ''}`
      return serveArtifact(req, reply, longVersion, category, format)
    },
  )
}
