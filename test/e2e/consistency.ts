/**
 * End-to-end consistency check of haru-api against the real world.
 *
 * Everything haru-api serves is requested in-process (Fastify inject, so routes and serialization are
 * covered) and compared with
 *   - the official upstreams: haru must be a faithful and complete copy of them;
 *   - BMCLAPI (bmclapi2.bangbang93.com): haru should serve the same data in the same shapes.
 *
 * Needs network access and a MongoDB that has been synced (or pass --sync):
 *   MONGODB_URI=mongodb://127.0.0.1:27017/haru-e2e npm run e2e -- --sync
 *
 * Options:
 *   --sync              run the sync tasks of the selected areas first
 *   --only=a,b          areas: mojang, java, forge, neoforge, optifine, liteloader, fabric,
 *                       authlib-injector, files, endpoints (default: all)
 *   --no-bmclapi        skip the comparisons with BMCLAPI
 *   --bmclapi=<origin>  default https://bmclapi2.bangbang93.com
 *   --report=<file>     JSON report (default <tmpdir>/haru-e2e-report.json)
 *
 * BMCLAPI is a free community service: its requests are sequential, spaced and rate-limit aware.
 * Exit code 1 if any check failed.
 */
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { ALL_SYNC_TASKS, loadConfig, type SyncTaskName } from '../../src/config.js'
import { closeContext, createContext } from '../../src/context.js'
import { sha1Hex } from '../../src/db/documents.js'
import { header, type BufferedResponse, type HttpClient } from '../../src/http/client.js'
import { createLogger } from '../../src/logger.js'
import { buildApp } from '../../src/server/app.js'
import { SyncRunner } from '../../src/sync/index.js'
import { FABRIC_LISTS } from '../../src/sync/fabric.js'
import { JAVA_ALL_PATH } from '../../src/sync/java.js'

// ---------------------------------------------------------------- options

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const option = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

const AREAS = ['mojang', 'java', 'forge', 'neoforge', 'optifine', 'liteloader', 'fabric', 'authlib-injector', 'files', 'endpoints'] as const
type Area = (typeof AREAS)[number]
const areas = new Set((option('only')?.split(',').map((s) => s.trim()) ?? [...AREAS]) as Area[])
for (const a of areas) if (!AREAS.includes(a)) throw new Error(`unknown area: ${a}`)
const withBmclapi = !flag('no-bmclapi')
const BMCLAPI = (option('bmclapi') ?? 'https://bmclapi2.bangbang93.com').replace(/\/+$/, '')
const REPORT = option('report') ?? join(tmpdir(), 'haru-e2e-report.json')

if (existsSync('.env')) process.loadEnvFile('.env')
const config = loadConfig()
const ctx = await createContext(config, createLogger(process.env.LOG_LEVEL || 'warn'))
const runner = new SyncRunner(ctx)
const app = buildApp(ctx, runner)
const up = config.upstreams

// ---------------------------------------------------------------- results

type Status = 'pass' | 'warn' | 'fail'
/** official: compared with the upstream (or hashes it publishes); bmclapi: with BMCLAPI; docs: BMCLAPI's documentation */
type Against = 'official' | 'bmclapi' | 'docs'
interface Outcome {
  status: Status
  summary: string
  details?: unknown
}
interface Result extends Outcome {
  area: Area
  against: Against
  name: string
}

const results: Result[] = []
const pass = (summary: string, details?: unknown): Outcome => ({ status: 'pass', summary, details })
const warn = (summary: string, details?: unknown): Outcome => ({ status: 'warn', summary, details })
const fail = (summary: string, details?: unknown): Outcome => ({ status: 'fail', summary, details })

async function check(area: Area, against: Against, name: string, fn: () => Promise<Outcome>): Promise<void> {
  if (!areas.has(area) || (against === 'bmclapi' && !withBmclapi)) return
  let outcome: Outcome
  try {
    outcome = await fn()
  } catch (err) {
    outcome = fail(`check threw: ${err instanceof Error ? err.message : String(err)}`)
  }
  results.push({ area, against, name, ...outcome })
  console.log(`[${outcome.status.toUpperCase()}] ${area} <-> ${against} | ${name} — ${outcome.summary}`)
}

// ---------------------------------------------------------------- clients

interface Served {
  status: number
  headers: Record<string, unknown>
  body: Buffer
  json<T>(): T
}

/** A request to haru-api, in-process. */
async function haru(url: string, method: 'GET' | 'HEAD' = 'GET'): Promise<Served> {
  const res = await app.inject({ method, url })
  return { status: res.statusCode, headers: res.headers, body: res.rawPayload, json: <T>() => JSON.parse(res.body) as T }
}

function official(url: string): Promise<BufferedResponse> {
  return ctx.http.fetch(url, { accept: [404] })
}

async function officialJson<T>(url: string): Promise<T> {
  const res = await official(url)
  if (res.status !== 200) throw new Error(`${url} -> HTTP ${res.status}`)
  return JSON.parse(res.body.toString('utf8')) as T
}

/** Sequential, spaced, rate-limit aware client for BMCLAPI. */
class Bmclapi {
  requests = 0
  readonly limits: Record<string, string> = {}
  private queue: Promise<unknown> = Promise.resolve()
  private next = 0

  constructor(
    private readonly origin: string,
    private readonly http: HttpClient,
    private readonly gapMs = 1200,
  ) {}

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.next - Date.now()
      if (wait > 0) await sleep(wait)
      this.next = Date.now() + this.gapMs
      this.requests++
      return fn()
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  async get(path: string): Promise<BufferedResponse> {
    for (let attempt = 0; ; attempt++) {
      let res: BufferedResponse
      try {
        res = await this.enqueue(() => this.http.fetch(`${this.origin}${path}`, { accept: [404, 429] }))
      } catch (err) {
        // file responses redirect to OpenBMCLAPI nodes, some of which are flaky: a new request picks another node
        if (attempt >= 3) throw err
        this.next = Date.now() + 3000 * (attempt + 1)
        continue
      }
      for (const k of ['x-ratelimit-limit-short', 'x-ratelimit-remaining-short', 'x-ratelimit-reset-short', 'x-ratelimit-limit-long', 'x-ratelimit-remaining-long']) {
        const v = header(res.headers, k)
        if (v !== undefined) this.limits[k] = v
      }
      if (res.status === 429 && attempt < 6) {
        const seconds = Number(header(res.headers, 'retry-after') ?? header(res.headers, 'x-ratelimit-reset-short') ?? 60)
        const wait = Math.min(Math.max(Number.isFinite(seconds) ? seconds : 60, 5), 300)
        console.log(`  … BMCLAPI answered 429, waiting ${wait}s`)
        this.next = Date.now() + wait * 1000
        continue
      }
      return res
    }
  }

  async json<T>(path: string): Promise<T> {
    const res = await this.get(path)
    if (res.status !== 200) throw new Error(`BMCLAPI ${path} -> HTTP ${res.status}`)
    return JSON.parse(res.body.toString('utf8')) as T
  }

