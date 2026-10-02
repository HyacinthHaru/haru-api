import type { FastifyInstance } from 'fastify'
import { ObjectId } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ALL_SYNC_TASKS, loadConfig } from '../src/config.js'
import { closeContext, createContext, type AppContext } from '../src/context.js'
import { createLogger } from '../src/logger.js'
import { buildApp } from '../src/server/app.js'
import { SyncRunner } from '../src/sync/index.js'
import { read, sha1, startFakeUpstream, type FakeUpstream } from './fake-upstream.js'

// Needs a MongoDB server (MONGODB_URI, default mongodb://127.0.0.1:27017).
let fake: FakeUpstream
let ctx: AppContext
let app: FastifyInstance

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers })
const upstreamHits = (path: string) => fake.requests.filter((r) => r.startsWith(`GET ${path}`)).length

beforeAll(async () => {
  fake = await startFakeUpstream()
  const config = loadConfig({
    MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017',
    SYNC_ON_START: 'false',
    ADMIN_TOKEN: 'secret',
    HTTP_RETRIES: '0',
  })
  config.upstreams = fake.upstreams
  ctx = await createContext(config, createLogger('silent'), `haru_api_test_${process.pid}_${Date.now()}`)
  const runner = new SyncRunner(ctx)
  app = buildApp(ctx, runner)
  for (const task of ALL_SYNC_TASKS) await runner.run(task)
}, 60_000)

afterAll(async () => {
  await app?.close()
  await ctx?.db.db.dropDatabase()
  if (ctx) await closeContext(ctx)
  await fake?.close()
})

describe('mojang', () => {
  it('serves the version manifests verbatim', async () => {
    for (const name of ['version_manifest.json', 'version_manifest_v2.json']) {
      const res = await get(`/mc/game/${name}`)
      expect(res.statusCode).toBe(200)
      expect(res.rawPayload.equals(fake.routes.get(`/piston-meta/mc/game/${name}`)!.body)).toBe(true)
    }
  })

  it('serves version JSONs with the sha1 from the manifest', async () => {
    const manifest = JSON.parse(fake.routes.get('/piston-meta/mc/game/version_manifest_v2.json')!.body.toString())
    for (const v of manifest.versions) {
      const res = await get(`/version/${v.id}/json`)
      expect(res.statusCode).toBe(200)
      expect(sha1(res.rawPayload)).toBe(v.sha1)
      expect(res.headers['x-bmclapi-hash']).toBe(v.sha1)
      expect((await get(new URL(v.url).pathname)).rawPayload.equals(res.rawPayload)).toBe(true)
      expect((await get(`/versions/${v.id}/${v.id}.json`)).statusCode).toBe(200)
    }
    expect((await get('/version/nope/json')).statusCode).toBe(404)
  })

  it('serves asset indexes stored by the sync', async () => {
    const v = JSON.parse((await get('/version/1.20.1/json')).body)
    const hits = upstreamHits(`/piston-meta${new URL(v.assetIndex.url).pathname}`)
    const res = await get(new URL(v.assetIndex.url).pathname)
    expect(res.statusCode).toBe(200)
    expect(sha1(res.rawPayload)).toBe(v.assetIndex.sha1)
    expect(upstreamHits(`/piston-meta${new URL(v.assetIndex.url).pathname}`)).toBe(hits)

    const rd = JSON.parse((await get('/version/rd-132211/json')).body)
    expect(sha1((await get(new URL(rd.assetIndex.url).pathname)).rawPayload)).toBe(rd.assetIndex.sha1)
  })

  it('downloads the client jar once and then serves it from GridFS', async () => {
    const v = JSON.parse((await get('/version/1.20.1/json')).body)
    const path = `/piston-data${new URL(v.downloads.client.url).pathname}`
    const first = await get('/version/1.20.1/client')
    expect(first.statusCode).toBe(200)
    expect(first.rawPayload.equals(fake.routes.get(path)!.body)).toBe(true)
    await new Promise((r) => setTimeout(r, 200))

    const second = await get('/version/1.20.1/client')
    expect(second.rawPayload.equals(first.rawPayload)).toBe(true)
    expect(second.headers['x-bmclapi-hash']).toBe(v.downloads.client.sha1)
    expect(upstreamHits(path)).toBe(1)

    const part = await get('/version/1.20.1/client', { range: 'bytes=5-10' })
    expect(part.statusCode).toBe(206)
    expect(part.headers['content-range']).toBe(`bytes 5-10/${first.rawPayload.length}`)
    expect(part.rawPayload.equals(first.rawPayload.subarray(5, 11))).toBe(true)

    expect((await get(new URL(v.downloads.client.url).pathname)).rawPayload.equals(first.rawPayload)).toBe(true)
    expect(upstreamHits(path)).toBe(1)
  })

  it('serves assets and libraries', async () => {
    const asset = [...fake.routes.keys()].find((k) => k.startsWith('/resources/'))!
    const res = await get(`/assets${asset.slice('/resources'.length)}`)
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.equals(fake.routes.get(asset)!.body)).toBe(true)
    expect((await get('/assets/zz/not-a-hash')).statusCode).toBe(404)

    const lib = await get('/libraries/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar')
    expect(lib.statusCode).toBe(200)
    expect(lib.body).toBe('fake lwjgl')
    expect((await get('/libraries/org/lwjgl/missing.jar')).statusCode).toBe(404)
  })

  it('serves the java runtime index and manifests', async () => {
    const res = await get('/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json')
    expect(res.statusCode).toBe(200)
    const manifest = JSON.parse(res.body).linux['java-runtime-gamma'][0].manifest
    expect(sha1((await get(new URL(manifest.url).pathname)).rawPayload)).toBe(manifest.sha1)
  })
})

