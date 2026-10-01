export type SyncTaskName = 'mojang' | 'java' | 'forge' | 'neoforge' | 'optifine' | 'liteloader' | 'fabric' | 'authlib-injector'

export const ALL_SYNC_TASKS: readonly SyncTaskName[] = [
  'mojang',
  'java',
  'forge',
  'neoforge',
  'optifine',
  'liteloader',
  'fabric',
  'authlib-injector',
]

/** Official upstream origins (overridable, e.g. for tests). */
export interface Upstreams {
  pistonMeta: string
  pistonData: string
  launcherMeta: string
  launcher: string
  resources: string
  libraries: string
  forgeFiles: string
  forgeMaven: string
  neoforgeMaven: string
  fabricMeta: string
  fabricMaven: string
  optifine: string
  liteloader: string
  authlibInjector: string
}

export interface Config {
  host: string
  port: number
  mongoUri: string
  syncOnStart: boolean
  enabledTasks: SyncTaskName[]
  /** minutes */
  syncIntervals: Record<SyncTaskName, number>
  http: {
    concurrency: number
    timeoutMs: number
    retries: number
    userAgent: string
  }
  adminToken: string | undefined
  /** seconds; TTL of metadata fetched on demand by the pass-through routes */
  metaCacheTtl: number
  logLevel: string
  upstreams: Upstreams
}

const DEFAULT_INTERVALS: Record<SyncTaskName, number> = {
  mojang: 10,
  java: 360,
  forge: 30,
  neoforge: 30,
  optifine: 60,
  liteloader: 1440,
  fabric: 30,
  'authlib-injector': 360,
}

const DEFAULT_UPSTREAMS: Upstreams = {
  pistonMeta: 'https://piston-meta.mojang.com',
  pistonData: 'https://piston-data.mojang.com',
  launcherMeta: 'https://launchermeta.mojang.com',
  launcher: 'https://launcher.mojang.com',
  resources: 'https://resources.download.minecraft.net',
  libraries: 'https://libraries.minecraft.net',
  forgeFiles: 'https://files.minecraftforge.net',
  forgeMaven: 'https://maven.minecraftforge.net',
  neoforgeMaven: 'https://maven.neoforged.net',
  fabricMeta: 'https://meta.fabricmc.net',
  fabricMaven: 'https://maven.fabricmc.net',
  optifine: 'https://optifine.net',
  liteloader: 'https://dl.liteloader.com',
  authlibInjector: 'https://authlib-injector.yushi.moe',
}

type Env = Record<string, string | undefined>

function envName(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c}`).replace(/-/g, '_').toUpperCase()
}

function num(env: Env, key: string, fallback: number): number {
  const v = env[key]
  if (!v) return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`)
  return n
}

export function loadConfig(env: Env = process.env): Config {
  const enabledTasks = (env.SYNC_TASKS ?? ALL_SYNC_TASKS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as SyncTaskName[]
  for (const t of enabledTasks) {
    if (!ALL_SYNC_TASKS.includes(t)) throw new Error(`Unknown task in SYNC_TASKS: ${t}`)
  }

  const syncIntervals = { ...DEFAULT_INTERVALS }
  for (const t of ALL_SYNC_TASKS) syncIntervals[t] = num(env, `SYNC_INTERVAL_${envName(t)}`, DEFAULT_INTERVALS[t])

  // UPSTREAM_PISTON_META, UPSTREAM_FORGE_MAVEN, ...
  const upstreams = { ...DEFAULT_UPSTREAMS }
  for (const k of Object.keys(upstreams) as (keyof Upstreams)[]) {
    upstreams[k] = (env[`UPSTREAM_${envName(k)}`] || upstreams[k]).replace(/\/+$/, '')
  }

  return {
    host: env.HOST || '0.0.0.0',
    port: num(env, 'PORT', 8080),
    mongoUri: env.MONGODB_URI || 'mongodb://127.0.0.1:27017/haru-api',
    syncOnStart: env.SYNC_ON_START !== 'false',
    enabledTasks,
    syncIntervals,
    http: {
      concurrency: num(env, 'HTTP_CONCURRENCY', 8),
      timeoutMs: num(env, 'HTTP_TIMEOUT_MS', 60_000),
      retries: num(env, 'HTTP_RETRIES', 3),
      userAgent: env.USER_AGENT || 'Mozilla/5.0 (compatible; haru-api/0.1; +https://github.com/HyacinthHaru/haru-api)',
    },
    adminToken: env.ADMIN_TOKEN || undefined,
    metaCacheTtl: num(env, 'META_CACHE_TTL', 600),
    logLevel: env.LOG_LEVEL || 'info',
    upstreams,
  }
}
