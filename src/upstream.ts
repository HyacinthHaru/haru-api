import { extname } from 'node:path'
import type { Upstreams } from './config.js'

/** Official hosts referenced inside upstream metadata -> configured upstream key. */
const OFFICIAL_HOSTS: Record<string, keyof Upstreams> = {
  'piston-meta.mojang.com': 'pistonMeta',
  'launchermeta.mojang.com': 'launcherMeta',
  'piston-data.mojang.com': 'pistonData',
  'launcher.mojang.com': 'launcher',
  'resources.download.minecraft.net': 'resources',
  'libraries.minecraft.net': 'libraries',
  'files.minecraftforge.net': 'forgeFiles',
  'maven.minecraftforge.net': 'forgeMaven',
  'maven.neoforged.net': 'neoforgeMaven',
  'meta.fabricmc.net': 'fabricMeta',
  'maven.fabricmc.net': 'fabricMaven',
  'optifine.net': 'optifine',
  'dl.liteloader.com': 'liteloader',
  'authlib-injector.yushi.moe': 'authlibInjector',
}

/**
 * Re-targets an official URL found in upstream metadata (e.g. a version JSON url) at the
 * configured upstream for that host. With default configuration this is the identity
 * (apart from upgrading http:// to https://).
 */
export function toUpstreamUrl(url: string, upstreams: Upstreams): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  const key = OFFICIAL_HOSTS[u.hostname]
  if (!key) return url
  return `${upstreams[key]}${u.pathname}${u.search}`
}

/** Pathname of an official URL, e.g. "https://piston-meta.mojang.com/v1/packages/x/1.20.1.json" -> "/v1/packages/x/1.20.1.json". */
export function urlPath(url: string): string {
  return new URL(url).pathname
}

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.jar': 'application/java-archive',
  '.zip': 'application/zip',
  '.xml': 'application/xml; charset=utf-8',
  '.pom': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.sha1': 'text/plain; charset=utf-8',
  '.sha256': 'text/plain; charset=utf-8',
  '.sha512': 'text/plain; charset=utf-8',
  '.md5': 'text/plain; charset=utf-8',
  '.asc': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.lzma': 'application/x-lzma',
  '.png': 'image/png',
  '.ogg': 'audio/ogg',
}

export function guessContentType(path: string, upstream?: string): string {
  const byExt = CONTENT_TYPES[extname(path.split('?')[0] ?? '').toLowerCase()]
  if (byExt) return byExt
  if (upstream && !/^application\/octet-stream/i.test(upstream)) return upstream
  return 'application/octet-stream'
}
