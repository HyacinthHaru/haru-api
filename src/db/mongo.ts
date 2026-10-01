import { GridFSBucket, MongoClient, type Collection, type Db } from 'mongodb'
import type {
  DocumentEntry,
  ForgeBuildEntry,
  ForgePromoEntry,
  LiteLoaderEntry,
  MojangVersionEntry,
  NeoForgeEntry,
  OptiFineEntry,
  SyncStateEntry,
} from './models.js'

export const FILES_BUCKET = 'files'

export class Database {
  readonly documents: Collection<DocumentEntry>
  readonly mojangVersions: Collection<MojangVersionEntry>
  readonly forgeBuilds: Collection<ForgeBuildEntry>
  readonly forgePromos: Collection<ForgePromoEntry>
  readonly neoforge: Collection<NeoForgeEntry>
  readonly optifine: Collection<OptiFineEntry>
  readonly liteloader: Collection<LiteLoaderEntry>
  readonly syncState: Collection<SyncStateEntry>
  readonly files: GridFSBucket

  private constructor(
    readonly client: MongoClient,
    readonly db: Db,
  ) {
    this.documents = db.collection('documents')
    this.mojangVersions = db.collection('mojang_versions')
    this.forgeBuilds = db.collection('forge_builds')
    this.forgePromos = db.collection('forge_promos')
    this.neoforge = db.collection('neoforge_versions')
    this.optifine = db.collection('optifine_versions')
    this.liteloader = db.collection('liteloader_versions')
    this.syncState = db.collection('sync_state')
    this.files = new GridFSBucket(db, { bucketName: FILES_BUCKET })
  }

  /** Connects to MongoDB; the database name is taken from the URI path (default "haru-api"). */
  static async connect(uri: string, dbName?: string): Promise<Database> {
    const client = new MongoClient(uri, { appName: 'haru-api' })
    await client.connect()
    const fromUri = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(uri)?.[1]
    const db = client.db(dbName ?? (fromUri ? decodeURIComponent(fromUri) : 'haru-api'))
    const database = new Database(client, db)
    await database.ensureIndexes()
    return database
  }

  async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.documents.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: 'date' } } }),
      this.documents.createIndex({ ns: 1, path: 1 }),
      this.mojangVersions.createIndex({ order: 1 }),
      this.forgeBuilds.createIndex({ longVersion: 1 }, { unique: true }),
      this.forgeBuilds.createIndex({ build: 1 }, { unique: true }),
      this.forgeBuilds.createIndex({ mcversion: 1, version: 1 }),
      this.forgeBuilds.createIndex({ modified: -1 }),
      this.neoforge.createIndex({ rawVersion: 1 }, { unique: true }),
      this.neoforge.createIndex({ mcversion: 1, order: 1 }),
      this.neoforge.createIndex({ version: 1 }),
      this.optifine.createIndex({ filename: 1 }, { unique: true }),
      this.optifine.createIndex({ mcversion: 1, type: 1, patch: 1 }),
      this.liteloader.createIndex({ mcversion: 1, version: 1 }, { unique: true }),
      this.liteloader.createIndex({ version: 1 }),
      this.db.collection(`${FILES_BUCKET}.files`).createIndex({ filename: 1, uploadDate: -1 }),
    ])
  }

  async ping(): Promise<boolean> {
    try {
      await this.db.command({ ping: 1 })
      return true
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}
