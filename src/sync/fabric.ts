import { storedDoc } from './mojang.js'
import type { SyncFn } from './types.js'

/** Documents of meta.fabricmc.net, keyed by their path there (served under /fabric-meta). */
export const FABRIC_NS = 'fabric-meta'

export const FABRIC_LISTS = [
  '/v2/versions',
  '/v2/versions/game',
  '/v2/versions/game/yarn',
  '/v2/versions/game/intermediary',
  '/v2/versions/intermediary',
  '/v2/versions/yarn',
  '/v2/versions/loader',
  '/v2/versions/installer',
]

/**
 * Fabric version lists from meta.fabricmc.net. Per-version endpoints
 * (/v2/versions/loader/:game/:loader/profile/json, ...) are fetched on demand by /fabric-meta.
 */
export const syncFabric: SyncFn = async (ctx) => {
  const { http, docs, config } = ctx
  for (const path of FABRIC_LISTS) {
    const res = await http.fetch(`${config.upstreams.fabricMeta}${path}`)
    JSON.parse(res.body.toString('utf8'))
    await docs.put(FABRIC_NS, path, storedDoc(res), null)
  }
  return { documents: FABRIC_LISTS.length }
}
