import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Upstreams } from '../src/config.js'

const FIXTURES = join(import.meta.dirname, 'fixtures')

export const read = (p: string): Buffer => readFileSync(join(FIXTURES, p))
export const sha1 = (b: Buffer | string): string => createHash('sha1').update(b).digest('hex')
const json = (o: unknown): Buffer => Buffer.from(JSON.stringify(o))

interface Route {
  body: Buffer
  type: string
  lastModified?: string | undefined
}

export interface FakeUpstream {
  upstreams: Upstreams
  /** "METHOD /path?query" of every request received */
  requests: string[]
  /** contents served by the fake, by upstream path */
  routes: Map<string, Route>
  close(): Promise<void>
}

const OPTIFINE_TOKEN = '1a2b3c4d5e6f'

/**
 * Serves the official upstream layouts from fixtures, one path prefix per upstream host
 * (e.g. /piston-meta/... for https://piston-meta.mojang.com/...).
 */
export async function startFakeUpstream(): Promise<FakeUpstream> {
  const routes = new Map<string, Route>()
  const add = (path: string, body: Buffer | string, type = 'application/octet-stream', lastModified?: string) =>
    routes.set(path, { body: Buffer.isBuffer(body) ? body : Buffer.from(body), type, lastModified })

  // Mojang: asset objects, asset indexes, client jar, version JSONs, manifests
  const asset = Buffer.from('fake sound')
  const assetHash = sha1(asset)
  add(`/resources/${assetHash.slice(0, 2)}/${assetHash}`, asset)
  const index = json({ objects: { 'minecraft/sounds/fake.ogg': { hash: assetHash, size: asset.length } } })
  add(`/piston-meta/v1/packages/${sha1(index)}/5.json`, index, 'application/json')
  const preIndex = json({ map_to_resources: true, objects: {} })
  add(`/launcher-meta/v1/packages/${sha1(preIndex)}/pre-1.6.json`, preIndex, 'application/json')
  const client = Buffer.from('fake client jar 1.20.1')
  add(`/piston-data/v1/objects/${sha1(client)}/client.jar`, client, 'application/java-archive')

  const v1201 = JSON.parse(read('mojang/1.20.1.json').toString('utf8'))
  v1201.assetIndex = { ...v1201.assetIndex, sha1: sha1(index), size: index.length, url: `https://piston-meta.mojang.com/v1/packages/${sha1(index)}/5.json` }
  v1201.downloads.client = { sha1: sha1(client), size: client.length, url: `https://piston-data.mojang.com/v1/objects/${sha1(client)}/client.jar` }
  const rd = JSON.parse(read('mojang/rd-132211.json').toString('utf8'))
  rd.assetIndex = { ...rd.assetIndex, sha1: sha1(preIndex), size: preIndex.length, url: `https://launchermeta.mojang.com/v1/packages/${sha1(preIndex)}/pre-1.6.json` }
  const versions = [
    { id: '1.20.1', type: 'release', body: Buffer.from(JSON.stringify(v1201, null, 2)), time: '2023-06-12T13:25:51+00:00' },
    { id: 'rd-132211', type: 'old_alpha', body: Buffer.from(JSON.stringify(rd)), time: '2009-05-13T20:11:00+00:00' },
  ]
  for (const v of versions) add(`/piston-meta/v1/packages/${sha1(v.body)}/${v.id}.json`, v.body, 'application/json')
  const manifest = {
    latest: { release: '1.20.1', snapshot: '1.20.1' },
    versions: versions.map((v) => ({
      id: v.id,
      type: v.type,
      url: `https://piston-meta.mojang.com/v1/packages/${sha1(v.body)}/${v.id}.json`,
      time: v.time,
      releaseTime: v.time,
      sha1: sha1(v.body),
      complianceLevel: 1,
    })),
  }
  add('/piston-meta/mc/game/version_manifest_v2.json', json(manifest), 'application/json')
  add(
    '/piston-meta/mc/game/version_manifest.json',
    json({ latest: manifest.latest, versions: manifest.versions.map(({ sha1: _s, complianceLevel: _c, ...v }) => v) }),
    'application/json',
  )

  // Java runtimes
  const javaBin = Buffer.from('fake java binary')
  add(`/piston-data/v1/objects/${sha1(javaBin)}/java`, javaBin)
  const runtime = json({
    files: { 'bin/java': { type: 'file', executable: true, downloads: { raw: { sha1: sha1(javaBin), size: javaBin.length, url: `https://piston-data.mojang.com/v1/objects/${sha1(javaBin)}/java` } } } },
  })
  add(`/piston-meta/v1/packages/${sha1(runtime)}/manifest.json`, runtime, 'application/json')
  const javaAll = JSON.parse(read('mojang/java_all.json').toString('utf8')) as Record<string, Record<string, { manifest: unknown }[]>>
  for (const platform of Object.values(javaAll)) {
    for (const entries of Object.values(platform)) {
      for (const e of entries) {
        e.manifest = { sha1: sha1(runtime), size: runtime.length, url: `https://piston-meta.mojang.com/v1/packages/${sha1(runtime)}/manifest.json` }
      }
    }
  }
  add('/piston-meta/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json', json(javaAll), 'application/json')

  add('/libraries/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar', 'fake lwjgl')

  // Forge
  add('/forge-files/net/minecraftforge/forge/maven-metadata.json', read('forge/maven-metadata.json'), 'application/json')
  add('/forge-files/net/minecraftforge/forge/promotions_slim.json', read('forge/promotions_slim.json'), 'application/json')
  const forgeVersions = JSON.parse(read('forge/maven-metadata.json').toString('utf8')) as Record<string, string[]>
  for (const [mc, list] of Object.entries(forgeVersions)) {
    add(`/forge-files/net/minecraftforge/forge/index_${mc}.html`, read(`forge/index_${mc}.html`), 'text/html; charset=utf-8')
    for (const lv of list) {
      const meta = read(`forge/meta/${lv}.json`)
      const classifiers = (JSON.parse(meta.toString('utf8')) as { classifiers: Record<string, Record<string, string>> }).classifiers
      for (const [category, exts] of Object.entries(classifiers)) {
        for (const ext of Object.keys(exts)) {
          add(`/forge-maven/net/minecraftforge/forge/${lv}/forge-${lv}-${category}.${ext}`, `fake forge ${lv} ${category}`, 'application/java-archive')
        }
      }
    }
  }

  // NeoForge (Reposilite API + releases repository)
  const neo = {
    forge: ['1.20.1-47.1.100'],
    neoforge: ['20.4.237', '21.0.0-beta', '0.25w14craftmine.5-beta', '26.1.0.0-alpha.1+snapshot-1'],
  }
  for (const [artifact, list] of Object.entries(neo)) {
    add(`/neoforge-maven/api/maven/versions/releases/net/neoforged/${artifact}`, json({ isSnapshot: false, versions: list }), 'application/json')
    add(
      `/neoforge-maven/api/maven/details/releases/net/neoforged/${artifact}`,
      json({ name: artifact, type: 'DIRECTORY', files: list.map((name) => ({ type: 'DIRECTORY', name })) }),
      'application/json',
    )
    for (const v of list) {
      add(`/neoforge-maven/releases/net/neoforged/${artifact}/${v}/${artifact}-${v}-installer.jar`, `fake ${artifact} ${v} installer`)
    }
  }

  // Fabric
  const loader = JSON.parse(read('fabric/loader.json').toString('utf8'))
  const intermediary = JSON.parse(read('fabric/intermediary.json').toString('utf8'))
  const game = [
    { version: '1.20.1', stable: true },
    { version: '1.20', stable: true },
  ]
  const installer = [{ url: 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar', maven: 'net.fabricmc:fabric-installer:1.0.1', version: '1.0.1', stable: true }]
  add('/fabric-meta/v2/versions', json({ game, mappings: [], intermediary, loader, installer }), 'application/json')
  add('/fabric-meta/v2/versions/game', json(game), 'application/json')
  add('/fabric-meta/v2/versions/game/yarn', json(game), 'application/json')
  add('/fabric-meta/v2/versions/game/intermediary', json(game), 'application/json')
  add('/fabric-meta/v2/versions/intermediary', json(intermediary), 'application/json')
  add('/fabric-meta/v2/versions/yarn', json([]), 'application/json')
  add('/fabric-meta/v2/versions/loader', read('fabric/loader.json'), 'application/json')
  add('/fabric-meta/v2/versions/installer', json(installer), 'application/json')
  add('/fabric-meta/v2/versions/loader/1.20.1/0.15.11/profile/json', json({ id: 'fabric-loader-0.15.11-1.20.1', inheritsFrom: '1.20.1' }), 'application/json')
  add('/fabric-maven/net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar', 'fake fabric loader')

  // OptiFine (downloads page; adloadx/downloadx are handled below)
  add('/optifine/downloads', read('optifine/downloads.html'), 'text/html; charset=utf-8')

  // LiteLoader
  add('/liteloader/versions/versions.json', read('liteloader/versions.json'), 'application/json')
  add('/liteloader/versions/com/mumfrey/liteloader/1.12.2-SNAPSHOT/liteloader-1.12.2-SNAPSHOT.jar', 'fake liteloader 1.12.2-SNAPSHOT')
  add('/liteloader/versions/com/mumfrey/liteloader/1.7.10/liteloader-1.7.10_04.jar', 'fake liteloader 1.7.10_04')

  // authlib-injector
  const artifact = (n: number, v: string) =>
    json({ build_number: n, version: v, release_time: '2024-01-01T00:00:00Z', download_url: `https://authlib-injector.yushi.moe/artifact/${n}/authlib-injector-${v}.jar`, checksums: { sha256: '00' } })
  add('/authlib/artifacts.json', json({ latest_build_number: 53, artifacts: [{ build_number: 52, version: '1.2.4' }, { build_number: 53, version: '1.2.5' }] }), 'application/json')
  add('/authlib/artifact/latest.json', artifact(53, '1.2.5'), 'application/json')
  add('/authlib/artifact/52.json', artifact(52, '1.2.4'), 'application/json')
  add('/authlib/artifact/53.json', artifact(53, '1.2.5'), 'application/json')
  add('/authlib/artifact/53/authlib-injector-1.2.5.jar', 'fake authlib-injector 1.2.5')

  const requests: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push(`${req.method} ${url.pathname}${url.search}`)
    const f = url.searchParams.get('f') ?? ''
    if (url.pathname === '/optifine/adloadx' && /OptiFine_.+\.jar$/.test(f)) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<html><body><span id="Download"><a href='downloadx?f=${f}&amp;x=${OPTIFINE_TOKEN}' onclick='onDownload()'>${f}</a></span></body></html>`)
      return
    }
    if (url.pathname === '/optifine/downloadx' && url.searchParams.get('x') === OPTIFINE_TOKEN) {
      const body = Buffer.from(`fake optifine ${f}`)
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }
    const route = routes.get(url.pathname)
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    res.writeHead(200, {
      'content-type': route.type,
      'content-length': route.body.length,
      ...(route.lastModified ? { 'last-modified': route.lastModified } : {}),
    })
    res.end(req.method === 'HEAD' ? undefined : route.body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    upstreams: {
      pistonMeta: `${base}/piston-meta`,
      pistonData: `${base}/piston-data`,
      launcherMeta: `${base}/launcher-meta`,
      launcher: `${base}/launcher`,
      resources: `${base}/resources`,
      libraries: `${base}/libraries`,
      forgeFiles: `${base}/forge-files`,
      forgeMaven: `${base}/forge-maven`,
      neoforgeMaven: `${base}/neoforge-maven`,
      fabricMeta: `${base}/fabric-meta`,
      fabricMaven: `${base}/fabric-maven`,
      optifine: `${base}/optifine`,
      liteloader: `${base}/liteloader`,
      authlibInjector: `${base}/authlib`,
    },
    requests,
    routes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
