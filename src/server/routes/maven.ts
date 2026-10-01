import type { FastifyInstance } from 'fastify'
import type { Upstreams } from '../../config.js'
import type { AppContext } from '../../context.js'
import { LITELOADER_NS, LITELOADER_VERSIONS_PATH } from '../../sync/liteloader.js'
import { notFound, restPath, type FileMirror, type MetaMirror } from '../mirror.js'
import { optifineTarget } from './optifine.js'

/** Repositories merged under /maven, picked by group path. */
export function mavenRepos(path: string, up: Upstreams): string[] {
  const forge = up.forgeMaven
  const neoforge = `${up.neoforgeMaven}/releases`
  const fabric = up.fabricMaven
  if (path.startsWith('net/minecraftforge/')) return [forge]
  if (path.startsWith('net/neoforged/')) return [neoforge]
  if (path.startsWith('net/fabricmc/')) return [fabric]
  if (path.startsWith('com/mumfrey/')) return [`${up.liteloader}/versions`]
  return [up.libraries, forge, neoforge, fabric]
}

export function mavenRoutes(app: FastifyInstance, ctx: AppContext, meta: MetaMirror, files: FileMirror): void {
  const up = ctx.config.upstreams

  app.get('/maven/*', async (req, reply) => {
    const p = restPath(req, '/maven')
    if (!p) return notFound(reply)
    const { path, raw } = p

    // LiteLoader's version index lives at dl.liteloader.com/versions/versions.json
    if (path === 'com/mumfrey/liteloader/versions.json') {
      return meta.serve(req, reply, LITELOADER_NS, LITELOADER_VERSIONS_PATH, [`${up.liteloader}${LITELOADER_VERSIONS_PATH}`])
    }

    // com/optifine/<mc>/OptiFine_<mc>_<type>_<patch>.jar (previews: com/optifine/preview_<mc>/...)
    const of = /^com\/optifine\/(preview_)?[^/]+\/([^/]+\.jar)$/.exec(path)
    if (of) {
      const e = await ctx.db.optifine.findOne({ filename: `${of[1] ?? ''}${of[2]}` })
      return e ? files.serve(req, reply, optifineTarget(ctx, e)) : notFound(reply)
    }

    const urls = mavenRepos(path, up).map((repo) => `${repo}/${raw}`)
    if (/\/maven-metadata\.xml(\.[a-z0-9]+)?$/.test(path)) return meta.serve(req, reply, 'maven', `/${path}`, urls)
    return files.serve(req, reply, { key: `maven/${path}`, urls })
  })
}
