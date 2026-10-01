export type NeoForgeArtifact = 'neoforge' | 'forge'

export interface ParsedNeoForgeVersion {
  artifact: NeoForgeArtifact
  /** maven version */
  rawVersion: string
  /** version without the "1.20.1-" prefix of the legacy artifact */
  version: string
  mcversion: string
}

/**
 * Minecraft version of a `net.neoforged:neoforge` version:
 *  - "20.4.237" -> "1.20.4", "21.0.0-beta" -> "1.21"
 *  - "0.25w14craftmine.3-beta" -> "25w14craftmine" (snapshot builds)
 *  - "26.1.0.0-alpha.1+snapshot-1" -> "26.1-snapshot-1", "26.1.1.5" -> "26.1.1" (year-based versions)
 */
export function neoforgeMcVersion(version: string): string | null {
  const main = version.split('-')[0] ?? ''
  const parts = main.split('.')
  if (parts.length < 3) return null
  const major = Number(parts[0])
  if (!Number.isInteger(major)) return null
  if (major === 0) return parts[1] || null
  let mc: string
  if (major >= 26) {
    mc = parts[2] === '0' ? `${parts[0]}.${parts[1]}` : `${parts[0]}.${parts[1]}.${parts[2]}`
    const plus = version.indexOf('+')
    if (plus >= 0) mc += `-${version.slice(plus + 1)}`
  } else {
    mc = parts[1] === '0' ? `1.${major}` : `1.${major}.${parts[1]}`
  }
  return mc
}

/** Parses a version of `net.neoforged:forge` (the 1.20.1-only artifact), e.g. "1.20.1-47.1.99". */
export function parseLegacyNeoForge(raw: string): { mcversion: string; version: string } | null {
  const dash = raw.indexOf('-')
  if (dash <= 0) return null
  const mcversion = raw.slice(0, dash)
  let version = raw.slice(dash + 1)
  if (version.startsWith('forge-')) version = version.slice('forge-'.length)
  if (!/^\d/.test(version)) return null
  return { mcversion, version }
}

export function parseNeoForgeVersion(artifact: NeoForgeArtifact, raw: string): ParsedNeoForgeVersion | null {
  if (artifact === 'forge') {
    const p = parseLegacyNeoForge(raw)
    return p ? { artifact, rawVersion: raw, version: p.version, mcversion: p.mcversion } : null
  }
  const mc = neoforgeMcVersion(raw)
  return mc ? { artifact, rawVersion: raw, version: raw, mcversion: mc } : null
}

export function neoforgeArtifactPath(artifact: NeoForgeArtifact, rawVersion: string, category: string, format: string): string {
  const classifier = category ? `-${category}` : ''
  return `net/neoforged/${artifact}/${rawVersion}/${artifact}-${rawVersion}${classifier}.${format}`
}
