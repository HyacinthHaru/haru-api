import type { Config } from './config.js'
import { DocumentStore } from './db/documents.js'
import { FileStore } from './db/files.js'
import { Database } from './db/mongo.js'
import { HttpClient } from './http/client.js'
import type { Logger } from './logger.js'

export interface AppContext {
  config: Config
  log: Logger
  db: Database
  docs: DocumentStore
  files: FileStore
  http: HttpClient
}

export async function createContext(config: Config, log: Logger, dbName?: string): Promise<AppContext> {
  const db = await Database.connect(config.mongoUri, dbName)
  return {
    config,
    log,
    db,
    docs: new DocumentStore(db.documents),
    files: new FileStore(db.files, db.db),
    http: new HttpClient(config.http),
  }
}

export async function closeContext(ctx: AppContext): Promise<void> {
  await Promise.allSettled([ctx.http.close(), ctx.db.close()])
}
