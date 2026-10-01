import type { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { EnvHttpProxyAgent, interceptors, request, type Dispatcher } from 'undici'
import { Limiter } from './limiter.js'

export type Headers = Record<string, string | string[] | undefined>

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} for ${url}`)
    this.name = 'HttpError'
  }
}

export interface HttpClientOptions {
  concurrency: number
  timeoutMs: number
  retries: number
  userAgent: string
}

export interface BufferedResponse {
  url: string
  status: number
  headers: Headers
  body: Buffer
}

export interface StreamResponse {
  url: string
  status: number
  headers: Headers
  body: Readable & { dump(): Promise<void> }
}

export interface RequestOptions {
  headers?: Record<string, string>
  /** Statuses that are returned instead of thrown (e.g. [404]). 2xx is always accepted. */
  accept?: number[]
  signal?: AbortSignal
}

export function header(headers: Headers, name: string): string | undefined {
  const v = headers[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524])

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
])

function isRetryableError(err: unknown): boolean {
  if (err instanceof HttpError) return RETRYABLE_STATUS.has(err.status)
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError') return false
  const code = (err as { code?: string }).code ?? (err.cause as { code?: string } | undefined)?.code
  return code !== undefined && RETRYABLE_CODES.has(code)
}

/**
 * HTTP client used for every upstream request.
 * - honours HTTPS_PROXY / HTTP_PROXY / NO_PROXY,
 * - follows redirects,
 * - retries network errors and 408/429/5xx with exponential backoff,
 * - limits concurrency of buffered requests (scraping), not of streamed downloads.
 */
export class HttpClient {
  readonly dispatcher: Dispatcher
  private readonly limiter: Limiter

  constructor(private readonly opts: HttpClientOptions) {
    const agent = new EnvHttpProxyAgent({
      headersTimeout: opts.timeoutMs,
      bodyTimeout: opts.timeoutMs,
      connect: { timeout: Math.min(opts.timeoutMs, 30_000) },
    })
    this.dispatcher = agent.compose(interceptors.redirect({ maxRedirections: 8 }))
    this.limiter = new Limiter(opts.concurrency)
  }

  private baseHeaders(extra?: Record<string, string>): Record<string, string> {
    return { 'user-agent': this.opts.userAgent, accept: '*/*', ...extra }
  }

  private async withRetry<T>(url: string, fn: () => Promise<T>): Promise<T> {
    let attempt = 0
    for (;;) {
      try {
        return await fn()
      } catch (err) {
        if (attempt >= this.opts.retries || !isRetryableError(err)) throw err
        const delay = Math.min(500 * 2 ** attempt, 15_000) + Math.floor(Math.random() * 250)
        attempt++
        await sleep(delay)
      }
    }
  }

  /** GET (or HEAD) and buffer the whole body. Throws HttpError on non-accepted statuses. */
  async fetch(url: string, opts: RequestOptions & { method?: 'GET' | 'HEAD' } = {}): Promise<BufferedResponse> {
    return this.limiter.run(() =>
      this.withRetry(url, async () => {
        const res = await request(url, {
          method: opts.method ?? 'GET',
          headers: this.baseHeaders(opts.headers),
          dispatcher: this.dispatcher,
          signal: opts.signal,
        })
        const ok = res.statusCode >= 200 && res.statusCode < 300
        if (!ok && !(opts.accept ?? []).includes(res.statusCode)) {
          await res.body.dump()
          throw new HttpError(url, res.statusCode)
        }
        const body = opts.method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await res.body.arrayBuffer())
        if (opts.method === 'HEAD') await res.body.dump()
        return { url, status: res.statusCode, headers: res.headers as Headers, body }
      }),
    )
  }

  async getText(url: string, opts?: RequestOptions): Promise<string> {
    return (await this.fetch(url, opts)).body.toString('utf8')
  }

  async head(url: string, opts?: RequestOptions): Promise<BufferedResponse> {
    return this.fetch(url, { ...opts, method: 'HEAD' })
  }

  /**
   * Open a streaming GET. Connection errors / retryable statuses are retried before any byte
   * is handed to the caller; the caller must consume or dump() the body.
   * Non-2xx responses are returned as-is (body already dumped) so callers can try the next mirror.
   */
  async open(url: string, opts: RequestOptions & { method?: 'GET' | 'HEAD' } = {}): Promise<StreamResponse> {
    return this.withRetry(url, async () => {
      const res = await request(url, {
        method: opts.method ?? 'GET',
        headers: this.baseHeaders(opts.headers),
        dispatcher: this.dispatcher,
        signal: opts.signal,
      })
      if (RETRYABLE_STATUS.has(res.statusCode)) {
        await res.body.dump()
        throw new HttpError(url, res.statusCode)
      }
      return { url, status: res.statusCode, headers: res.headers as Headers, body: res.body }
    })
  }

  async close(): Promise<void> {
    await this.dispatcher.close()
  }
}
