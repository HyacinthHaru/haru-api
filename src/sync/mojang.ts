import { docKey, sha1Hex } from '../db/documents.js'
import type { MojangVersionEntry } from '../db/models.js'
import { header, type BufferedResponse } from '../http/client.js'
import { mapLimit } from '../http/limiter.js'
import { toUpstreamUrl, urlPath } from '../upstream.js'
import { UpstreamFormatError, type SyncFn } from './types.js'

export const MOJANG_NS = 'mojang'
export const MANIFEST_V1_PATH = '/mc/game/version_manifest.json'
export const MANIFEST_V2_PATH = '/mc/game/version_manifest_v2.json'

export interface ManifestVersion {
  id: string
  type: string
  url: string
  time: string
  releaseTime: string
  sha1: string
  complianceLevel?: number
}

export interface VersionManifest {
  latest: { release: string; snapshot: string }
  versions: ManifestVersion[]
}

export function storedDoc(res: BufferedResponse, contentType = 'application/json; charset=utf-8') {
  return {
    body: res.body,
    contentType,
    upstreamUrl: res.url,
    etag: header(res.headers, 'etag'),
    lastModified: header(res.headers, 'last-modified'),
  }
}

/**
 * Mojang launcher metadata:
 *  - /mc/game/version_manifest.json and version_manifest_v2.json
 *  - every version JSON (verified against the sha1 in the manifest)
 *  - every asset index referenced by a version JSON (verified against its sha1)
 */
export const syncMojang: SyncFn = async (ctx, log) => {
  const { http, docs, db, config } = ctx
  const up = config.upstreams
  const stats = { versions: 0, fetchedVersions: 0, removedVersions: 0, assetIndexes: 0, fetchedAssetIndexes: 0, errors: 0 }

  const [v1, v2] = await Promise.all([
    http.fetch(`${up.pistonMeta}${MANIFEST_V1_PATH}`),
    http.fetch(`${up.pistonMeta}${MANIFEST_V2_PATH}`),
  ])
  const manifest = JSON.parse(v2.body.toString('utf8')) as VersionManifest
  const manifestV1 = JSON.parse(v1.body.toString('utf8')) as VersionManifest
  if (!Array.isArray(manifest.versions) || manifest.versions.length === 0 || !Array.isArray(manifestV1.versions)) {
    throw new UpstreamFormatError('version manifest has no versions')
  }
  await docs.put(MOJANG_NS, MANIFEST_V1_PATH, storedDoc(v1), null)
  await docs.put(MOJANG_NS, MANIFEST_V2_PATH, storedDoc(v2), null)
  stats.versions = manifest.versions.length

  const known = new Map(
    (await db.mojangVersions.find({}, { projection: { sha1: 1, docKey: 1 } }).toArray()).map((d) => [d._id, d]),
  )
  const now = new Date()

  await mapLimit(manifest.versions, config.http.concurrency, async (v, order) => {
    try {
      const path = urlPath(v.url)
      const key = docKey(MOJANG_NS, path)
      const base = {
        type: v.type,
        url: v.url,
        time: v.time,
        releaseTime: v.releaseTime,
        sha1: v.sha1,
        complianceLevel: v.complianceLevel,
        order,
        docKey: key,
        updatedAt: now,
      }
      const prev = known.get(v.id)
      if (prev && prev.sha1 === v.sha1 && prev.docKey === key && (await docs.exists(MOJANG_NS, path))) {
        await db.mojangVersions.updateOne({ _id: v.id }, { $set: base })
        return
      }
      const res = await http.fetch(toUpstreamUrl(v.url, up))
      if (v.sha1 && sha1Hex(res.body) !== v.sha1) {
        throw new UpstreamFormatError(`sha1 mismatch for ${v.id}: expected ${v.sha1}, got ${sha1Hex(res.body)}`)
      }
      const json = JSON.parse(res.body.toString('utf8')) as Pick<MojangVersionEntry, 'assetIndex' | 'downloads' | 'javaVersion'>
      await docs.put(MOJANG_NS, path, storedDoc(res), null)
      const entry: MojangVersionEntry = {
        _id: v.id,
        ...base,
        assetIndex: json.assetIndex,
        downloads: json.downloads,
        javaVersion: json.javaVersion,
      }
      await db.mojangVersions.replaceOne({ _id: v.id }, entry, { upsert: true })
      stats.fetchedVersions++
    } catch (err) {
      stats.errors++
      log.warn({ err, version: v.id }, 'failed to sync version json')
    }
  })

  const ids = manifest.versions.map((v) => v.id)
  stats.removedVersions = (await db.mojangVersions.deleteMany({ _id: { $nin: ids } })).deletedCount

  // Asset indexes referenced by any version JSON.
  const indexes = new Map<string, { sha1: string; url: string }>()
  for await (const v of db.mojangVersions.find({ assetIndex: { $exists: true } }, { projection: { assetIndex: 1 } })) {
    if (v.assetIndex?.url) indexes.set(urlPath(v.assetIndex.url), { sha1: v.assetIndex.sha1, url: v.assetIndex.url })
  }
  stats.assetIndexes = indexes.size
  await mapLimit([...indexes], config.http.concurrency, async ([path, idx]) => {
    try {
      const existing = await docs.get(MOJANG_NS, path)
      if (existing && (!idx.sha1 || existing.sha1 === idx.sha1)) return
      const res = await http.fetch(toUpstreamUrl(idx.url, up))
      if (idx.sha1 && sha1Hex(res.body) !== idx.sha1) {
        throw new UpstreamFormatError(`sha1 mismatch for asset index ${path}`)
      }
      JSON.parse(res.body.toString('utf8'))
      await docs.put(MOJANG_NS, path, storedDoc(res), null)
      stats.fetchedAssetIndexes++
    } catch (err) {
      stats.errors++
      log.warn({ err, path }, 'failed to sync asset index')
    }
  })

  return stats
}
