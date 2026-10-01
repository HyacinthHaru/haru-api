import type { Db, GridFSBucket, GridFSBucketReadStream, GridFSBucketWriteStream, GridFSFile, ObjectId } from 'mongodb'
import { FILES_BUCKET } from './mongo.js'

export interface FileMetadata {
  key: string
  upstreamUrl: string
  contentType: string
  sha1?: string
  size?: number
  etag?: string
  lastModified?: string
}

export type CachedFile = GridFSFile & { metadata?: FileMetadata }

/** Binary file cache backed by MongoDB GridFS (bucket "files"); the GridFS filename is the cache key. */
export class FileStore {
  constructor(
    private readonly bucket: GridFSBucket,
    private readonly db: Db,
  ) {}

  private get filesCollection() {
    return this.db.collection<CachedFile>(`${FILES_BUCKET}.files`)
  }

  /** Latest complete upload for `key`, or null. */
  async find(key: string): Promise<CachedFile | null> {
    const file = await this.filesCollection.findOne(
      { filename: key, 'metadata.sha1': { $exists: true } },
      { sort: { uploadDate: -1 } },
    )
    return file ?? null
  }

  openDownload(file: CachedFile, range?: { start: number; end: number }): GridFSBucketReadStream {
    // GridFS `end` is exclusive, HTTP ranges are inclusive.
    return this.bucket.openDownloadStream(file._id, range ? { start: range.start, end: range.end + 1 } : undefined)
  }

  openUpload(key: string, metadata: FileMetadata): GridFSBucketWriteStream {
    return this.bucket.openUploadStream(key, { metadata })
  }

  /** Marks an upload complete (sha1/size known) and removes older copies of the same key. */
  async finalize(id: ObjectId, key: string, sha1: string, size: number): Promise<void> {
    await this.filesCollection.updateOne({ _id: id }, { $set: { 'metadata.sha1': sha1, 'metadata.size': size } })
    const stale = await this.filesCollection.find({ filename: key, _id: { $ne: id } }, { projection: { _id: 1 } }).toArray()
    for (const f of stale) await this.delete(f._id)
  }

  async delete(id: ObjectId): Promise<void> {
    try {
      await this.bucket.delete(id)
    } catch {
      // already gone
    }
  }

  async count(): Promise<number> {
    return this.filesCollection.countDocuments({ 'metadata.sha1': { $exists: true } })
  }
}
