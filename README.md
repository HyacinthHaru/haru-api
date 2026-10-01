# haru-api

BMCLAPI 兼容的抓取后端：定时从各官方源抓取 Minecraft / Forge / NeoForge / OptiFine / LiteLoader / Fabric / authlib-injector 的数据，存入 MongoDB，并按 BMCLAPI 的接口对外提供。文件下载走 GridFS 回源缓存（首次请求从官方源拉取并存入 MongoDB，之后直接由本服务提供）。

- Node.js ≥ 22.19，TypeScript，Fastify
- MongoDB 8

## 运行

```sh
cp .env.example .env
docker compose up -d          # mongo:8 + haru-api，监听 8080
```

或本地运行：

```sh
npm ci
npm run build
MONGODB_URI=mongodb://127.0.0.1:27017/haru-api npm start
```

只执行一次抓取：

```sh
npm run sync                  # 所有任务
npm run sync -- forge optifine
```

启动后默认立即执行所有抓取任务，之后按间隔定时执行；进度见 `GET /_haru/status`。

## 抓取任务

| 任务 | 官方源 | 存储内容 | 默认间隔 |
| --- | --- | --- | --- |
| `mojang` | piston-meta.mojang.com | `version_manifest.json`、`version_manifest_v2.json`、所有版本 JSON 与 asset index（按 sha1 校验，原样保存） | 10 分钟 |
| `java` | piston-meta.mojang.com | Java 运行时 `all.json` 及各运行时 `manifest.json` | 6 小时 |
| `forge` | files.minecraftforge.net | `maven-metadata.json`、`promotions_slim.json`，各 Minecraft 版本页面上每个版本的发布时间与文件（sha1） | 30 分钟 |
| `neoforge` | maven.neoforged.net | `net.neoforged:neoforge` 与 `net.neoforged:forge`（1.20.1）的版本列表 | 30 分钟 |
| `optifine` | optifine.net/downloads | 全部版本（含预览版）、适配的 Forge 版本、发布日期 | 60 分钟 |
| `liteloader` | dl.liteloader.com | `versions.json` 及其中每个版本 | 1 天 |
| `fabric` | meta.fabricmc.net | `/v2/versions` 下的各版本列表 | 30 分钟 |
| `authlib-injector` | authlib-injector.yushi.moe | `artifacts.json`、`artifact/latest.json`、`artifact/<build>.json` | 6 小时 |

## 接口

### Minecraft

| 接口 | 说明 |
| --- | --- |
| `GET /mc/game/version_manifest.json` | 版本列表 |
| `GET /mc/game/version_manifest_v2.json` | 版本列表 v2 |
| `GET /version/:version/:category` | `category` 为 `json`、`client`、`server`、`client_mappings`、`server_mappings` |
| `GET /versions/:version/:file` | 旧路径：`<id>.json`、`<id>.jar`、`minecraft_server.<id>.jar` |
| `GET /v1/packages/*`、`/v1/products/*`、`/mc/*` | piston-meta 同路径（版本 JSON、asset index、Java 运行时） |
| `GET /v1/objects/*` | piston-data 同路径（客户端、服务端、mappings、Java 运行时文件） |
| `GET /assets/:hash2/:hash` | 资源文件（resources.download.minecraft.net） |
| `GET /libraries/*` | 库文件（libraries.minecraft.net） |
| `GET /maven/*` | 合并的 Maven：Forge、NeoForge、Fabric、LiteLoader、Mojang libraries；另有 `com/mumfrey/liteloader/versions.json` 与 `com/optifine/...` |

### Forge

| 接口 | 说明 |
| --- | --- |
| `GET /forge/minecraft` | 有 Forge 的 Minecraft 版本列表 |
| `GET /forge/minecraft/:version` | 该 Minecraft 版本的全部 Forge 构建 |
| `GET /forge/list/:offset/:limit` | 按 build 倒序分页 |
| `GET /forge/last` | 最新发布的构建 |
| `GET /forge/promos` | 推荐 / 最新版本（`name` + `build`） |
| `GET /forge/download/:build` | 按 build 下载安装器（老版本为 universal / client） |
| `GET /forge/download?mcversion=&version=&branch=&category=&format=` | 按版本下载，`category` 默认 `installer`，`format` 默认 `jar` |

