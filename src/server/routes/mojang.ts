import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppContext } from '../../context.js'
import { MOJANG_NS } from '../../sync/mojang.js'
import { toUpstreamUrl, urlPath } from '../../upstream.js'
import { notFound, restPath, type FileMirror, type MetaMirror } from '../mirror.js'

const ASSET_RE = /^[0-9a-f]{2}\/([0-9a-f]{40})$/

export function mojangRoutes(app: FastifyInstance, ctx: AppContext, meta: MetaMirror, files: FileMirror): void {
  const up = ctx.config.upstreams

  /** piston-meta paths (manifests, version JSONs, asset indexes, Java runtime manifests) or piston-data objects. */
  const serveMojang = (req: FastifyRequest, reply: FastifyReply, path: string) => {
    if (!path.startsWith('/v1/objects/')) return meta.serve(req, reply, MOJANG_NS, path, [`${up.pistonMeta}${path}`])
    return files.serve(req, reply, {
      key: path.slice(1),
      urls: [`${up.pistonData}${path}`, `${up.launcher}${path}`],
      sha1: /^\/v1\/objects\/([0-9a-f]{40})\//.exec(path)?.[1],
    })
  }

  const serveVersion = async (req: FastifyRequest, reply: FastifyReply, id: string, category: string) => {
    const v = await ctx.db.mojangVersions.findOne({ _id: id })
    if (!v) return notFound(reply)
    if (category === 'json') return serveMojang(req, reply, urlPath(v.url))
    const dl = v.downloads?.[category]
    if (!dl) return notFound(reply)
    return files.serve(req, reply, { key: urlPath(dl.url).slice(1), urls: [toUpstreamUrl(dl.url, up)], sha1: dl.sha1 })
  }

  app.get('/mc/*', (req, reply) => {
    const p = restPath(req, '/mc')
    return p ? serveMojang(req, reply, `/mc/${p.path}`) : notFound(reply)
  })

  app.get('/v1/*', (req, reply) => {
    const p = restPath(req, '/v1')
    return p ? serveMojang(req, reply, `/v1/${p.path}`) : notFound(reply)
  })

  // category: json | client | server | client_mappings | server_mappings
  app.get<{ Params: { version: string; category: string } }>('/version/:version/:category', (req, reply) =>
    serveVersion(req, reply, req.params.version, req.params.category),
  )

  // old S3 layout: /versions/<id>/<id>.json, /versions/<id>/<id>.jar, /versions/<id>/minecraft_server.<id>.jar
  app.get<{ Params: { version: string; file: string } }>('/versions/:version/:file', (req, reply) => {
    const { version, file } = req.params
    const category =
      file === `${version}.json` ? 'json' : file === `${version}.jar` ? 'client' : file === `minecraft_server.${version}.jar` ? 'server' : null
    return category ? serveVersion(req, reply, version, category) : notFound(reply)
  })

  app.get('/assets/*', (req, reply) => {
    const p = restPath(req, '/assets')
    const sha1 = p && ASSET_RE.exec(p.path)?.[1]
    if (!p || !sha1) return notFound(reply)
    return files.serve(req, reply, { key: `assets/${p.path}`, urls: [`${up.resources}/${p.path}`], sha1 })
  })

  app.get('/libraries/*', (req, reply) => {
    const p = restPath(req, '/libraries')
    if (!p) return notFound(reply)
    return files.serve(req, reply, { key: `libraries/${p.path}`, urls: [`${up.libraries}/${p.raw}`] })
  })
}
