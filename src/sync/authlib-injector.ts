import { mapLimit } from '../http/limiter.js'
import { storedDoc } from './mojang.js'
import { UpstreamFormatError, type SyncFn } from './types.js'

/** Documents of authlib-injector.yushi.moe (served under /mirrors/authlib-injector). */
export const AUTHLIB_NS = 'authlib-injector'

/** authlib-injector: artifacts.json, artifact/latest.json and artifact/<build>.json. */
export const syncAuthlibInjector: SyncFn = async (ctx, log) => {
  const { http, docs, config } = ctx
  const base = config.upstreams.authlibInjector
  const stats = { artifacts: 0, fetched: 0, errors: 0 }

  const index = await http.fetch(`${base}/artifacts.json`)
  const artifacts = (JSON.parse(index.body.toString('utf8')) as { artifacts?: { build_number: number }[] }).artifacts
  if (!Array.isArray(artifacts)) throw new UpstreamFormatError('unexpected authlib-injector artifacts.json')
  await docs.put(AUTHLIB_NS, '/artifacts.json', storedDoc(index), null)
  await docs.put(AUTHLIB_NS, '/artifact/latest.json', storedDoc(await http.fetch(`${base}/artifact/latest.json`)), null)
  stats.artifacts = artifacts.length

  await mapLimit(artifacts, config.http.concurrency, async ({ build_number }) => {
    const path = `/artifact/${build_number}.json`
    try {
      if (await docs.exists(AUTHLIB_NS, path)) return
      await docs.put(AUTHLIB_NS, path, storedDoc(await http.fetch(`${base}${path}`)), null)
      stats.fetched++
    } catch (err) {
      stats.errors++
      log.warn({ err, path }, 'failed to sync authlib-injector artifact')
    }
  })
  return stats
}
