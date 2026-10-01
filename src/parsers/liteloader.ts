export interface LiteLoaderRow {
  mcversion: string
  version: string
  /** "RELEASE" | "SNAPSHOT" */
  type: string
  /** md5 of the jar */
  hash: string
  /** raw entry from versions.json (tweakClass, libraries, stream, file, version, md5, timestamp, ...) */
  build: Record<string, unknown>
  timestamp: number
}

type ArtefactGroup = Record<string, Record<string, unknown>>

/**
 * Flattens https://dl.liteloader.com/versions/versions.json:
 *   versions.<mc>.{artefacts|snapshots}["com.mumfrey:liteloader"].<md5|latest> = entry
 * One row per (mcversion, version); the "latest" alias is folded into the entry it points to.
 */
export function parseLiteLoaderVersions(json: unknown): LiteLoaderRow[] {
  const versions = (json as { versions?: Record<string, Record<string, unknown>> } | null)?.versions
  if (!versions || typeof versions !== 'object') return []
  const rows = new Map<string, LiteLoaderRow>()
  for (const [mc, info] of Object.entries(versions)) {
    for (const [groupName, defaultType] of [
      ['artefacts', 'RELEASE'],
      ['snapshots', 'SNAPSHOT'],
    ] as const) {
      const group = (info?.[groupName] as Record<string, unknown> | undefined)?.['com.mumfrey:liteloader'] as
        | ArtefactGroup
        | undefined
      if (!group || typeof group !== 'object') continue
      const entries = Object.entries(group).sort(([a], [b]) => (a === 'latest' ? 1 : b === 'latest' ? -1 : 0))
      for (const [, entry] of entries) {
        if (!entry || typeof entry !== 'object') continue
        const version = typeof entry.version === 'string' ? entry.version : undefined
        if (!version) continue
        const key = `${mc}\u0000${version}`
        if (rows.has(key)) continue
        const md5 = typeof entry.md5 === 'string' ? entry.md5 : ''
        const ts = Number(entry.timestamp)
        rows.set(key, {
          mcversion: mc,
          version,
          type: typeof entry.stream === 'string' ? entry.stream : defaultType,
          hash: md5,
          build: entry,
          timestamp: Number.isFinite(ts) ? ts : 0,
        })
      }
    }
  }
  return [...rows.values()]
}

/** Candidate download URLs (relative to https://dl.liteloader.com) for a LiteLoader jar, best first. */
export function liteloaderJarPaths(row: Pick<LiteLoaderRow, 'mcversion' | 'version' | 'build'>): string[] {
  const file = typeof row.build.file === 'string' ? row.build.file : `liteloader-${row.version}.jar`
  return [
    `/versions/com/mumfrey/liteloader/${row.version}/${file}`,
    `/versions/com/mumfrey/liteloader/${row.mcversion}/${file}`,
    `/repo/com/mumfrey/liteloader/${row.version}/liteloader-${row.version}.jar`,
  ]
}
