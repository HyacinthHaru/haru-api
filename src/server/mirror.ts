import { createHash } from 'node:crypto'
import { PassThrough, Writable, pipeline } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AppContext } from '../context.js'
import type { StoredDocument } from '../db/documents.js'
import type { CachedFile } from '../db/files.js'
import { HttpError, header, type StreamResponse } from '../http/client.js'
import { guessContentType } from '../upstream.js'

export interface FileTarget {
  /** cache key (GridFS filename) */
  key: string
  /** upstream URLs tried in order, or a resolver called only when the file is not cached yet */
  urls: string[] | (() => Promise<string[]>)
  /** expected sha1; a download that does not match is not kept */
  sha1?: string | undefined
  /** Content-Disposition file name */
  filename?: string | undefined
}

/** Path after `prefix` (still percent-encoded) and its decoded form; null if it tries to escape. */
export function restPath(req: FastifyRequest, prefix: string): { raw: string; path: string } | null {
  const url = req.url
  const q = url.indexOf('?')
  const pathname = q < 0 ? url : url.slice(0, q)
  if (!pathname.startsWith(prefix)) return null
  const raw = pathname.slice(prefix.length).replace(/^\/+/, '')
  let path: string
  try {
    path = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (!path || path.split('/').some((s) => s === '..' || s === '.') || path.includes('\\')) return null
  return { raw, path }
}

export function queryString(req: FastifyRequest): string {
  const q = req.url.indexOf('?')
  return q < 0 ? '' : req.url.slice(q)
}

export function notFound(reply: FastifyReply, message = 'Not Found'): FastifyReply {
  return reply.code(404).send({ statusCode: 404, error: 'Not Found', message })
}

export function sendDocument(req: FastifyRequest, reply: FastifyReply, doc: StoredDocument): FastifyReply {
  const etag = `"${doc.sha1}"`
  reply
    .header('content-type', doc.contentType)
    .header('etag', etag)
    .header('x-bmclapi-hash', doc.sha1)
    .header('last-modified', doc.lastModified ?? doc.fetchedAt.toUTCString())
    .header('cache-control', 'public, max-age=60')
  if (req.headers['if-none-match'] === etag) return reply.code(304).send()
  return reply.send(doc.body)
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!value) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start > end || start >= size) return 'invalid'
  return { start, end }
}

/**
 * Metadata fetched on demand from upstream and kept in the `documents` collection
 * (documents written by the sync tasks never expire; on-demand ones expire after META_CACHE_TTL).
 */
export class MetaMirror {
  private readonly inflight = new Map<string, Promise<{ doc: StoredDocument | null; status: number }>>()

  constructor(private readonly ctx: AppContext) {}

  async get(ns: string, path: string, urls: string[]): Promise<{ doc: StoredDocument | null; status: number }> {
    const doc = await this.ctx.docs.get(ns, path)
    if (doc && (doc.expiresAt === null || doc.expiresAt > new Date())) return { doc, status: 200 }
    const key = `${ns}:${path}`
    let p = this.inflight.get(key)
    if (!p) {
      p = this.fetch(ns, path, urls, doc).finally(() => this.inflight.delete(key))
      this.inflight.set(key, p)
    }
    return p
  }

  private async fetch(ns: string, path: string, urls: string[], stale: StoredDocument | null) {
    let status = 404
    for (const url of urls) {
      try {
        const res = await this.ctx.http.fetch(url, { accept: [404] })
        if (res.status === 404) continue
        const doc = await this.ctx.docs.put(
          ns,
          path,
          {
            body: res.body,
            contentType: guessContentType(path, header(res.headers, 'content-type')),
            upstreamUrl: url,
            etag: header(res.headers, 'etag'),
            lastModified: header(res.headers, 'last-modified'),
          },
          this.ctx.config.metaCacheTtl,
        )
        return { doc, status: 200 }
      } catch (err) {
        this.ctx.log.warn({ err, url }, 'upstream metadata request failed')
        status = err instanceof HttpError && err.status < 500 ? err.status : 502
      }
    }
    // serve a stale copy rather than failing while upstream is unreachable
    if (stale && status !== 404) return { doc: stale, status: 200 }
    return { doc: null, status }
  }

  async serve(req: FastifyRequest, reply: FastifyReply, ns: string, path: string, urls: string[]): Promise<FastifyReply> {
    const { doc, status } = await this.get(ns, path, urls)
    if (doc) return sendDocument(req, reply, doc)
    if (status === 404) return notFound(reply)
    return reply.code(status).send({ statusCode: status, error: 'Bad Gateway', message: 'upstream request failed' })
  }
}

/** Binary files: served from GridFS, or streamed from upstream while being stored into GridFS. */
export class FileMirror {
  private readonly filling = new Set<string>()

  constructor(private readonly ctx: AppContext) {}

