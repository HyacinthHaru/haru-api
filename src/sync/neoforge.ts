import { ObjectId, type AnyBulkWriteOperation } from 'mongodb'
import type { NeoForgeEntry } from '../db/models.js'
import { neoforgeArtifactPath, parseNeoForgeVersion, type NeoForgeArtifact } from '../parsers/neoforge.js'
import { storedDoc } from './mojang.js'
import { UpstreamFormatError, type SyncFn } from './types.js'

/** Documents fetched from maven.neoforged.net, keyed by their path there (served under /neoforge/meta). */
export const NEOFORGE_NS = 'neoforge-meta'

/** net.neoforged:forge (1.20.1 only) first, then net.neoforged:neoforge */
const ARTIFACTS: NeoForgeArtifact[] = ['forge', 'neoforge']

/**
 * NeoForge, from the Reposilite API of maven.neoforged.net:
 *  - /api/maven/versions/releases/net/neoforged/{forge,neoforge} (version lists)
 *  - /api/maven/details/releases/net/neoforged/{forge,neoforge} (directory listings, mirrored for clients)
 */
export const syncNeoForge: SyncFn = async (ctx) => {
  const { http, docs, db, config } = ctx
  const stats = { versions: 0, added: 0, removed: 0, skipped: 0 }
  const now = new Date()
  const seen: string[] = []

  for (const [i, artifact] of ARTIFACTS.entries()) {
    const versionsPath = `/api/maven/versions/releases/net/neoforged/${artifact}`
    const detailsPath = `/api/maven/details/releases/net/neoforged/${artifact}`
    const res = await http.fetch(`${config.upstreams.neoforgeMaven}${versionsPath}`)
    const details = await http.fetch(`${config.upstreams.neoforgeMaven}${detailsPath}`)
    const versions = (JSON.parse(res.body.toString('utf8')) as { versions?: unknown }).versions
    if (!Array.isArray(versions)) throw new UpstreamFormatError(`unexpected response from ${versionsPath}`)
    await docs.put(NEOFORGE_NS, versionsPath, storedDoc(res), null)
    await docs.put(NEOFORGE_NS, detailsPath, storedDoc(details), null)

    const ops: AnyBulkWriteOperation<NeoForgeEntry>[] = []
    for (const [order, raw] of versions.entries()) {
      const parsed = typeof raw === 'string' ? parseNeoForgeVersion(artifact, raw) : null
      if (!parsed) {
        stats.skipped++
        continue
      }
      seen.push(parsed.rawVersion)
      ops.push({
        updateOne: {
          filter: { rawVersion: parsed.rawVersion },
          update: {
            $set: {
              version: parsed.version,
              mcversion: parsed.mcversion,
              artifact,
              installerPath: `/maven/${neoforgeArtifactPath(artifact, parsed.rawVersion, 'installer', 'jar')}`,
              order: i * 1_000_000 + order,
              updatedAt: now,
            },
            $setOnInsert: { _id: new ObjectId(), __v: 0, createdAt: now },
          },
          upsert: true,
        },
      })
    }
    if (ops.length) stats.added += (await db.neoforge.bulkWrite(ops, { ordered: false })).upsertedCount
  }

  stats.versions = seen.length
  stats.removed = (await db.neoforge.deleteMany({ rawVersion: { $nin: seen } })).deletedCount
  return stats
}