describe('forge', () => {
  it('lists minecraft versions', async () => {
    expect((await get('/forge/minecraft')).json()).toEqual(['1.1', '1.7.10_pre4', '1.7.10', '1.12.2', '1.20.1'])
  })

  it('lists builds for a minecraft version', async () => {
    const [b] = (await get('/forge/minecraft/1.20.1')).json()
    expect(b).toMatchObject({ __v: 0, mcversion: '1.20.1', version: '47.2.0', branch: null })
    expect(b._id).toMatch(/^[0-9a-f]{24}$/)
    expect(b.build).toBe(47020000)
    expect(b.files).toContainEqual({ format: 'jar', category: 'installer', hash: 'ded43dd18b3a1dd5098b114c28432224d72bd9f7' })
    expect(b.modified).toBe('2023-09-21T10:54:04.000Z')

    const [legacy] = (await get('/forge/minecraft/1.7.10')).json()
    expect(legacy).toMatchObject({ build: 1614, version: '10.13.4.1614', branch: '1.7.10' })
    expect((await get('/forge/minecraft/1.7.10_pre4')).json()[0]).toMatchObject({ build: 1149, branch: 'prerelease' })
  })

  it('lists, pages and promotes builds', async () => {
    const page = (await get('/forge/list/0/2')).json()
    expect(page).toHaveLength(2)
    expect(page[0].build).toBeGreaterThan(page[1].build)
    expect((await get('/forge/last')).json()).toMatchObject({ version: '47.2.0' })

    const promos = (await get('/forge/promos')).json()
    expect(promos).toContainEqual(expect.objectContaining({ name: '1.20.1-recommended', build: expect.objectContaining({ version: '47.2.0' }) }))
    expect(promos).toContainEqual(expect.objectContaining({ name: '1.12.2-recommended', build: expect.objectContaining({ build: 2847 }) }))
  })

  it('downloads by build and by version', async () => {
    const byBuild = await get('/forge/download/1614')
    expect(byBuild.statusCode).toBe(200)
    expect(byBuild.body).toBe('fake forge 1.7.10-10.13.4.1614-1.7.10 installer')
    expect((await get('/forge/download/1')).body).toBe('fake forge 1.1-1.3.2.1 client')

    const byVersion = await get('/forge/download?mcversion=1.20.1&version=47.2.0&category=installer&format=jar')
    expect(byVersion.body).toBe('fake forge 1.20.1-47.2.0 installer')
    expect(byVersion.headers['content-disposition']).toContain('forge-1.20.1-47.2.0-installer.jar')
    const branch = await get('/forge/download?mcversion=1.7.10&version=10.13.4.1614&branch=1.7.10&category=universal&format=jar')
    expect(branch.body).toBe('fake forge 1.7.10-10.13.4.1614-1.7.10 universal')

    expect((await get('/forge/download/999999')).statusCode).toBe(404)
    expect((await get('/forge/download?mcversion=1.20.1')).statusCode).toBe(400)
  })
})

