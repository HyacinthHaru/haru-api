import { ObjectId, type AnyBulkWriteOperation } from 'mongodb'
import type { LiteLoaderEntry } from '../db/models.js'
import { parseLiteLoaderVersions } from '../parsers/liteloader.js'
import { storedDoc } from './mojang.js'
import { UpstreamFormatError, type SyncFn } from './types.js'

export const LITELOADER_NS = 'liteloader'
export const LITELOADER_VERSIONS_PATH = '/versions/versions.json'

/** LiteLoader, from https://dl.liteloader.com/versions/versions.json. */
export const syncLiteLoader: SyncFn = async (ctx) => {
  const { http, docs, db, config } = ctx
  const res = await http.fetch(`${config.upstreams.liteloader}${LITELOADER_VERSIONS_PATH}`)
  const rows = parseLiteLoaderVersions(JSON.parse(res.body.toString('utf8')))
  if (rows.length === 0) throw new UpstreamFormatError('no versions in liteloader versions.json')
  await docs.put(LITELOADER_NS, LITELOADER_VERSIONS_PATH, storedDoc(res), null)

  const now = new Date()
  const ops: AnyBulkWriteOperation<LiteLoaderEntry>[] = rows.map((row) => ({
    updateOne: {
      filter: { mcversion: row.mcversion, version: row.version },
      update: {
        $set: { type: row.type, hash: row.hash, build: row.build, timestamp: row.timestamp, updatedAt: now },
        $setOnInsert: { _id: new ObjectId(), __v: 0, createdAt: now },
      },
      upsert: true,
    },
  }))
  const result = await db.liteloader.bulkWrite(ops, { ordered: false })
  return { versions: rows.length, added: result.upsertedCount }
}