  /** Follows the redirect chain of a download with HEAD requests; returns the first x-bmclapi-hash seen. */
  async downloadHash(path: string): Promise<{ hash: string | undefined; chain: string[] }> {
    const chain: string[] = []
    let url = `${this.origin}${path}`
    for (let hop = 0; hop < 5; hop++) {
      const res = await this.enqueue(() =>
        fetch(url, { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': config.http.userAgent } }),
      )
      chain.push(`${res.status} ${url}`)
      const hash = res.headers.get('x-bmclapi-hash')
      if (hash) return { hash, chain }
      const location = res.headers.get('location')
      if (!location || res.status < 300 || res.status >= 400) break
      url = new URL(location, url).toString()
    }
    return { hash: undefined, chain }
  }
}

const bmclapi = new Bmclapi(BMCLAPI, ctx.http)

// ---------------------------------------------------------------- helpers

function setDiff<T>(a: Iterable<T>, b: Iterable<T>): { onlyA: T[]; onlyB: T[]; both: T[] } {
  const A = new Set(a)
  const B = new Set(b)
  return { onlyA: [...A].filter((x) => !B.has(x)), onlyB: [...B].filter((x) => !A.has(x)), both: [...A].filter((x) => B.has(x)) }
}

const days = (a: string | null | undefined, b: string | Date) =>
  a ? Math.abs(Date.parse(a) - new Date(b).getTime()) / 86_400_000 : Number.POSITIVE_INFINITY

const md5Hex = (b: Buffer) => createHash('md5').update(b).digest('hex')
const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/**
 * Compares two JSON documents: equal, or one side containing everything of the other (one copy is
 * just older), or different.
 */
function compareJson(ours: Buffer, theirs: Buffer): { result: 'equal' | 'haru-older' | 'other-older' | 'different'; onlyHaru: number; onlyOther: number } {
  if (ours.equals(theirs)) return { result: 'equal', onlyHaru: 0, onlyOther: 0 }
  const a: unknown = JSON.parse(ours.toString('utf8'))
  const b: unknown = JSON.parse(theirs.toString('utf8'))
  if (isDeepStrictEqual(a, b)) return { result: 'equal', onlyHaru: 0, onlyOther: 0 }
  const flatten = (x: unknown, prefix = ''): string[] =>
    Array.isArray(x)
      ? x.map((e) => `${prefix}${JSON.stringify(e)}`)
      : x && typeof x === 'object'
        ? Object.entries(x).flatMap(([k, v]) => flatten(v, `${prefix}${k}:`))
        : [`${prefix}${JSON.stringify(x)}`]
  const { onlyA, onlyB } = setDiff(flatten(a), flatten(b))
  const result = onlyA.length === 0 ? 'haru-older' : onlyB.length === 0 ? 'other-older' : 'different'
  return { result, onlyHaru: onlyA.length, onlyOther: onlyB.length }
}

// ---------------------------------------------------------------- Mojang

interface ManifestVersion {
  id: string
  type: string
  url: string
  time: string
  releaseTime: string
  sha1?: string
}
interface Manifest {
  latest: { release: string; snapshot: string }
  versions: ManifestVersion[]
}

const versionSha1 = (v: ManifestVersion) => v.sha1 ?? new URL(v.url).pathname.split('/')[3] ?? ''

/** Differences between two manifests; those explained by one copy being older are "stale", not errors. */
function manifestOutcome(ours: Manifest, theirs: Manifest, other: string): Outcome {
  const o = new Map(ours.versions.map((v) => [v.id, v]))
  const t = new Map(theirs.versions.map((v) => [v.id, v]))
  const newest = (m: Manifest) => Math.max(...m.versions.map((v) => Date.parse(v.time)))
  const onlyTheirs = theirs.versions.filter((v) => !o.has(v.id))
  const onlyOurs = ours.versions.filter((v) => !t.has(v.id))
  const changed = theirs.versions.filter((v) => {
    const mine = o.get(v.id)
    return mine !== undefined && versionSha1(mine) !== versionSha1(v)
  })
  if (!onlyTheirs.length && !onlyOurs.length && !changed.length) {
    return pass(`same ${ours.versions.length} versions (bytes differ in formatting only)`)
  }
  const unexplained = [
    ...onlyTheirs.filter((v) => Date.parse(v.time) <= newest(ours)).map((v) => `only ${other}: ${v.id}`),
    ...onlyOurs.filter((v) => Date.parse(v.time) <= newest(theirs)).map((v) => `only haru: ${v.id}`),
    ...changed.filter((v) => Date.parse(v.time) === Date.parse(o.get(v.id)?.time ?? '')).map((v) => `sha1 differs at the same time: ${v.id}`),
  ]
  const details = {
    [`only_${other}`]: onlyTheirs.map((v) => v.id),
    only_haru: onlyOurs.map((v) => v.id),
    changed: changed.map((v) => v.id),
    latest: { haru: ours.latest, [other]: theirs.latest },
  }
  if (unexplained.length) return fail(`${unexplained.length} differences not explained by sync timing`, { unexplained, ...details })
  return warn(`timing only: ${onlyTheirs.length} only in ${other}, ${onlyOurs.length} only in haru, ${changed.length} updated`, details)
}

async function mojangChecks(): Promise<void> {
  for (const name of ['version_manifest.json', 'version_manifest_v2.json']) {
    await check('mojang', 'official', `/mc/game/${name} matches piston-meta`, async () => {
      const ours = await haru(`/mc/game/${name}`)
      if (ours.status !== 200) return fail(`haru answered HTTP ${ours.status}`)
      const theirs = await official(`${up.pistonMeta}/mc/game/${name}`)
      if (ours.body.equals(theirs.body)) return pass(`byte-identical (${theirs.body.length} B)`)
      return manifestOutcome(ours.json<Manifest>(), JSON.parse(theirs.body.toString('utf8')) as Manifest, 'official')
    })
  }

  const manifest = (await haru('/mc/game/version_manifest_v2.json')).json<Manifest>()
  const assetIndexes = new Map<string, string>()

  await check('mojang', 'official', 'every version JSON is served with the manifest sha1 and indexed consistently', async () => {
    const bad: unknown[] = []
    for (const v of manifest.versions) {
      const byId = await haru(`/version/${encodeURIComponent(v.id)}/json`)
      const sha1 = sha1Hex(byId.body)
      if (byId.status !== 200 || sha1 !== v.sha1) {
        bad.push({ id: v.id, status: byId.status, sha1, expected: v.sha1 })
        continue
      }
      if (byId.headers['x-bmclapi-hash'] !== v.sha1) bad.push({ id: v.id, problem: 'wrong x-bmclapi-hash' })
      const byPath = await haru(new URL(v.url).pathname)
      if (!byPath.body.equals(byId.body)) bad.push({ id: v.id, problem: `${new URL(v.url).pathname} differs (HTTP ${byPath.status})` })
      const json = byId.json<{ assetIndex?: { url: string; sha1: string }; downloads?: unknown }>()
      if (json.assetIndex) assetIndexes.set(new URL(json.assetIndex.url).pathname, json.assetIndex.sha1)
      const entry = await ctx.db.mojangVersions.findOne({ _id: v.id })
      if (!isDeepStrictEqual(entry?.downloads ?? undefined, json.downloads ?? undefined)) {
        bad.push({ id: v.id, problem: 'mojang_versions.downloads differs from the version JSON' })
      }
    }
    const n = manifest.versions.length
    return bad.length ? fail(`${bad.length} of ${n} versions wrong`, bad.slice(0, 30)) : pass(`${n}/${n} versions (by /version/:id/json and by /v1/packages path)`)
  })

  await check('mojang', 'official', 'every asset index is served with its sha1', async () => {
    const bad: unknown[] = []
    for (const [path, sha1] of assetIndexes) {
      const r = await haru(path)
      if (r.status !== 200 || sha1Hex(r.body) !== sha1) bad.push({ path, status: r.status })
    }
    return bad.length ? fail(`${bad.length} of ${assetIndexes.size} wrong`, bad) : pass(`${assetIndexes.size}/${assetIndexes.size} asset indexes`)
  })

  await check('mojang', 'bmclapi', 'version_manifest_v2.json matches BMCLAPI', async () => {
    const theirs = await bmclapi.get('/mc/game/version_manifest_v2.json')
    if (theirs.status !== 200) return fail(`BMCLAPI answered HTTP ${theirs.status}`)
    const ours = await haru('/mc/game/version_manifest_v2.json')
    if (ours.body.equals(theirs.body)) return pass(`byte-identical (${theirs.body.length} B)`)
    return manifestOutcome(ours.json<Manifest>(), JSON.parse(theirs.body.toString('utf8')) as Manifest, 'bmclapi')
  })

  await check('mojang', 'bmclapi', 'sampled version JSONs are byte-identical to BMCLAPI', async () => {
    const ids = [...new Set([manifest.latest.release, manifest.latest.snapshot, '1.20.1', '1.12.2', '1.8.9', '1.7.10', 'b1.7.3', 'rd-132211'])]
    const rows: { id: string; expected: string; bmclapi: string }[] = []
    for (const id of ids) {
      const v = manifest.versions.find((x) => x.id === id)
      if (!v?.sha1) continue
      const theirs = await bmclapi.get(`/version/${encodeURIComponent(id)}/json`)
      rows.push({ id, expected: v.sha1, bmclapi: theirs.status === 200 ? sha1Hex(theirs.body) : `HTTP ${theirs.status}` })
    }
    const bad = rows.filter((r) => r.bmclapi !== r.expected)
    return bad.length ? fail(`${bad.length} of ${rows.length} differ`, rows) : pass(`${rows.length} sampled versions`, rows)
  })
}

async function javaChecks(): Promise<void> {
  await check('java', 'official', 'Java runtime all.json matches piston-meta', async () => {
    const ours = await haru(JAVA_ALL_PATH)
    if (ours.status !== 200) return fail(`haru answered HTTP ${ours.status}`)
    const c = compareJson(ours.body, (await official(`${up.pistonMeta}${JAVA_ALL_PATH}`)).body)
    return c.result === 'equal' ? pass('equal') : warn(`not equal (${c.result}), possibly updated upstream since the sync`, c)
  })

  await check('java', 'official', 'every runtime manifest is served with its sha1', async () => {
    type Runtime = { manifest?: { url: string; sha1: string } }
    const all = (await haru(JAVA_ALL_PATH)).json<Record<string, Record<string, Runtime[]>>>()
    const manifests = new Map<string, string>()
    for (const platform of Object.values(all)) {
      for (const list of Object.values(platform)) for (const e of list) if (e.manifest) manifests.set(new URL(e.manifest.url).pathname, e.manifest.sha1)
    }
    const bad: unknown[] = []
    for (const [path, sha1] of manifests) {
      const r = await haru(path)
      if (r.status !== 200 || sha1Hex(r.body) !== sha1) bad.push({ path, status: r.status })
    }
    return bad.length ? fail(`${bad.length} of ${manifests.size} wrong`, bad) : pass(`${manifests.size}/${manifests.size} manifests`)
  })

  await check('java', 'bmclapi', 'all.json matches BMCLAPI', async () => {
    const theirs = await bmclapi.get(JAVA_ALL_PATH)
    if (theirs.status !== 200) return fail(`BMCLAPI answered HTTP ${theirs.status}`)
    const c = compareJson((await haru(JAVA_ALL_PATH)).body, theirs.body)
    return c.result === 'equal' ? pass('equal') : warn(`not equal (${c.result})`, c)
  })
}

// ---------------------------------------------------------------- Forge

interface ForgeFileJson {
  format: string
  category: string
  hash: string
}
interface ForgeJson {
  _id: string
  __v?: number
  build: number
  branch?: string | null
  files: ForgeFileJson[]
  mcversion: string
  modified: string | null
  version: string
}
interface PromoJson {
  _id?: string
  name: string
  build: ForgeJson | null
  __v?: number
}

/** The Forge maven version a build object stands for, e.g. "1.7.10-10.13.4.1614-1.7.10". */
const forgeKey = (b: Pick<ForgeJson, 'mcversion' | 'version' | 'branch'>) => `${b.mcversion}-${b.version}${b.branch ? `-${b.branch}` : ''}`
const isLegacyForge = (version: string) => version.split('.').length >= 4
/** BMCLAPI's build number for versions without a Jenkins build number, e.g. 47.2.0 -> 47020000. */
const bmclapiForgeBuild = (version: string) => {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((s) => Number.parseInt(s, 10))
  return major * 1_000_000 + minor * 10_000 + patch
}

/** Release time and files ("installer.jar:<sha1>") of a build on files.minecraftforge.net/net/minecraftforge/forge/index_<mc>.html. */
function forgePageEntry(html: string, longVersion: string): { time: Date; files: string[] } | undefined {
  const marker = `/forge/${longVersion}/forge-${longVersion}-`
  const row = html.split('<tr').find((r) => r.includes(marker) && r.includes('download-time'))
  const time = row && /class="download-time" title="([^"]+)"/.exec(row)?.[1]
  if (!row || !time) return undefined
  const files = new Set<string>()
  for (const li of row.split('<li').slice(1)) {
    const at = li.indexOf(marker)
    if (at >= 0) files.add(`${li.slice(at + marker.length, li.indexOf('"', at))}:${/SHA1:<\/strong>\s*([0-9a-f]{40})/.exec(li)?.[1] ?? ''}`)
  }
  return { time: new Date(`${time.replace(' ', 'T')}Z`), files: [...files].sort() }
}

