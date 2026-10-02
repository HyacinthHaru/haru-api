/**
 * Adds the OptiFine versions optifine.net no longer has (older previews) from BMCLAPI's version list;
 * versions already stored are left as they are. Run by hand when needed:
 *   npm run import-optifine-history [-- --bmclapi=https://bmclapi2.bangbang93.com]
 */
import { existsSync } from 'node:fs'
import { ObjectId, type AnyBulkWriteOperation } from 'mongodb'
import { loadConfig } from '../src/config.js'
import { closeContext, createContext } from '../src/context.js'
import type { OptiFineEntry } from '../src/db/models.js'
import { createLogger } from '../src/logger.js'
import { parseOptiFineFilename } from '../src/parsers/optifine.js'

if (existsSync('.env')) process.loadEnvFile('.env')

const origin = (process.argv.find((a) => a.startsWith('--bmclapi='))?.slice('--bmclapi='.length) ?? 'https://bmclapi2.bangbang93.com').replace(/\/+$/, '')
const config = loadConfig()
const ctx = await createContext(config, createLogger(config.logLevel))

const list = JSON.parse(await ctx.http.getText(`${origin}/optifine/versionList`)) as { filename?: unknown; forge?: unknown }[]
const now = new Date()
const ops: AnyBulkWriteOperation<OptiFineEntry>[] = []
for (const [i, e] of list.entries()) {
  if (typeof e.filename !== 'string') continue
  const parsed = parseOptiFineFilename(e.filename)
  if (!parsed) continue
  ops.push({
    updateOne: {
      filter: { filename: e.filename },
      update: {
        $setOnInsert: {
          _id: new ObjectId(),
          __v: 0,
          mcversion: parsed.mcversion,
          type: parsed.type,
          patch: parsed.patch,
          preview: parsed.preview,
          ...(typeof e.forge === 'string' ? { forge: e.forge } : {}),
          date: null,
          // after the versions listed on optifine.net
          order: 1_000_000 + i,
          createdAt: now,
          updatedAt: now,
        },
      },
      upsert: true,
    },
  })
}
const result = ops.length ? await ctx.db.optifine.bulkWrite(ops, { ordered: false }) : null
console.log(`${result?.upsertedCount ?? 0} of ${ops.length} versions added`)
await closeContext(ctx)
