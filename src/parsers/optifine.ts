export interface OptiFineRow {
  /** e.g. "OptiFine_1.20.1_HD_U_I6.jar" or "preview_OptiFine_1.20.4_HD_U_I7_pre3.jar" */
  filename: string
  /** compatible Forge as shown on the site, e.g. "Forge 47.2.0", "Forge #2847", "Forge N/A" */
  forge: string
  /** release date as shown on the site (dd.mm.yyyy) */
  date: string | null
}

export interface ParsedOptiFineFilename {
  mcversion: string
  type: string
  patch: string
  preview: boolean
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

export function decodeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : all
    }
    return ENTITIES[e.toLowerCase()] ?? all
  })
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '')
}

function cell(row: string, cls: string): string | undefined {
  const re = new RegExp(`<td[^>]*class\\s*=\\s*["']?[^"'>]*\\b${cls}\\b[^>]*>([\\s\\S]*?)(?:</td>|<td\\b|$)`, 'i')
  const m = re.exec(row)
  return m ? decodeHtml(stripTags(m[1] ?? '')).replace(/\s+/g, ' ').trim() : undefined
}

/**
 * Parses https://optifine.net/downloads (all versions, previews included). Rows look like:
 *   <tr class='downloadLine downloadLineMain'>
 *     <td class='colFile'>OptiFine HD U I6</td>
 *     <td class='colDownload'><a href='http://optifine.net/adloadx?f=OptiFine_1.20.1_HD_U_I6.jar'>Download</a></td>
 *     <td class='colMirror'><a href="http://optifine.net/adloadx?f=OptiFine_1.20.1_HD_U_I6.jar">(Mirror)</a></td>
 *     <td class='colForge'>Forge 47.2.0</td>
 *     <td class='colDate'>21.11.2023</td>
 *   </tr>
 */
export function parseOptiFineDownloads(html: string): OptiFineRow[] {
  const rows: OptiFineRow[] = []
  const seen = new Set<string>()
  for (const chunk of html.split(/<tr\b/i).slice(1)) {
    const f = /[?&](?:amp;)?f=((?:preview_)?OptiFine_[^"'&\s<>]+?\.jar)/i.exec(chunk)
    if (!f?.[1]) continue
    const filename = decodeURIComponent(decodeHtml(f[1]))
    if (seen.has(filename) || !parseOptiFineFilename(filename)) continue
    seen.add(filename)
    rows.push({ filename, forge: cell(chunk, 'colForge') ?? '', date: cell(chunk, 'colDate') || null })
  }
  return rows
}

/**
 * "OptiFine_1.20.1_HD_U_I6.jar"              -> { mcversion: "1.20.1", type: "HD_U",    patch: "I6" }
 * "preview_OptiFine_1.20.4_HD_U_I7_pre3.jar" -> { mcversion: "1.20.4", type: "HD_U_I7", patch: "pre3" }
 * (the last "_" segment is the patch, everything between the Minecraft version and it is the type,
 * which is how BMCLAPI keys /optifine/:mcversion/:type/:patch)
 */
export function parseOptiFineFilename(filename: string): ParsedOptiFineFilename | null {
  const m = /^(preview_)?OptiFine_([^_]+)_(.+)\.jar$/i.exec(filename)
  if (!m) return null
  const rest = (m[3] as string).split('_')
  if (rest.length < 2) return null
  const patch = rest.pop() as string
  return { mcversion: m[2] as string, type: rest.join('_'), patch, preview: Boolean(m[1]) }
}

/** Extracts the tokenised "downloadx?f=...&x=..." link from https://optifine.net/adloadx?f=<file>. */
export function parseAdloadx(html: string): string | null {
  const m = /downloadx\?f=[^"'\s<>]+/i.exec(html)
  return m ? decodeHtml(m[0]) : null
}