async function forgeChecks(): Promise<void> {
  const mcs = (await haru('/forge/minecraft')).json<string[]>()
  const ours: ForgeJson[] = []
  for (const mc of mcs) ours.push(...(await haru(`/forge/minecraft/${encodeURIComponent(mc)}`)).json<ForgeJson[]>())
  const oursByKey = new Map(ours.map((b) => [forgeKey(b), b]))
  const mm = await officialJson<Record<string, string[]>>(`${up.forgeFiles}/net/minecraftforge/forge/maven-metadata.json`)

  await check('forge', 'official', 'builds match maven-metadata.json', async () => {
    const { onlyA, onlyB } = setDiff(Object.values(mm).flat(), oursByKey.keys())
    if (!onlyA.length && !onlyB.length) return pass(`same ${oursByKey.size} builds`)
    const details = { missingInHaru: onlyA.slice(0, 50), missingCount: onlyA.length, extraInHaru: onlyB.slice(0, 50), extraCount: onlyB.length }
    if (!onlyB.length && onlyA.length <= 3) return warn(`haru lacks ${onlyA.length} (possibly released after the sync)`, details)
    return fail(`haru lacks ${onlyA.length} and has ${onlyB.length} extra`, details)
  })

  await check('forge', 'official', '/forge/minecraft matches the Minecraft versions of maven-metadata.json', async () => {
    const { onlyA, onlyB } = setDiff(Object.keys(mm), mcs)
    return !onlyA.length && !onlyB.length ? pass(`same ${mcs.length} Minecraft versions`) : fail('different', { onlyOfficial: onlyA, onlyHaru: onlyB })
  })

  await check('forge', 'official', '/forge/list pages add up to /forge/minecraft/:mc', async () => {
    const listed: ForgeJson[] = []
    for (let offset = 0; ; offset += 1000) {
      const page = (await haru(`/forge/list/${offset}/1000`)).json<ForgeJson[]>()
      listed.push(...page)
      if (page.length < 1000) break
    }
    const { onlyA, onlyB } = setDiff(listed.map(forgeKey), oursByKey.keys())
    const duplicates = listed.length - new Set(listed.map((b) => b._id)).size
    return !onlyA.length && !onlyB.length && !duplicates ? pass(`${listed.length} builds`) : fail('different', { onlyList: onlyA, onlyMinecraft: onlyB, duplicates })
  })

  await check('forge', 'official', '/forge/promos matches promotions_slim.json', async () => {
    const promos = (await officialJson<{ promos: Record<string, string> }>(`${up.forgeFiles}/net/minecraftforge/forge/promotions_slim.json`)).promos
    const served = new Map((await haru('/forge/promos')).json<PromoJson[]>().map((p) => [p.name, p]))
    const bad: unknown[] = []
    for (const [name, version] of Object.entries(promos)) {
      const p = served.get(name)
      if (!p) bad.push({ name, problem: 'missing in haru' })
      else if (p.build?.version !== version) bad.push({ name, official: version, haru: p.build?.version ?? null })
    }
    for (const name of served.keys()) if (!(name in promos)) bad.push({ name, problem: 'extra in haru' })
    return bad.length ? fail(`${bad.length} differences`, bad) : pass(`same ${Object.keys(promos).length} promotions`)
  })

  const sample = [...new Set(['1.7.10', '1.12.2', '1.16.5', '1.20.1', mcs.at(-1) ?? '1.20.1'])].filter((mc) => mcs.includes(mc))
  await check('forge', 'official', `release time and files (sha1) match files.minecraftforge.net (${sample.join(', ')})`, async () => {
    const bad: unknown[] = []
    let n = 0
    for (const mc of sample) {
      const html = (await official(`${up.forgeFiles}/net/minecraftforge/forge/index_${mc}.html`)).body.toString('utf8')
      for (const b of ours.filter((x) => x.mcversion === mc)) {
        n++
        const page = forgePageEntry(html, forgeKey(b))
        const files = b.files.map((f) => `${f.category}.${f.format}:${f.hash}`).sort()
        if (!page) bad.push({ build: forgeKey(b), problem: 'not on the page' })
        else if (b.modified !== page.time.toISOString() || !isDeepStrictEqual(files, page.files)) {
          bad.push({ build: forgeKey(b), haru: { modified: b.modified, files }, official: { modified: page.time.toISOString(), files: page.files } })
        }
      }
    }
    return bad.length ? fail(`${bad.length} of ${n} builds differ`, bad.slice(0, 15)) : pass(`${n} builds`)
  })

  // ---- BMCLAPI
  const theirs: ForgeJson[] = []
  await check('forge', 'bmclapi', 'all builds match BMCLAPI (set / build / branch / files / modified)', async () => {
    const seen = new Set<string>()
    for (let offset = 0; offset < 50_000; offset += 500) {
      const page = await bmclapi.json<ForgeJson[]>(`/forge/list/${offset}/500`)
      for (const b of page) {
        if (!seen.has(b._id)) {
          seen.add(b._id)
          theirs.push(b)
        }
      }
      if (page.length < 500) break
    }
    const tByKey = new Map(theirs.map((b) => [forgeKey(b), b]))
    const { onlyA: onlyBmclapi, onlyB: onlyHaru, both } = setDiff(tByKey.keys(), oursByKey.keys())
    const stats = {
      bmclapi: theirs.length,
      haru: ours.length,
      common: both.length,
      onlyBmclapi: onlyBmclapi.length,
      onlyHaru: onlyHaru.length,
      buildEqual: 0,
      buildDiffLegacy: 0,
      buildDiffNew: 0,
      bmclapiNewBuilds: 0,
      bmclapiNewBuildsMatchingFormula: 0,
      branchDiff: 0,
      fileSetDiff: 0,
      sameAlgoHashDiff: 0,
      bmclapiHashLengths: {} as Record<string, number>,
      modifiedWithin1Day: 0,
      modifiedOff: 0,
    }
    const samples: Record<string, unknown[]> = { onlyBmclapi: onlyBmclapi.slice(0, 20), onlyHaru: onlyHaru.slice(0, 20), buildDiff: [], branchDiff: [], fileSetDiff: [], hashDiff: [], modifiedOff: [] }
    const add = (k: string, v: unknown) => {
      const list = samples[k] ?? []
      if (list.length < 10) list.push(v)
      samples[k] = list
    }
    for (const key of both) {
      const t = tByKey.get(key) as ForgeJson
      const o = oursByKey.get(key) as ForgeJson
      if (t.build === o.build) stats.buildEqual++
      else {
        if (isLegacyForge(t.version)) stats.buildDiffLegacy++
        else stats.buildDiffNew++
        add('buildDiff', { key, bmclapi: t.build, haru: o.build })
      }
      if (!isLegacyForge(t.version)) {
        stats.bmclapiNewBuilds++
        if (t.build === bmclapiForgeBuild(t.version)) stats.bmclapiNewBuildsMatchingFormula++
      }
      if ((t.branch ?? null) !== (o.branch ?? null)) {
        stats.branchDiff++
        add('branchDiff', { key, bmclapi: t.branch, haru: o.branch })
      }
      // some BMCLAPI file entries have no hash
      const tf = new Map((t.files ?? []).map((f) => [`${f.category}.${f.format}`, String(f.hash ?? '')]))
      const of = new Map(o.files.map((f) => [`${f.category}.${f.format}`, f.hash]))
      for (const h of tf.values()) stats.bmclapiHashLengths[h.length] = (stats.bmclapiHashLengths[h.length] ?? 0) + 1
      if (!isDeepStrictEqual(new Set(tf.keys()), new Set(of.keys()))) {
        stats.fileSetDiff++
        add('fileSetDiff', { key, bmclapi: [...tf.keys()].sort(), haru: [...of.keys()].sort() })
      }
      for (const [k, h] of tf) {
        const mine = of.get(k)
        if (mine && mine.length === h.length && mine !== h) {
          stats.sameAlgoHashDiff++
          add('hashDiff', { key, file: k, bmclapi: h, haru: mine })
        }
      }
      if (t.modified && days(o.modified, t.modified) <= 1) stats.modifiedWithin1Day++
      else {
        stats.modifiedOff++
        add('modifiedOff', { key, bmclapi: t.modified, haru: o.modified })
      }
    }
    const ok =
      !onlyBmclapi.length && !onlyHaru.length && !stats.buildDiffLegacy && !stats.buildDiffNew && !stats.branchDiff && !stats.fileSetDiff && !stats.sameAlgoHashDiff && !stats.modifiedOff
    const summary =
      `BMCLAPI ${stats.bmclapi} / haru ${stats.haru}, ${stats.common} in common, ${stats.onlyBmclapi} only in BMCLAPI, ${stats.onlyHaru} only in haru; ` +
      `build differs for ${stats.buildDiffLegacy + stats.buildDiffNew} (${stats.buildDiffNew} new-style; BMCLAPI follows major*1e6+minor*1e4+patch for ${stats.bmclapiNewBuildsMatchingFormula}/${stats.bmclapiNewBuilds}); ` +
      `branch differs for ${stats.branchDiff}; file set differs for ${stats.fileSetDiff}; same-algorithm hash differs for ${stats.sameAlgoHashDiff}; modified off by more than a day for ${stats.modifiedOff}`
    return ok ? pass(summary) : fail(summary, { stats, samples })
  })

  await check('forge', 'bmclapi', '/forge/minecraft matches BMCLAPI', async () => {
    const list = (await bmclapi.json<(string | null)[]>('/forge/minecraft')).filter((x): x is string => typeof x === 'string')
    const { onlyA, onlyB } = setDiff(list, mcs)
    return !onlyA.length && !onlyB.length ? pass(`same ${mcs.length}`) : fail(`${onlyA.length} only in BMCLAPI, ${onlyB.length} only in haru`, { onlyBmclapi: onlyA, onlyHaru: onlyB })
  })

  await check('forge', 'bmclapi', '/forge/promos matches BMCLAPI', async () => {
    const t = await bmclapi.json<PromoJson[]>('/forge/promos')
    const o = (await haru('/forge/promos')).json<PromoJson[]>()
    const tm = new Map(t.map((p) => [p.name, p]))
    const om = new Map(o.map((p) => [p.name, p]))
    const { onlyA, onlyB, both } = setDiff(tm.keys(), om.keys())
    const versionDiff = both
      .map((name) => ({ name, bmclapi: tm.get(name)?.build?.version ?? null, haru: om.get(name)?.build?.version ?? null }))
      .filter((r) => r.bmclapi !== r.haru)
    const keys = { bmclapi: Object.keys(t[0] ?? {}).sort(), haru: Object.keys(o[0] ?? {}).sort() }
    const details = { onlyBmclapi: onlyA, onlyHaru: onlyB, versionDiff, keys }
    const ok = !onlyA.length && !onlyB.length && !versionDiff.length && isDeepStrictEqual(keys.bmclapi, keys.haru)
    const summary = `BMCLAPI ${t.length} / haru ${o.length}, ${onlyA.length} only in BMCLAPI, ${onlyB.length} only in haru, ${versionDiff.length} with another version; fields BMCLAPI [${keys.bmclapi.join(',')}] vs haru [${keys.haru.join(',')}]`
    return ok ? pass(summary) : fail(summary, details)
  })

  await check('forge', 'bmclapi', '/forge/last matches BMCLAPI in shape and content', async () => {
    const t = await bmclapi.json<Record<string, unknown>>('/forge/last')
    const o = (await haru('/forge/last')).json<Record<string, unknown>>()
    const versionOf = (x: Record<string, unknown>) => ((x.build && typeof x.build === 'object' ? (x.build as ForgeJson) : x) as Partial<ForgeJson>).version
    const keys = { bmclapi: Object.keys(t).sort(), haru: Object.keys(o).sort() }
    const ok = isDeepStrictEqual(keys.bmclapi, keys.haru) && versionOf(t) === versionOf(o)
    const summary = `BMCLAPI fields [${keys.bmclapi.join(',')}] version ${versionOf(t)}; haru fields [${keys.haru.join(',')}] version ${versionOf(o)}`
    return ok ? pass(summary) : fail(summary, { bmclapi: t, haru: o })
  })

  await check('forge', 'bmclapi', '/forge/list/0/2 is ordered like BMCLAPI', async () => {
    const t = (await bmclapi.json<ForgeJson[]>('/forge/list/0/2')).map(forgeKey)
    const o = (await haru('/forge/list/0/2')).json<ForgeJson[]>().map(forgeKey)
    return isDeepStrictEqual(t, o) ? pass(t.join(', ')) : fail(`BMCLAPI [${t.join(', ')}], haru [${o.join(', ')}]`)
  })
}

