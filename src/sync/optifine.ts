import { ObjectId, type AnyBulkWriteOperation } from 'mongodb'
import type { OptiFineEntry } from '../db/models.js'
import { parseOptiFineDownloads, parseOptiFineFilename } from '../parsers/optifine.js'
import { UpstreamFormatError, type SyncFn } from './types.js'

/** OptiFine, scraped from https://optifine.net/downloads (all versions, previews included). */
export const syncOptiFine: SyncFn = async (ctx) => {
  const { http, db, config } = ctx
  const html = await http.getText(`${config.upstreams.optifine}/downloads`, { headers: { accept: 'text/html' } })
  const rows = parseOptiFineDownloads(html)
  if (rows.length === 0) throw new UpstreamFormatError('no versions found on optifine.net/downloads')

  const now = new Date()
  const ops: AnyBulkWriteOperation<OptiFineEntry>[] = []
  for (const [order, row] of rows.entries()) {
    const parsed = parseOptiFineFilename(row.filename)
    if (!parsed) continue
    ops.push({
      updateOne: {
        filter: { filename: row.filename },
        update: {
          $set: {
            mcversion: parsed.mcversion,
            type: parsed.type,
            patch: parsed.patch,
            preview: parsed.preview,
            forge: row.forge,
            date: row.date,
            order,
            updatedAt: now,
          },
          $setOnInsert: { _id: new ObjectId(), __v: 0, createdAt: now },
        },
        upsert: true,
      },
    })
  }
  const result = await db.optifine.bulkWrite(ops, { ordered: false })
  const removed = await db.optifine.deleteMany({ filename: { $nin: rows.map((r) => r.filename) } })
  return { versions: ops.length, added: result.upsertedCount, removed: removed.deletedCount }
}
