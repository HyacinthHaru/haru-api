import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.js'
import { AUTHLIB_NS } from '../../sync/authlib-injector.js'
import { FABRIC_NS } from '../../sync/fabric.js'
import { notFound, queryString, restPath, type FileMirror, type MetaMirror } from '../mirror.js'

export function passthroughRoutes(app: FastifyInstance, ctx: AppContext, meta: MetaMirror, files: FileMirror): void {
  const up = ctx.config.upstreams

  // meta.fabricmc.net, e.g. /fabric-meta/v2/versions/loader/1.20.1/0.15.11/profile/json
  app.get('/fabric-meta/*', (req, reply) => {
    const p = restPath(req, '/fabric-meta')
    if (!p) return notFound(reply)
    const qs = queryString(req)
    return meta.serve(req, reply, FABRIC_NS, `/${p.path}${qs}`, [`${up.fabricMeta}/${p.raw}${qs}`])
  })

  // authlib-injector.yushi.moe: artifacts.json, artifact/latest.json, artifact/<n>.json, artifact/<n>/*.jar
  app.get('/mirrors/authlib-injector/*', (req, reply) => {
    const p = restPath(req, '/mirrors/authlib-injector')
    if (!p) return notFound(reply)
    const url = `${up.authlibInjector}/${p.raw}`
    if (p.path.endsWith('.jar')) return files.serve(req, reply, { key: `authlib-injector/${p.path}`, urls: [url] })
    return meta.serve(req, reply, AUTHLIB_NS, `/${p.path}`, [url])
  })
}
