import type { AppContext } from '../context.js'
import type { Logger } from '../logger.js'

export type SyncStats = Record<string, number | string>

export type SyncFn = (ctx: AppContext, log: Logger) => Promise<SyncStats>

/** Thrown when upstream answered but the payload does not look like what we expect. */
export class UpstreamFormatError extends Error {
  override name = 'UpstreamFormatError'
}
