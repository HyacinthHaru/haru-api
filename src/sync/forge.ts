import { ObjectId } from 'mongodb'
import type { ForgeBuildEntry, ForgeFile } from '../db/models.js'
import { mapLimit } from '../http/limiter.js'
import { parseForgeIndex, parseForgeLongVersion, parsePromoKey, type ForgeIndexEntry, type ParsedForgeVersion } from '../parsers/forge.js'
import { storedDoc } from './mojang.js'
import { UpstreamFormatError, type SyncFn } from './types.js'

export const FORGE_NS = 'forge'
export const FORGE_BASE = '/net/minecraftforge/forge'

interface FetchedBuild {
  longVersion: string
  parsed: ParsedForgeVersion
  files: ForgeFile[]
  modified: Date
  build: number
}

/**
 * Forge, from files.minecraftforge.net:
 *  - maven-metadata.json (minecraft version -> forge versions)
 *  - promotions_slim.json (latest / recommended)
 *  - index_<mc>.html of every minecraft version with new versions (release time, files and their sha1)
 */
export const syncForge: SyncFn = async (ctx, log) => {
  const { http, docs, db, config } = ctx
  const up = config.upstreams
  const stats = { versions: 0, added: 0, removed: 0, promos: 0, errors: 0 }

  const mmRes = await http.fetch(`${up.forgeFiles}${FORGE_BASE}/maven-metadata.json`)
  const promoRes = await http.fetch(`${up.forgeFiles}${FORGE_BASE}/promotions_slim.json`)
  const mm = JSON.parse(mmRes.body.toString('utf8')) as Record<string, string[]>
  const promos = (JSON.parse(promoRes.body.toString('utf8')) as { promos?: Record<string, string> }).promos ?? {}
  if (!mm || typeof mm !== 'object' || !Object.values(mm).some(Array.isArray)) {
    throw new UpstreamFormatError('unexpected forge maven-metadata.json')
  }
  await docs.put(FORGE_NS, `${FORGE_BASE}/maven-metadata.json`, storedDoc(mmRes), null)
  await docs.put(FORGE_NS, `${FORGE_BASE}/promotions_slim.json`, storedDoc(promoRes), null)

  const all = Object.entries(mm).flatMap(([mc, list]) => (Array.isArray(list) ? list : []).map((lv) => ({ mc, lv })))
  stats.versions = all.length
  const known = new Set(await db.forgeBuilds.distinct('longVersion'))
  const pending = all.filter((v) => !known.has(v.lv))

  const pages = new Map<string, Map<string, ForgeIndexEntry>>()
  await mapLimit([...new Set(pending.map((v) => v.mc))], config.http.concurrency, async (mc) => {
    try {
      pages.set(mc, parseForgeIndex(await http.getText(`${up.forgeFiles}${FORGE_BASE}/index_${mc}.html`)))
    } catch (err) {
      stats.errors++
      log.warn({ err, mcversion: mc }, 'failed to fetch forge index page')
    }
  })

  const added: FetchedBuild[] = []
  for (const { mc, lv } of pending) {
    const parsed = parseForgeLongVersion(lv, mc)
    if (!parsed) {
      stats.errors++
      log.warn({ version: lv }, 'unparsable forge version')
      continue
    }
    const page = pages.get(mc)
    if (!page) continue
    const entry = page.get(lv)
    if (!entry) {
      stats.errors++
      log.warn({ version: lv }, 'forge version missing from its index page')
      continue
    }
    // Legacy (4-component) versions keep their Jenkins build number; newer versions, which have
    // none, are numbered the way BMCLAPI does: 47.2.0 -> 47020000.
    const [major = 0, minor = 0, patch = 0] = parsed.version.split('.').map(Number)
    const build = parsed.legacy ? parsed.lastComponent : major * 1_000_000 + minor * 10_000 + patch
    added.push({ longVersion: lv, parsed, files: entry.files, modified: entry.modified, build })
  }

  if (added.length) {
    const now = new Date()
    await db.forgeBuilds.insertMany(
      added.map(
        (b): ForgeBuildEntry => ({
          _id: new ObjectId(),
          __v: 0,
          build: b.build,
          mcversion: b.parsed.mcversion,
          version: b.parsed.version,
          branch: b.parsed.branch,
          modified: b.modified,
          files: b.files,
          longVersion: b.longVersion,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    )
  }
  stats.added = added.length
  stats.removed = (await db.forgeBuilds.deleteMany({ longVersion: { $nin: all.map((v) => v.lv) } })).deletedCount

  const now = new Date()
  const names: string[] = []
  for (const [name, version] of Object.entries(promos)) {
    const promo = parsePromoKey(name)
    if (!promo || typeof version !== 'string') continue
    names.push(name)
    await db.forgePromos.replaceOne({ _id: name }, { mcversion: promo.mcversion, version, updatedAt: now }, { upsert: true })
  }
  await db.forgePromos.deleteMany({ _id: { $nin: names } })
  stats.promos = names.length

  return stats
}