构建对象：

```json
{
  "_id": "…",
  "__v": 0,
  "build": 1614,
  "branch": "1.7.10",
  "files": [{ "format": "jar", "category": "installer", "hash": "<sha1>" }],
  "mcversion": "1.7.10",
  "modified": "2016-…Z",
  "version": "10.13.4.1614"
}
```

`build` 对旧版本（四段版本号）是官方构建号；新版本没有构建号，与 BMCLAPI 一样记为 `主版本 × 1000000 + 次版本 × 10000 + 修订号`（如 47.2.0 → 47020000）。

### NeoForge

| 接口 | 说明 |
| --- | --- |
| `GET /neoforge/list/:mcversion` | `rawVersion`、`version`、`mcversion`、`installerPath` |
| `GET /neoforge/version/:version/download/:category.:format` | 如 `/neoforge/version/20.4.237/download/installer.jar`，`version` 可用 `rawVersion` 或 `version` |
| `GET /neoforge/meta/*` | maven.neoforged.net 同路径，如 `/neoforge/meta/api/maven/details/releases/net/neoforged/neoforge` |

### OptiFine

| 接口 | 说明 |
| --- | --- |
| `GET /optifine/versionList` | 全部版本：`mcversion`、`type`、`patch`、`filename`、`forge` |
| `GET /optifine/:mcversion` | 该 Minecraft 版本的 OptiFine |
| `GET /optifine/:mcversion/:type/:patch` | 下载，如 `/optifine/1.20.1/HD_U/I6`；预览版如 `/optifine/1.20.4/HD_U_I7/pre3` |

### LiteLoader

| 接口 | 说明 |
| --- | --- |
| `GET /liteloader/list` | 全部版本；带 `?mcversion=` 时返回该版本最新的一个 |
| `GET /liteloader/download?version=` | 下载，如 `?version=1.12.2-SNAPSHOT` |

### 其它

| 接口 | 说明 |
| --- | --- |
| `GET /fabric-meta/*` | meta.fabricmc.net 同路径 |
| `GET /mirrors/authlib-injector/*` | authlib-injector.yushi.moe 同路径 |
| `GET /_haru/status` | 各抓取任务状态与数据量 |
| `POST /_haru/sync/:task` | 立即执行某个抓取任务，需 `Authorization: Bearer <ADMIN_TOKEN>` |

文件响应带 `x-bmclapi-hash`（sha1）与 `ETag`，缓存后的文件支持 `Range`。

## 存储

| 集合 | 内容 |
| --- | --- |
| `documents` | 官方源的原始文档（manifest、版本 JSON、asset index、各 meta），按字节原样保存；按需拉取的条目带过期时间 |
| `mojang_versions` | 版本索引（类型、时间、sha1、downloads、assetIndex） |
| `forge_builds` / `forge_promos` | Forge 构建与推荐版本 |
| `neoforge_versions` | NeoForge 版本 |
| `optifine_versions` | OptiFine 版本 |
| `liteloader_versions` | LiteLoader 版本 |
| `sync_state` | 抓取任务状态 |
| `files.files` / `files.chunks` | GridFS 文件缓存 |

## 配置

见 [`.env.example`](.env.example)。`UPSTREAM_*` 可替换任一官方源地址。

## 测试

需要可连接的 MongoDB（`MONGODB_URI`，默认 `mongodb://127.0.0.1:27017`）：

```sh
npm test
```

集成测试会启动一个按官方源路径提供样例数据的本地服务，完整执行所有抓取任务后逐个请求接口。

### e2e 一致性检查

对真实官方源与 BMCLAPI 做端到端比对（需要联网）：

```sh
MONGODB_URI=mongodb://127.0.0.1:27017/haru-e2e npm run e2e -- --sync
npm run e2e -- --only=forge,neoforge --no-bmclapi    # 只查部分范围、跳过 BMCLAPI
```

逐项输出 PASS / WARN / FAIL，详细差异写入 JSON 报告（默认 `<tmpdir>/haru-e2e-report.json`），有 FAIL 时退出码为 1。对 BMCLAPI 的请求串行、间隔 1.2 秒，并遵守其限流。
