import type { ForgeFile } from '../db/models.js'

export interface ParsedForgeVersion {
  /** Minecraft version as Forge names it (e.g. "1.7.10_pre4") */
  mcversion: string
  /** Forge version without Minecraft version and branch (e.g. "10.13.4.1614") */
  version: string
  /** last numeric component of `version` */
  lastComponent: number
  branch: string | null
  /** true for the 4-component versions whose last component is a global Jenkins build number */
  legacy: boolean
}

const REST_RE = /^(?<ver>\d+(?:\.\d+)*\.(?<build>\d+))(?:-(?<branch>[a-zA-Z0-9._]+))?$/
const LONG_RE = /^(?<mc>[0-9a-zA-Z_.]+)-(?<rest>.+)$/

/**
 * Parses a Forge maven version such as "1.20.1-47.2.0", "1.7.10-10.13.4.1614-1.7.10" or
 * "1.7.10_pre4-10.12.2.1149-prerelease". `mcKey` is the key from maven-metadata.json, which is
 * authoritative for the Minecraft part.
 */
export function parseForgeLongVersion(longVersion: string, mcKey?: string): ParsedForgeVersion | null {
  let mc: string | undefined
  let rest: string | undefined
  if (mcKey && longVersion.startsWith(`${mcKey}-`)) {
    mc = mcKey
    rest = longVersion.slice(mcKey.length + 1)
  } else {
    const m = LONG_RE.exec(longVersion)
    mc = m?.groups?.mc
    rest = m?.groups?.rest
  }
  if (!mc || !rest) return null
  const m = REST_RE.exec(rest)
  if (!m?.groups) return null
  const version = m.groups.ver as string
  return {
    mcversion: mc,
    version,
    lastComponent: Number(m.groups.build),
    branch: m.groups.branch ?? null,
    legacy: version.split('.').length >= 4,
  }
}

/** Forge `meta.json`: { classifiers: { installer: { jar: "<md5>" }, ... } } -> BMCLAPI `files` */
export function forgeFilesFromMeta(meta: unknown): ForgeFile[] {
  const classifiers = (meta as { classifiers?: Record<string, Record<string, unknown>> } | null)?.classifiers
  if (!classifiers || typeof classifiers !== 'object') return []
  const files: ForgeFile[] = []
  for (const [category, exts] of Object.entries(classifiers)) {
    if (!exts || typeof exts !== 'object') continue
    for (const [format, hash] of Object.entries(exts)) {
      files.push({ format, category, hash: typeof hash === 'string' ? hash.replace(/\W/g, '') : '' })
    }
  }
  return files
}

/** maven directory + file name of a Forge artifact: net/minecraftforge/forge/<lv>/forge-<lv>-<category>.<format> */
export function forgeArtifactPath(longVersion: string, category: string, format: string): string {
  return `net/minecraftforge/forge/${longVersion}/forge-${longVersion}-${category}.${format}`
}

/** Preferred file for "download this build": installer jar, then universal, then client zip. */
export function preferredForgeFile(files: ForgeFile[]): ForgeFile | undefined {
  const pick = (category: string, format?: string) =>
    files.find((f) => f.category === category && (format === undefined || f.format === format))
  return pick('installer', 'jar') ?? pick('universal', 'jar') ?? pick('universal', 'zip') ?? pick('universal') ?? pick('client', 'zip') ?? pick('client')
}

export interface ParsedPromo {
  name: string
  mcversion: string
  promo: 'latest' | 'recommended'
  branch: string | null
}

const PROMO_RE = /^(?<mc>.+?)-(?<promo>latest|recommended)(?:-(?<branch>.+))?$/

export function parsePromoKey(name: string): ParsedPromo | null {
  const m = PROMO_RE.exec(name)
  if (!m?.groups) return null
  return {
    name,
    mcversion: m.groups.mc as string,
    promo: m.groups.promo as 'latest' | 'recommended',
    branch: m.groups.branch ?? null,
  }
}
