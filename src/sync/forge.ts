import { ObjectId } from 'mongodb'
import type { ForgeBuildEntry, ForgeFile } from '../db/models.js'
import { header } from '../http/client.js'
import { mapLimit } from '../http/limiter.js'
import {
  forgeArtifactPath,
  forgeFilesFromMeta,
  parseForgeLongVersion,
  parsePromoKey,
  preferredForgeFile,
  type ParsedForgeVersion,
} from '../parsers/forge.js'
import { compareVersions } from '../parsers/version.js'
import { storedDoc } from './mojang.js'
import { UpstreamFormatError, type SyncFn } from './types.js'

export const FORGE_NS = 'forge'
export const FORGE_BASE = '/net/minecraftforge/forge'

interface FetchedBuild {
  longVersion: string
  parsed: ParsedForgeVersion
  files: ForgeFile[]
  modified: Date
  build?: number
}

/**
 * Forge, from files.minecraftforge.net:
 *  - maven-metadata.json (minecraft version -> forge versions)
 *  - promotions_slim.json (latest / recommended)
 *  - <version>/meta.json for every new version (classifiers + md5), release time from the
 *    Last-Modified of the main artifact on maven.minecraftforge.net
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

  const fetched = await mapLimit(
    all.filter((v) => !known.has(v.lv)),
    config.http.concurrency,
    async ({ mc, lv }): Promise<FetchedBuild | null> => {
      const parsed = parseForgeLongVersion(lv, mc)
      if (!parsed) {
        stats.errors++
        log.warn({ version: lv }, 'unparsable forge version')
        return null
      }
      try {
        const meta = await http.fetch(`${up.forgeFiles}${FORGE_BASE}/${lv}/meta.json`, { accept: [404] })
        const files = meta.status === 200 ? forgeFilesFromMeta(JSON.parse(meta.body.toString('utf8'))) : []
        const main = preferredForgeFile(files)
        let lastModified: string | undefined
        if (main) {
          const head = await http.head(`${up.forgeMaven}/${forgeArtifactPath(lv, main.category, main.format)}`, { accept: [404] })
          lastModified = head.status === 200 ? header(head.headers, 'last-modified') : undefined
          lastModified ??= header(meta.headers, 'last-modified')
        }
        // clients parse `modified` as a date, so fall back to the time the build was first seen
        return { longVersion: lv, parsed, files, modified: lastModified ? new Date(lastModified) : new Date() }
      } catch (err) {
        stats.errors++
        log.warn({ err, version: lv }, 'failed to fetch forge version meta')
        return null
      }
    },
  )
  const added = fetched.filter((b): b is FetchedBuild => b !== null)

  // Legacy (4-component) versions keep their Jenkins build number; newer versions, which have
  // none, continue the sequence in release order so that /forge/download/:build stays unique.
  const used = new Set<number>(await db.forgeBuilds.distinct('build'))
  let maxBuild = Math.max(0, ...used)
  for (const b of added) {
    if (b.parsed.legacy && !used.has(b.parsed.lastComponent)) {
      b.build = b.parsed.lastComponent
      used.add(b.build)
      maxBuild = Math.max(maxBuild, b.build)
    }
  }
  for (const b of added
    .filter((x) => x.build === undefined)
    .sort((a, b) => a.modified.getTime() - b.modified.getTime() || compareVersions(a.longVersion, b.longVersion))) {
    b.build = ++maxBuild
  }

  if (added.length) {
    const now = new Date()
    await db.forgeBuilds.insertMany(
      added.map(
        (b): ForgeBuildEntry => ({
          _id: new ObjectId(),
          __v: 0,
          build: b.build as number,
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