// ---------------------------------------------------------------- NeoForge

interface NeoJson {
  _id?: string
  __v?: number
  rawVersion: string
  version: string
  mcversion: string
  installerPath?: string
}

/** Maven version a BMCLAPI NeoForge entry stands for ("neoforge-21.1.1" -> "21.1.1", "1.20.1-forge-47.1.85" -> "1.20.1-47.1.85"). */
const neoMavenVersion = (e: NeoJson) => (e.rawVersion.startsWith('neoforge-') ? e.rawVersion.slice('neoforge-'.length) : e.rawVersion.replace(/^1\.20\.1-forge-/, '1.20.1-'))

async function neoforgeChecks(): Promise<void> {
  const mcs = (await ctx.db.neoforge.distinct('mcversion')) as string[]
  const ours: NeoJson[] = []
  for (const mc of mcs) ours.push(...(await haru(`/neoforge/list/${encodeURIComponent(mc)}`)).json<NeoJson[]>())

  await check('neoforge', 'official', 'versions match maven.neoforged.net', async () => {
    const artifactOf = new Map<string, string>()
    for (const artifact of ['forge', 'neoforge']) {
      for (const v of (await officialJson<{ versions: string[] }>(`${up.neoforgeMaven}/api/maven/versions/releases/net/neoforged/${artifact}`)).versions) {
        artifactOf.set(v, artifact)
      }
    }
    const { onlyA, onlyB } = setDiff(artifactOf.keys(), ours.map((v) => v.rawVersion))
    // the version lists also name versions without any files, e.g. forge 47.1.82
    const empty: string[] = []
    for (const v of onlyA) {
      if ((await official(`${up.neoforgeMaven}/api/maven/details/releases/net/neoforged/${artifactOf.get(v)}/${v}`)).status === 404) empty.push(v)
    }
    const missing = onlyA.filter((v) => !empty.includes(v))
    const summary = `official ${artifactOf.size}, haru lacks ${missing.length} and has ${onlyB.length} extra`
    if (missing.length || onlyB.length) return fail(summary, { missingInHaru: missing.slice(0, 50), extraInHaru: onlyB.slice(0, 50) })
    return empty.length ? warn(`${summary}; ${empty.length} listed upstream without any files: ${empty.join(', ')}`) : pass(`same ${artifactOf.size} versions`)
  })

  await check('neoforge', 'official', 'every mcversion is a Minecraft version id', async () => {
    const ids = new Set((await haru('/mc/game/version_manifest_v2.json')).json<Manifest>().versions.map((v) => v.id))
    const bad = mcs.filter((m) => !ids.has(m))
    return bad.length ? fail(`${bad.length} unknown: ${bad.join(', ')}`) : pass(`all ${mcs.length} exist`)
  })

  for (const artifact of ['neoforge', 'forge']) {
    const path = `/api/maven/details/releases/net/neoforged/${artifact}`
    await check('neoforge', 'official', `/neoforge/meta${path} matches maven.neoforged.net`, async () => {
      const c = compareJson((await haru(`/neoforge/meta${path}`)).body, (await official(`${up.neoforgeMaven}${path}`)).body)
      if (c.result === 'equal') return pass('equal')
      return c.result === 'haru-older' ? warn('haru has an older copy (new versions upstream since the sync)', c) : fail(`not equal (${c.result})`, c)
    })
  }

  const theirs = new Map<string, NeoJson[]>()
  await check('neoforge', 'bmclapi', 'NeoForge versions of each Minecraft version match BMCLAPI', async () => {
    const onlyBmclapi: string[] = []
    const onlyHaru: string[] = []
    let total = 0
    for (const mc of mcs) {
      const list = await bmclapi.json<NeoJson[]>(`/neoforge/list/${encodeURIComponent(mc)}`)
      theirs.set(mc, list)
      total += list.length
      const { onlyA, onlyB } = setDiff(list.map(neoMavenVersion), ours.filter((e) => e.mcversion === mc).map((e) => e.rawVersion))
      onlyBmclapi.push(...onlyA.map((v) => `${mc}:${v}`))
      onlyHaru.push(...onlyB.map((v) => `${mc}:${v}`))
    }
    const summary = `${mcs.length} Minecraft versions, BMCLAPI ${total} / haru ${ours.length}, ${onlyBmclapi.length} only in BMCLAPI, ${onlyHaru.length} only in haru`
    if (!onlyBmclapi.length && !onlyHaru.length) return pass(summary)
    const details = { onlyBmclapi: onlyBmclapi.slice(0, 50), onlyHaru: onlyHaru.slice(0, 50) }
    // haru having more is fine as long as it matches the official list (checked above)
    return onlyBmclapi.length ? fail(summary, details) : warn(`${summary} (all of them are upstream; BMCLAPI lacks them)`, details)
  })

  await check('neoforge', 'bmclapi', '/neoforge/list fields (rawVersion / version / installerPath) match BMCLAPI', async () => {
    if (!theirs.size) return fail('no BMCLAPI data')
    const diff = { rawVersion: 0, version: 0, installerPath: 0, compared: 0 }
    const samples: unknown[] = []
    for (const [mc, list] of theirs) {
      const om = new Map(ours.filter((e) => e.mcversion === mc).map((e) => [e.rawVersion, e]))
      for (const t of list) {
        const o = om.get(neoMavenVersion(t))
        if (!o) continue
        diff.compared++
        const fields = (['rawVersion', 'version', 'installerPath'] as const).filter((k) => (t[k] ?? null) !== (o[k] ?? null))
        for (const k of fields) diff[k]++
        if (fields.length && samples.length < 12) samples.push({ bmclapi: t, haru: o })
      }
    }
    const summary = `${diff.compared} compared: rawVersion differs for ${diff.rawVersion}, version for ${diff.version}, installerPath for ${diff.installerPath}`
    return diff.rawVersion || diff.version || diff.installerPath ? fail(summary, { diff, samples }) : pass(summary)
  })
}