describe('neoforge', () => {
  it('lists versions by minecraft version', async () => {
    expect((await get('/neoforge/list/1.20.4')).json()).toEqual([
      expect.objectContaining({
        rawVersion: '20.4.237',
        version: '20.4.237',
        mcversion: '1.20.4',
        installerPath: '/maven/net/neoforged/neoforge/20.4.237/neoforge-20.4.237-installer.jar',
      }),
    ])
    expect((await get('/neoforge/list/1.20.1')).json()).toEqual([
      expect.objectContaining({ rawVersion: '1.20.1-47.1.100', version: '47.1.100', mcversion: '1.20.1' }),
    ])
    expect((await get('/neoforge/list/1.21')).json()).toHaveLength(1)
    expect((await get('/neoforge/list/25w14craftmine')).json()).toHaveLength(1)
    expect((await get('/neoforge/list/26.1-snapshot-1')).json()).toHaveLength(1)
  })

  it('downloads installers', async () => {
    expect((await get('/neoforge/version/20.4.237/download/installer.jar')).body).toBe('fake neoforge 20.4.237 installer')
    expect((await get('/neoforge/version/47.1.100/download/installer.jar')).body).toBe('fake forge 1.20.1-47.1.100 installer')
    expect((await get('/neoforge/version/1.20.1-47.1.100/download/installer.jar')).statusCode).toBe(200)
    expect((await get('/maven/net/neoforged/neoforge/20.4.237/neoforge-20.4.237-installer.jar')).statusCode).toBe(200)
  })

  it('mirrors the maven api', async () => {
    const res = await get('/neoforge/meta/api/maven/details/releases/net/neoforged/neoforge')
    expect(res.statusCode).toBe(200)
    expect(res.json().files).toHaveLength(4)
    expect((await get('/neoforge/meta/api/maven/versions/releases/net/neoforged/forge')).json().versions).toEqual(['1.20.1-47.1.100'])
  })
})

describe('optifine', () => {
  it('lists versions', async () => {
    const list = (await get('/optifine/versionList')).json()
    expect(list).toHaveLength(4)
    expect(list[0]).toMatchObject({
      __v: 0,
      mcversion: '1.20.4',
      type: 'HD_U_I7',
      patch: 'pre3',
      filename: 'preview_OptiFine_1.20.4_HD_U_I7_pre3.jar',
      forge: 'Forge 49.0.14',
    })
    expect((await get('/optifine/1.20.1')).json()).toEqual([
      expect.objectContaining({ mcversion: '1.20.1', type: 'HD_U', patch: 'I6', filename: 'OptiFine_1.20.1_HD_U_I6.jar', forge: 'Forge 47.2.0' }),
    ])
    expect((await get('/optifine/1.8.0')).json()).toHaveLength(1)
  })

  it('downloads through adloadx and caches the jar', async () => {
    const res = await get('/optifine/1.20.1/HD_U/I6')
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('fake optifine OptiFine_1.20.1_HD_U_I6.jar')
    expect(res.headers['content-disposition']).toContain('OptiFine_1.20.1_HD_U_I6.jar')
    await new Promise((r) => setTimeout(r, 200))
    const adloadx = upstreamHits('/optifine/adloadx')
    expect((await get('/optifine/1.20.1/HD_U/I6')).body).toBe('fake optifine OptiFine_1.20.1_HD_U_I6.jar')
    expect(upstreamHits('/optifine/adloadx')).toBe(adloadx)

    const preview = await get('/optifine/1.20.4/HD_U_I7/pre3')
    expect(preview.body).toBe('fake optifine preview_OptiFine_1.20.4_HD_U_I7_pre3.jar')
    expect((await get('/maven/com/optifine/preview_1.20.4/OptiFine_1.20.4_HD_U_I7_pre3.jar')).body).toBe(preview.body)
    expect((await get('/optifine/1.20.1/HD_U/Z9')).statusCode).toBe(404)

    // a version optifine.net no longer has, added by hand: downloadx answers it with a "File not found" page
    const now = new Date()
    await ctx.db.optifine.insertOne({
      _id: new ObjectId(),
      __v: 0,
      mcversion: '1.14',
      type: 'HD_U_F1',
      patch: 'pre6',
      filename: 'preview_OptiFine_1.14_HD_U_F1_pre6.jar',
      forge: 'Forge N/A',
      date: null,
      preview: true,
      order: 1_000_000,
      createdAt: now,
      updatedAt: now,
    })
    expect((await get('/optifine/1.14/HD_U_F1/pre6')).statusCode).toBe(404)
    expect(await ctx.files.find('optifine/preview_OptiFine_1.14_HD_U_F1_pre6.jar')).toBeNull()
  })

  it('keeps versions no longer listed on the downloads page', async () => {
    const page = fake.routes.get('/optifine/downloads')!
    fake.routes.set('/optifine/downloads', { ...page, body: Buffer.from(page.body.toString().replace(/<h2>Minecraft 1\.8\.0<\/h2>[\s\S]*?<\/table>/, '')) })
    await new SyncRunner(ctx).run('optifine')
    fake.routes.set('/optifine/downloads', page)
    expect((await get('/optifine/1.8.0')).json()).toHaveLength(1)
  })
})

