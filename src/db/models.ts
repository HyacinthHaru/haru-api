import type { Binary, ObjectId } from 'mongodb'
import type { SyncTaskName } from '../config.js'

/**
 * Raw upstream document (JSON/XML/HTML/zip...) stored byte-for-byte, so that hashes published
 * by upstream (e.g. the sha1 of a version JSON in version_manifest_v2.json) keep matching.
 */
export interface DocumentEntry {
  /** `${ns}:${path}` */
  _id: string
  ns: string
  /** Path (with query string, if any) relative to the namespace's mount point. */
  path: string
  body: Binary
  contentType: string
  sha1: string
  size: number
  etag?: string | undefined
  lastModified?: string | undefined
  upstreamUrl: string
  fetchedAt: Date
  /** null for documents maintained by the sync tasks, a date for on-demand cache entries (TTL index). */
  expiresAt: Date | null
}

export interface MojangVersionEntry {
  /** version id, e.g. "1.20.1" */
  _id: string
  type: string
  url: string
  time: string
  releaseTime: string
  sha1: string
  complianceLevel?: number | undefined
  /** position in version_manifest_v2.json (0 = newest) */
  order: number
  /** key of the raw version JSON in `documents` */
  docKey: string
  assetIndex?: { id: string; sha1: string; size?: number; totalSize?: number; url: string } | undefined
  downloads?: Record<string, { sha1: string; size: number; url: string }> | undefined
  javaVersion?: { component: string; majorVersion: number } | undefined
  updatedAt: Date
}

export interface ForgeFile {
  format: string
  category: string
  hash: string
}

/** Same shape as BMCLAPI's forge collection (Mongoose: `_id`, `__v`). */
export interface ForgeBuildEntry {
  _id: ObjectId
  __v: number
  build: number
  mcversion: string
  version: string
  branch: string | null
  modified: Date | null
  files: ForgeFile[]
  /** maven version, e.g. "1.7.10-10.13.4.1614-1.7.10" */
  longVersion: string
  createdAt: Date
  updatedAt: Date
}

export interface ForgePromoEntry {
  /** promo name, e.g. "1.20.1-recommended" */
  _id: string
  mcversion: string
  /** short forge version the promo points at, e.g. "47.1.0" */
  version: string
  updatedAt: Date
}

export interface NeoForgeEntry {
  _id: ObjectId
  __v: number
  /** maven version, e.g. "20.4.237" or "1.20.1-47.1.99" */
  rawVersion: string
  /** normalized version, e.g. "20.4.237" or "47.1.99" */
  version: string
  mcversion: string
  installerPath: string
  artifact: 'neoforge' | 'forge'
  /** position in the upstream version list */
  order: number
  createdAt: Date
  updatedAt: Date
}

export interface OptiFineEntry {
  _id: ObjectId
  __v: number
  mcversion: string
  type: string
  patch: string
  filename: string
  /** missing for some older previews imported from BMCLAPI */
  forge?: string
  /** release date as shown on optifine.net (dd.mm.yyyy), not part of the BMCLAPI output */
  date: string | null
  preview: boolean
  /** position on optifine.net/downloads (0 = top) */
  order: number
  createdAt: Date
  updatedAt: Date
}

export interface LiteLoaderEntry {
  _id: ObjectId
  __v: number
  mcversion: string
  version: string
  /** "RELEASE" | "SNAPSHOT" */
  type: string
  /** md5 of the jar */
  hash: string
  /** the raw entry from versions.json */
  build: Record<string, unknown>
  timestamp: number
  createdAt: Date
  updatedAt: Date
}

export interface SyncStateEntry {
  _id: SyncTaskName
  status: 'running' | 'success' | 'failed'
  lastStartedAt?: Date
  lastFinishedAt?: Date
  lastSuccessAt?: Date
  lastError?: string | null
  lastDurationMs?: number
  stats?: Record<string, number | string>
}
