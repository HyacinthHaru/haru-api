import { createHash } from 'node:crypto'
import { Binary, type Collection } from 'mongodb'
import type { DocumentEntry } from './models.js'

export interface StoredDocument {
  key: string
  ns: string
  path: string
  body: Buffer
  contentType: string
  sha1: string
  size: number
  etag?: string | undefined
  lastModified?: string | undefined
  upstreamUrl: string
  fetchedAt: Date
  expiresAt: Date | null
}

export interface PutDocument {
  body: Buffer
  contentType: string
  upstreamUrl: string
  etag?: string | undefined
  lastModified?: string | undefined
}

export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex')
}

export function docKey(ns: string, path: string): string {
  return `${ns}:${path}`
}

function toStored(entry: DocumentEntry): StoredDocument {
  return {
    key: entry._id,
    ns: entry.ns,
    path: entry.path,
    body: Buffer.from(entry.body.buffer.subarray(0, entry.body.position)),
    contentType: entry.contentType,
    sha1: entry.sha1,
    size: entry.size,
    etag: entry.etag,
    lastModified: entry.lastModified,
    upstreamUrl: entry.upstreamUrl,
    fetchedAt: entry.fetchedAt,
    expiresAt: entry.expiresAt,
  }
}

/** Raw upstream documents (metadata), stored byte-for-byte in the `documents` collection. */
export class DocumentStore {
  constructor(private readonly col: Collection<DocumentEntry>) {}

  async get(ns: string, path: string): Promise<StoredDocument | null> {
    const entry = await this.col.findOne({ _id: docKey(ns, path) })
    return entry ? toStored(entry) : null
  }

  async exists(ns: string, path: string): Promise<boolean> {
    return (await this.col.countDocuments({ _id: docKey(ns, path) }, { limit: 1 })) > 0
  }

  /**
   * Insert or replace a document.
   * @param ttlSeconds null = maintained by a sync task (never expires); number = on-demand cache entry.
   */
  async put(ns: string, path: string, doc: PutDocument, ttlSeconds: number | null): Promise<StoredDocument> {
    const now = new Date()
    const entry: DocumentEntry = {
      _id: docKey(ns, path),
      ns,
      path,
      body: new Binary(doc.body),
      contentType: doc.contentType,
      sha1: sha1Hex(doc.body),
      size: doc.body.length,
      etag: doc.etag,
      lastModified: doc.lastModified,
      upstreamUrl: doc.upstreamUrl,
      fetchedAt: now,
      expiresAt: ttlSeconds === null ? null : new Date(now.getTime() + ttlSeconds * 1000),
    }
    await this.col.replaceOne({ _id: entry._id }, entry, { upsert: true })
    return toStored(entry)
  }
}