describe('liteloader', () => {
  it('lists versions', async () => {
    const all = (await get('/liteloader/list')).json()
    expect(all.length).toBeGreaterThan(3)
    const one = (await get('/liteloader/list?mcversion=1.12.2')).json()
    expect(one).toMatchObject({
      __v: 0,
      mcversion: '1.12.2',
      version: '1.12.2-SNAPSHOT',
      type: 'SNAPSHOT',
      hash: '1420785ecbfed5aff4a586c5c9dd97eb',
      build: { tweakClass: 'com.mumfrey.liteloader.launch.LiteLoaderTweaker', file: 'liteloader-1.12.2-SNAPSHOT.jar' },
    })
    expect((await get('/liteloader/list?mcversion=1.99')).statusCode).toBe(404)
  })

  it('downloads jars and mirrors versions.json', async () => {
    expect((await get('/liteloader/download?version=1.12.2-SNAPSHOT')).body).toBe('fake liteloader 1.12.2-SNAPSHOT')
    expect((await get('/liteloader/download?version=1.7.10_04')).body).toBe('fake liteloader 1.7.10_04')
    const index = await get('/maven/com/mumfrey/liteloader/versions.json')
    expect(index.rawPayload.equals(read('liteloader/versions.json'))).toBe(true)
  })
})

describe('pass-through mirrors', () => {
  it('serves maven artifacts from the right repository', async () => {
    expect((await get('/maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar')).body).toBe(
      'fake forge 1.20.1-47.2.0 installer',
    )
    expect((await get('/maven/net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar')).body).toBe('fake fabric loader')
    expect((await get('/maven/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar')).body).toBe('fake lwjgl')
    expect((await get('/maven/../../etc/passwd')).statusCode).toBe(404)
  })

  it('serves fabric meta, fetching uncached paths once', async () => {
    expect((await get('/fabric-meta/v2/versions/loader')).rawPayload.equals(read('fabric/loader.json'))).toBe(true)
    const path = '/fabric-meta/v2/versions/loader/1.20.1/0.15.11/profile/json'
    expect((await get(path)).json()).toMatchObject({ id: 'fabric-loader-0.15.11-1.20.1' })
    expect((await get(path)).statusCode).toBe(200)
    expect(upstreamHits(path)).toBe(1)
    expect((await get('/fabric-meta/v2/versions/loader/9.9/9.9/profile/json')).statusCode).toBe(404)
  })

  it('serves authlib-injector', async () => {
    expect((await get('/mirrors/authlib-injector/artifact/latest.json')).json()).toMatchObject({ build_number: 53 })
    expect((await get('/mirrors/authlib-injector/artifacts.json')).json().artifacts).toHaveLength(2)
    expect((await get('/mirrors/authlib-injector/artifact/53/authlib-injector-1.2.5.jar')).body).toBe('fake authlib-injector 1.2.5')
  })
})

describe('status', () => {
  it('reports every sync task', async () => {
    const status = (await get('/_haru/status')).json()
    expect(status.tasks.map((t: { name: string; status: string }) => [t.name, t.status])).toEqual(
      ALL_SYNC_TASKS.map((t) => [t, 'success']),
    )
    expect(status.counts).toMatchObject({ mojang: 2, forge: 5, neoforge: 5, optifine: 5 })
  })

  it('triggers a sync with the admin token', async () => {
    expect((await app.inject({ method: 'POST', url: '/_haru/sync/forge' })).statusCode).toBe(401)
    const res = await app.inject({ method: 'POST', url: '/_haru/sync/liteloader', headers: { authorization: 'Bearer secret' } })
    expect(res.statusCode).toBe(202)
  })
})