// ---------------------------------------------------------------- OptiFine

interface OptiFineJson {
  _id?: string
  __v?: number
  mcversion: string
  type: string
  patch: string
  filename: string
  forge?: string
}

async function optifineChecks(): Promise<void> {
  const ours = (await haru('/optifine/versionList')).json<OptiFineJson[]>()

  const listed = new Set<string>()
  await check('optifine', 'official', 'every version on optifine.net/downloads is listed', async () => {
    const html = (await official(`${up.optifine}/downloads`)).body.toString('utf8')
    for (const m of html.matchAll(/[?&](?:amp;)?f=([^"'&\s<>]+?\.jar)/gi)) listed.add(decodeURIComponent(m[1] ?? ''))
    // haru keeps the versions the page no longer lists
    const { onlyA, onlyB } = setDiff(listed, ours.map((e) => e.filename))
    return onlyA.length ? fail(`haru lacks ${onlyA.length} of ${listed.size}`, { onlyOfficial: onlyA }) : pass(`all ${listed.size}, plus ${onlyB.length} no longer listed`)
  })

  await check('optifine', 'official', 'mcversion/type/patch add up to the file name', async () => {
    const bad = ours.filter((e) => e.filename !== `${e.filename.startsWith('preview_') ? 'preview_' : ''}OptiFine_${e.mcversion}_${e.type}_${e.patch}.jar`)
    return bad.length ? fail(`${bad.length} differ`, bad) : pass(`all ${ours.length}`)
  })

  await check('optifine', 'bmclapi', '/optifine/versionList matches BMCLAPI', async () => {
    const t = await bmclapi.json<OptiFineJson[]>('/optifine/versionList')
    const tm = new Map(t.map((e) => [e.filename, e]))
    const om = new Map(ours.map((e) => [e.filename, e]))
    const { onlyA, onlyB, both } = setDiff(tm.keys(), om.keys())
    const fieldDiff = both.filter((f) => {
      const a = tm.get(f) as OptiFineJson
      const b = om.get(f) as OptiFineJson
      return a.mcversion !== b.mcversion || a.type !== b.type || a.patch !== b.patch
    })
    const forgeDiff = both
      .filter((f) => tm.get(f)?.forge !== undefined && tm.get(f)?.forge !== om.get(f)?.forge)
      .map((f) => ({ filename: f, bmclapi: tm.get(f)?.forge, haru: om.get(f)?.forge }))
    const forgeMissingInBmclapi = both.filter((f) => tm.get(f)?.forge === undefined).length
    const summary =
      `BMCLAPI ${t.length} / haru ${ours.length}, ${both.length} in common, ${onlyA.length} only in BMCLAPI, ${onlyB.length} only in haru; ` +
      `mcversion/type/patch differ for ${fieldDiff.length}; forge differs for ${forgeDiff.length} (missing in BMCLAPI for ${forgeMissingInBmclapi})`
    const details = { onlyBmclapi: onlyA.slice(0, 40), onlyHaru: onlyB, fieldDiff, forgeDiff: forgeDiff.slice(0, 20) }
    if (onlyA.length || fieldDiff.length) return fail(summary, details)
    return onlyB.length || forgeDiff.length ? warn(summary, details) : pass(summary)
  })

  await check('optifine', 'official', 'versions optifine.net no longer lists download as a jar or 404, never as an HTML page (2 sampled)', async () => {
    const gone = ours.filter((e) => !listed.has(e.filename))
    if (!listed.size || !gone.length) return pass('nothing to check')
    const rows: { filename: string; status: number; jar: boolean }[] = []
    for (const e of [gone[0], gone.at(-1)].filter((x): x is OptiFineJson => x !== undefined)) {
      const r = await haru(`/optifine/${e.mcversion}/${e.type}/${e.patch}`)
      rows.push({ filename: e.filename, status: r.status, jar: r.body.subarray(0, 2).toString('latin1') === 'PK' })
    }
    const bad = rows.filter((r) => r.status !== 404 && !(r.status === 200 && r.jar))
    return bad.length ? fail(`${bad.length} of ${rows.length} wrong`, rows) : pass(rows.map((r) => `${r.filename}: ${r.status}`).join(', '), rows)
  })
}

// ---------------------------------------------------------------- LiteLoader

interface LiteJson {
  _id?: string
  __v?: number
  mcversion: string
  version: string
  type: string
  hash: string
  build: Record<string, unknown>
}

async function liteloaderChecks(): Promise<void> {
  const ours = (await haru('/liteloader/list')).json<LiteJson[]>()

  await check('liteloader', 'official', 'versions / md5 match versions.json', async () => {
    type Group = Record<string, Record<string, Record<string, unknown>>>
    const json = await officialJson<{ versions: Record<string, Record<string, unknown>> }>(`${up.liteloader}/versions/versions.json`)
    const expected = new Map<string, string>()
    for (const [mc, info] of Object.entries(json.versions)) {
      for (const group of ['artefacts', 'snapshots']) {
        for (const e of Object.values((info[group] as Group | undefined)?.['com.mumfrey:liteloader'] ?? {})) {
          if (typeof e.version === 'string') expected.set(`${mc}|${e.version}`, String(e.md5 ?? ''))
        }
      }
    }
    const got = new Map(ours.map((e) => [`${e.mcversion}|${e.version}`, e.hash]))
    const { onlyA, onlyB, both } = setDiff(expected.keys(), got.keys())
    const md5Diff = both.filter((k) => expected.get(k) !== got.get(k))
    return !onlyA.length && !onlyB.length && !md5Diff.length
      ? pass(`same ${expected.size} versions`)
      : fail(`haru lacks ${onlyA.length}, has ${onlyB.length} extra, md5 differs for ${md5Diff.length}`, { onlyOfficial: onlyA, onlyHaru: onlyB, md5Diff })
  })

  await check('liteloader', 'official', '/maven/com/mumfrey/liteloader/versions.json is byte-identical to upstream', async () => {
    const ours = await haru('/maven/com/mumfrey/liteloader/versions.json')
    const theirs = await official(`${up.liteloader}/versions/versions.json`)
    return ours.body.equals(theirs.body) ? pass(`byte-identical (${theirs.body.length} B)`) : fail(`different (haru HTTP ${ours.status})`, compareJson(ours.body, theirs.body))
  })

  await check('liteloader', 'bmclapi', '/liteloader/list matches BMCLAPI', async () => {
    const t = await bmclapi.json<LiteJson[]>('/liteloader/list')
    const tm = new Map(t.map((e) => [`${e.mcversion}|${e.version}`, e]))
    const om = new Map(ours.map((e) => [`${e.mcversion}|${e.version}`, e]))
    const { onlyA, onlyB, both } = setDiff(tm.keys(), om.keys())
    const diff = both.filter((k) => {
      const a = tm.get(k) as LiteJson
      const b = om.get(k) as LiteJson
      return a.hash !== b.hash || a.type !== b.type || !isDeepStrictEqual(a.build, b.build)
    })
    const summary = `BMCLAPI ${t.length} / haru ${ours.length}, ${onlyA.length} only in BMCLAPI, ${onlyB.length} only in haru, ${diff.length} with other content`
    return !onlyA.length && !onlyB.length && !diff.length
      ? pass(summary)
      : fail(summary, { onlyBmclapi: onlyA, onlyHaru: onlyB, diff: diff.slice(0, 10).map((k) => ({ key: k, bmclapi: tm.get(k), haru: om.get(k) })) })
  })
}

// ---------------------------------------------------------------- Fabric

async function fabricChecks(): Promise<void> {
  await check('fabric', 'official', `the ${FABRIC_LISTS.length} synced lists match meta.fabricmc.net`, async () => {
    const rows: { path: string; result: string; onlyHaru: number; onlyOther: number }[] = []
    for (const path of FABRIC_LISTS) {
      rows.push({ path, ...compareJson((await haru(`/fabric-meta${path}`)).body, (await official(`${up.fabricMeta}${path}`)).body) })
    }
    const bad = rows.filter((r) => r.result === 'different' || r.result === 'other-older')
    const older = rows.filter((r) => r.result === 'haru-older')
    if (bad.length) return fail(`${bad.length} differ`, rows)
    return older.length ? warn(`${older.length} older in haru (new entries upstream)`, rows) : pass(`all ${rows.length} equal`)
  })

  await check('fabric', 'official', 'a path fetched on demand matches upstream (/v2/versions/loader/1.20.1)', async () => {
    const path = '/v2/versions/loader/1.20.1'
    const c = compareJson((await haru(`/fabric-meta${path}`)).body, (await official(`${up.fabricMeta}${path}`)).body)
    return c.result === 'equal' ? pass('equal') : fail(`not equal (${c.result})`, c)
  })

  await check('fabric', 'bmclapi', '/fabric-meta (loader and game lists) matches BMCLAPI', async () => {
    const rows: { path: string; result: string; onlyHaru: number; onlyOther: number }[] = []
    for (const path of ['/v2/versions/loader', '/v2/versions/game']) {
      const theirs = await bmclapi.get(`/fabric-meta${path}`)
      rows.push({ path, ...compareJson((await haru(`/fabric-meta${path}`)).body, theirs.body) })
    }
    if (rows.some((r) => r.result === 'different')) return fail('different', rows)
    return rows.every((r) => r.result === 'equal') ? pass('equal', rows) : warn('one side is older', rows)
  })
}

// ---------------------------------------------------------------- authlib-injector

interface AuthlibArtifact {
  build_number: number
  version: string
  download_url: string
  checksums: { sha256: string }
}

async function authlibChecks(): Promise<void> {
  const base = '/mirrors/authlib-injector'

  await check('authlib-injector', 'official', 'artifacts.json / latest.json / newest 10 artifact/<build>.json match upstream', async () => {
    const index = (await haru(`${base}/artifacts.json`)).json<{ artifacts: { build_number: number }[] }>()
    const paths = ['/artifacts.json', '/artifact/latest.json', ...index.artifacts.slice(-10).map((a) => `/artifact/${a.build_number}.json`)]
    const rows: { path: string; result: string }[] = []
    for (const p of paths) rows.push({ path: p, result: compareJson((await haru(`${base}${p}`)).body, (await official(`${up.authlibInjector}${p}`)).body).result })
    const bad = rows.filter((r) => r.result !== 'equal')
    return bad.length ? fail(`${bad.length} of ${rows.length} differ`, rows) : pass(`${rows.length} documents`)
  })

  await check('authlib-injector', 'bmclapi', 'latest.json matches BMCLAPI (including where download_url points)', async () => {
    const t = await bmclapi.json<AuthlibArtifact>(`${base}/artifact/latest.json`)
    const o = (await haru(`${base}/artifact/latest.json`)).json<AuthlibArtifact>()
    const strip = (a: AuthlibArtifact) => ({ ...a, download_url: new URL(a.download_url).pathname.replace(/^\/mirrors\/authlib-injector/, '') })
    if (!isDeepStrictEqual(strip(t), strip(o))) return fail('different', { bmclapi: t, haru: o })
    if (new URL(t.download_url).host !== new URL(o.download_url).host) {
      return fail(`same content, but BMCLAPI points download_url at itself (${t.download_url}) and haru at upstream (${o.download_url})`)
    }
    return pass('equal')
  })

  await check('authlib-injector', 'bmclapi', 'artifacts.json matches BMCLAPI', async () => {
    const c = compareJson((await haru(`${base}/artifacts.json`)).body, (await bmclapi.get(`${base}/artifacts.json`)).body)
    return c.result === 'equal' ? pass('equal') : c.result === 'different' ? fail('different', c) : warn(`one side is older (${c.result})`, c)
  })
}

// ---------------------------------------------------------------- real downloads (small files only)

async function fileChecks(): Promise<void> {
  type Artifact = { path: string; sha1: string; size: number; url: string }
  type VersionJson = { assetIndex: { url: string }; libraries: { downloads?: { artifact?: Artifact } }[] }
  const v1201 = (await haru('/version/1.20.1/json')).json<VersionJson>()

  await check('files', 'official', '/assets downloads from upstream with the right sha1, then serves from GridFS (with Range)', async () => {
    const index = (await haru(new URL(v1201.assetIndex.url).pathname)).json<{ objects: Record<string, { hash: string; size: number }> }>()
    const obj = Object.values(index.objects)
      .filter((o) => o.size > 0)
      .sort((a, b) => a.size - b.size)[0]
    if (!obj) return fail('empty asset index')
    const key = `assets/${obj.hash.slice(0, 2)}/${obj.hash}`
    const first = await haru(`/${key}`)
    if (first.status !== 200 || sha1Hex(first.body) !== obj.hash) return fail(`first request: HTTP ${first.status}, sha1 ${sha1Hex(first.body)}`)
    await sleep(500)
    const cached = await ctx.files.find(key)
    const second = await haru(`/${key}`)
    const ok = cached !== null && second.headers['accept-ranges'] === 'bytes' && second.body.equals(first.body)
    return ok ? pass(`/${key} (${obj.size} B)`) : fail('not cached, or the second response differs', { cached: cached !== null, headers: second.headers })
  })

  await check('files', 'official', '/libraries and /maven download with the right sha1', async () => {
    const lib = v1201.libraries
      .map((l) => l.downloads?.artifact)
      .filter((a): a is Artifact => a?.url.startsWith('https://libraries.minecraft.net/') === true)
      .sort((a, b) => a.size - b.size)[0]
    if (!lib) return fail('1.20.1 has no library on libraries.minecraft.net')
    const a = await haru(`/libraries/${lib.path}`)
    const b = await haru(`/maven/${lib.path}`)
    const ok = a.status === 200 && b.status === 200 && sha1Hex(a.body) === lib.sha1 && sha1Hex(b.body) === lib.sha1
    return ok ? pass(`${lib.path} (${lib.size} B)`) : fail('different', { libraries: a.status, maven: b.status })
  })

  await check('files', 'official', 'Forge download (/forge/download?…&category=changelog&format=txt) matches the listed sha1', async () => {
    const b = (await haru('/forge/minecraft/1.20.1')).json<ForgeJson[]>().find((x) => x.version === '47.2.0')
    const sha1 = b?.files.find((f) => f.category === 'changelog' && f.format === 'txt')?.hash
    const r = await haru('/forge/download?mcversion=1.20.1&version=47.2.0&category=changelog&format=txt')
    return r.status === 200 && sha1 === sha1Hex(r.body) ? pass(`${r.body.length} B, sha1 ${sha1}`) : fail(`HTTP ${r.status}, sha1 ${sha1Hex(r.body)}, expected ${sha1}`)
  })

  await check('files', 'official', 'authlib-injector jar matches the sha256 of latest.json', async () => {
    const latest = (await haru('/mirrors/authlib-injector/artifact/latest.json')).json<AuthlibArtifact>()
    const r = await haru(`/mirrors/authlib-injector${new URL(latest.download_url).pathname}`)
    return r.status === 200 && sha256Hex(r.body) === latest.checksums.sha256 ? pass(`${latest.version} (${r.body.length} B)`) : fail(`HTTP ${r.status}`)
  })

  for (const mcversion of ['1.7.10', '1.12.2']) {
    await check('files', 'official', `LiteLoader /liteloader/download matches the listed md5 (${mcversion})`, async () => {
      const e = (await haru(`/liteloader/list?mcversion=${mcversion}`)).json<LiteJson>()
      const r = await haru(`/liteloader/download?version=${encodeURIComponent(e.version)}`)
      if (r.status === 200 && md5Hex(r.body) === e.hash) return pass(`${e.version} (${r.body.length} B)`)
      // snapshot jars go through redirector.liteloader.com, which may be gone
      const upstream = await official(`${up.liteloader}/versions/com/mumfrey/liteloader/${e.version}/liteloader-${e.version}.jar`).catch((err: unknown) => err)
      const upstreamStatus = upstream instanceof Error ? upstream.message : `HTTP ${(upstream as BufferedResponse).status}`
      if (r.status === 502 && (upstream instanceof Error || (upstream as BufferedResponse).status >= 500)) {
        return warn(`${e.version}: the upstream download itself is broken (${upstreamStatus}), haru can only answer 502`)
      }
      return fail(`${e.version}: HTTP ${r.status}, md5 ${md5Hex(r.body)}, expected ${e.hash} (upstream ${upstreamStatus})`)
    })
  }

  await check('files', 'bmclapi', 'OptiFine download (through adloadx) works and matches the sha1 BMCLAPI publishes', async () => {
    const path = '/optifine/1.20.1/HD_U/I6'
    const r = await haru(path)
    if (r.status !== 200 || r.body.subarray(0, 2).toString('latin1') !== 'PK') return fail(`HTTP ${r.status}, not a jar`)
    const { hash, chain } = await bmclapi.downloadHash(path)
    if (!hash) return warn(`downloaded (${r.body.length} B), but BMCLAPI's redirects carry no x-bmclapi-hash to compare with`, chain)
    return hash === sha1Hex(r.body) ? pass(`${r.body.length} B, same sha1 as BMCLAPI`) : fail(`sha1 ${sha1Hex(r.body)} vs BMCLAPI ${hash}`, chain)
  })
}

// ---------------------------------------------------------------- endpoints documented by BMCLAPI

async function endpointChecks(): Promise<void> {
  const routeMissing = (r: Served) => r.status === 404 && /^Route /.test(String((r.json<{ message?: unknown }>() ?? {}).message ?? ''))

  await check('endpoints', 'docs', 'endpoints of the BMCLAPI documentation and its usage notes exist', async () => {
    const documented = [
      '/forge/last',
      '/forge/list/0/1',
      '/forge/minecraft/1.20.1',
      '/forge/promos',
      '/forge/minecraft',
      '/java/list',
      '/liteloader/list',
      '/maven/com/mumfrey/liteloader/versions.json',
      '/mirrors/authlib-injector/artifacts.json',
      '/neoforge/list/1.21.1',
      '/neoforge/meta/api/maven/details/releases/net/neoforged/neoforge',
      '/neoforge/version/21.1.1',
      '/optifine/versionList',
      '/optifine/1.20.1',
      '/openbmclapi/sponsor',
      '/mc/game/version_manifest.json',
      '/mc/game/version_manifest_v2.json',
      JAVA_ALL_PATH,
      '/fabric-meta/v2/versions/loader',
      '/quilt-meta/v3/versions/loader',
    ]
    const rows: { path: string; status: number; missing: boolean }[] = []
    for (const path of documented) {
      const r = await haru(path)
      rows.push({ path, status: r.status, missing: routeMissing(r) })
    }
    const missing = rows.filter((r) => r.missing).map((r) => r.path)
    return missing.length ? fail(`${missing.length} of ${rows.length} missing: ${missing.join(', ')}`, rows) : pass(`all ${rows.length} exist`, rows)
  })

  await check('endpoints', 'docs', 'Forge download by BMCLAPI build number: /forge/download/47020000 (= 1.20.1-47.2.0)', async () => {
    const r = await haru('/forge/download/47020000')
    return r.status === 200 ? pass(`${r.body.length} B`) : fail(`haru answered HTTP ${r.status}`)
  })

  await check('endpoints', 'docs', 'NeoForge download takes the documented extension-less file: /neoforge/version/21.1.1/download/installer', async () => {
    const r = await haru('/neoforge/version/21.1.1/download/installer')
    return r.status === 200 ? pass(`${r.body.length} B`) : fail(`haru answered HTTP ${r.status}`)
  })
}

// ---------------------------------------------------------------- main

const TASK_OF: Partial<Record<Area, SyncTaskName>> = {
  mojang: 'mojang',
  java: 'java',
  forge: 'forge',
  neoforge: 'neoforge',
  optifine: 'optifine',
  liteloader: 'liteloader',
  fabric: 'fabric',
  'authlib-injector': 'authlib-injector',
}

const startedAt = new Date()
console.log(`haru-api e2e: MongoDB ${config.mongoUri.replace(/\/\/[^@/]*@/, '//***@')}, areas ${[...areas].join(', ')}, BMCLAPI ${withBmclapi ? BMCLAPI : 'skipped'}`)

if (flag('sync')) {
  const tasks = option('only') ? [...areas].map((a) => TASK_OF[a]).filter((t): t is SyncTaskName => t !== undefined) : [...ALL_SYNC_TASKS]
  console.log(`syncing first: ${tasks.join(', ')}`)
  const settled = await Promise.allSettled(tasks.map((t) => runner.run(t)))
  settled.forEach((s, i) => console.log(`  sync ${tasks[i]}: ${s.status === 'fulfilled' ? JSON.stringify(s.value) : `failed: ${String(s.reason)}`}`))
}

const SECTIONS: [Area, () => Promise<void>][] = [
  ['mojang', mojangChecks],
  ['java', javaChecks],
  ['forge', forgeChecks],
  ['neoforge', neoforgeChecks],
  ['optifine', optifineChecks],
  ['liteloader', liteloaderChecks],
  ['fabric', fabricChecks],
  ['authlib-injector', authlibChecks],
  ['files', fileChecks],
  ['endpoints', endpointChecks],
]
for (const [area, run] of SECTIONS) {
  if (!areas.has(area)) continue
  try {
    await run()
  } catch (err) {
    results.push({ area, against: 'official', name: 'loading data', status: 'fail', summary: err instanceof Error ? err.message : String(err) })
    console.log(`[FAIL] ${area} | loading data failed — ${err instanceof Error ? err.message : String(err)}`)
  }
}

const count = (s: Status) => results.filter((r) => r.status === s).length
writeFileSync(
  REPORT,
  JSON.stringify({ startedAt, finishedAt: new Date(), bmclapi: { origin: BMCLAPI, requests: bmclapi.requests, limits: bmclapi.limits }, results }, null, 2),
)
console.log(`\n${results.length} checks: ${count('pass')} passed, ${count('warn')} warnings, ${count('fail')} failed; ${bmclapi.requests} BMCLAPI requests`)
console.log(`report: ${REPORT}`)

await app.close()
await closeContext(ctx)
process.exit(count('fail') ? 1 : 0)