  async serve(req: FastifyRequest, reply: FastifyReply, target: FileTarget): Promise<FastifyReply> {
    const cached = await this.ctx.files.find(target.key)
    if (cached) return this.sendCached(req, reply, cached, target)

    let urls: string[]
    try {
      urls = typeof target.urls === 'function' ? await target.urls() : target.urls
    } catch (err) {
      this.ctx.log.warn({ err, key: target.key }, 'failed to resolve download url')
      return reply.code(502).send({ statusCode: 502, error: 'Bad Gateway', message: 'failed to resolve upstream url' })
    }
    let failed = false
    for (const url of urls) {
      let res: StreamResponse
      try {
        res = await this.ctx.http.open(url)
      } catch (err) {
        this.ctx.log.warn({ err, url }, 'upstream download failed')
        failed = true
        continue
      }
      if (res.status === 200) return this.sendUpstream(reply, res, target)
      await res.body.dump()
      if (res.status !== 404 && res.status !== 403 && res.status !== 410) failed = true
    }
    if (failed) return reply.code(502).send({ statusCode: 502, error: 'Bad Gateway', message: 'upstream request failed' })
    return notFound(reply)
  }

  private sendCached(req: FastifyRequest, reply: FastifyReply, file: CachedFile, target: FileTarget): FastifyReply {
    const meta = file.metadata
    const size = file.length
    const etag = `"${meta?.sha1}"`
    reply
      .header('content-type', meta?.contentType ?? 'application/octet-stream')
      .header('etag', etag)
      .header('x-bmclapi-hash', meta?.sha1 ?? '')
      .header('accept-ranges', 'bytes')
      .header('last-modified', meta?.lastModified ?? file.uploadDate.toUTCString())
      .header('cache-control', 'public, max-age=86400')
    if (target.filename) reply.header('content-disposition', `attachment; filename="${target.filename}"`)
    if (req.headers['if-none-match'] === etag) return reply.code(304).send()
    const range = parseRange(req.headers.range, size)
    if (range === 'invalid') return reply.code(416).header('content-range', `bytes */${size}`).send()
    if (range) {
      return reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${size}`)
        .header('content-length', range.end - range.start + 1)
        .send(this.ctx.files.openDownload(file, range))
    }
    return reply.header('content-length', size).send(this.ctx.files.openDownload(file))
  }

  private sendUpstream(reply: FastifyReply, res: StreamResponse, target: FileTarget): FastifyReply {
    const contentType = guessContentType(target.key, header(res.headers, 'content-type'))
    const lastModified = header(res.headers, 'last-modified')
    const length = header(res.headers, 'content-length')
    reply.code(200).header('content-type', contentType).header('cache-control', 'public, max-age=86400')
    if (length) reply.header('content-length', length)
    if (lastModified) reply.header('last-modified', lastModified)
    if (target.filename) reply.header('content-disposition', `attachment; filename="${target.filename}"`)

    // Another request is already storing this file: just relay.
    if (this.filling.has(target.key)) return reply.send(res.body)
    this.filling.add(target.key)

    const { files, log } = this.ctx
    const upload = files.openUpload(target.key, {
      key: target.key,
      upstreamUrl: res.url,
      contentType,
      ...(lastModified ? { lastModified } : {}),
    })
    upload.on('error', (err) => log.error({ err, key: target.key }, 'gridfs upload error'))
    const hash = createHash('sha1')
    let size = 0
    const client = new PassThrough()
    // Writes every chunk to GridFS and to the client; the download keeps going if the client leaves.
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        hash.update(chunk)
        size += chunk.length
        let pending = 2
        const done = (err?: Error | null) => {
          if (err) {
            pending = -1
            cb(err)
          } else if (--pending === 0) cb()
        }
        upload.write(chunk, (err) => done(err))
        if (client.destroyed || client.write(chunk)) done()
        else {
          const resume = () => {
            client.off('drain', resume)
            client.off('close', resume)
            done()
          }
          client.on('drain', resume)
          client.on('close', resume)
        }
      },
      final(cb) {
        client.end()
        upload.end(() => cb())
      },
    })
    pipeline(res.body, sink, (err) => {
      void (async () => {
        try {
          if (err) {
            client.destroy(err)
            await upload.abort().catch(() => undefined)
            log.warn({ err, key: target.key }, 'download from upstream failed')
            return
          }
          const sha1 = hash.digest('hex')
          if (target.sha1 && target.sha1.toLowerCase() !== sha1) {
            await files.delete(upload.id)
            log.warn({ key: target.key, expected: target.sha1, actual: sha1 }, 'sha1 mismatch, not caching')
            return
          }
          await files.finalize(upload.id, target.key, sha1, size)
        } catch (e) {
          log.error({ err: e, key: target.key }, 'failed to store file')
        } finally {
          this.filling.delete(target.key)
        }
      })()
    })
    return reply.send(client)
  }
}
