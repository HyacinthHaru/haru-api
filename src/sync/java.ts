import { sha1Hex } from '../db/documents.js'
import { mapLimit } from '../http/limiter.js'
import { toUpstreamUrl, urlPath } from '../upstream.js'
import { MOJANG_NS, storedDoc } from './mojang.js'
import { UpstreamFormatError, type SyncFn } from './types.js'

/** The Java runtime index used by the official launcher (same path on BMCLAPI). */
export const JAVA_ALL_PATH = '/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json'

interface RuntimeEntry {
  manifest?: { sha1: string; size: number; url: string }
}

/** Mojang Java runtimes: all.json plus every runtime manifest.json it references. */
export const syncJava: SyncFn = async (ctx, log) => {
  const { http, docs, config } = ctx
  const stats = { manifests: 0, fetchedManifests: 0, errors: 0 }

  const res = await http.fetch(`${config.upstreams.pistonMeta}${JAVA_ALL_PATH}`)
  const all = JSON.parse(res.body.toString('utf8')) as Record<string, Record<string, RuntimeEntry[]>>
  if (!all || typeof all !== 'object' || Object.keys(all).length === 0) throw new UpstreamFormatError('empty java runtime index')
  await docs.put(MOJANG_NS, JAVA_ALL_PATH, storedDoc(res), null)

  const manifests = new Map<string, { sha1: string; url: string }>()
  for (const platform of Object.values(all)) {
    for (const entries of Object.values(platform ?? {})) {
      for (const e of entries ?? []) {
        if (e.manifest?.url) manifests.set(urlPath(e.manifest.url), e.manifest)
      }
    }
  }
  stats.manifests = manifests.size

  await mapLimit([...manifests], config.http.concurrency, async ([path, m]) => {
    try {
      if ((await docs.get(MOJANG_NS, path))?.sha1 === m.sha1) return
      const r = await http.fetch(toUpstreamUrl(m.url, config.upstreams))
      if (sha1Hex(r.body) !== m.sha1) throw new UpstreamFormatError(`sha1 mismatch for ${path}`)
      await docs.put(MOJANG_NS, path, storedDoc(r), null)
      stats.fetchedManifests++
    } catch (err) {
      stats.errors++
      log.warn({ err, path }, 'failed to sync java runtime manifest')
    }
  })

  return stats
}
