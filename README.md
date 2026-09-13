# TongMu

TongMu 是一个以同步观影与房间互动为核心的平台。视频能够由客户端直接访问源站或 CDN 时，默认由客户端直连；服务器主要负责房间、同步、互动、媒体解析和播放协调，只有 Direct 不可行时才使用 Media Gateway fallback。

TongMu 从 ZViewer 代码库演进而来。媒体核心的代理、清单和 provider 设计参考了本机只读资料 `references/synctv`；参考源码不属于本仓库，也不会随 GitHub 发布。

## 核心特点

- 多人房间、房主控制、观众申请、播放状态同步、评论、弹幕和语音互动。
- Bilibili、统一媒体 URL、网页解析，以及 WebDAV、FTP、OpenList 等来源。
- Media Protocol v1：统一 `MediaDescriptor`，客户端本地生成 `PlaybackPlan`，支持直链、HLS、DASH、FLV 和现有浏览器播放引擎。
- Original Quality First、Direct First、Proxy as Fallback：传输方式切换不主动降低清晰度。
- Resolve Once, Stream Independently：解析与播放分离；过期或失败时明确反馈，不静默伪造成功。
- Public Metadata / Private Credentials：房间共享媒体事实，源站 Cookie、请求头和房主凭证不进入公开 DTO。
- Shared Media / Local Playback Plan：房间共享媒体描述，播放能力与引擎选择属于各客户端。
- No Video Transcoding by Default：服务器默认不转码视频；不兼容容器或音轨可由已有浏览器端播放路径处理。
- 可选 BrowserResolver：推荐 Docker 镜像内置 Playwright 与 Chromium，用于需要 JavaScript 页面解析的来源。

## 架构

```text
┌──────────────┐       room / sync / metadata       ┌─────────────────────┐
│ Browser      │ ◄────────────────────────────────► │ TongMu Backend      │
│ PlaybackPlan │                                     │ Room / Socket       │
│ local engine │                                     │ Resolve / Auth      │
└──────┬───────┘                                     │ Media Gateway       │
       │                                             └──────┬──────────────┘
       │ Direct First                                       │ fallback only
       ▼                                                    ▼
┌──────────────┐                                     ┌─────────────────────┐
│ Source/CDN   │                                     │ Source/CDN           │
│ HLS/DASH/... │                                     │ headers / manifest  │
└──────────────┘                                     └─────────────────────┘

                 config/  -> SQLite, credentials, uploads, media cache
```

## 快速 Docker 部署

根目录的 `docker-compose.yml` 是唯一推荐入口。它使用包含 BrowserResolver、Playwright 和 Chromium 的 `Dockerfile.linux-browser`，并保留 `/app/config` 的持久化语义。

```bash
cp .env.example .env
# 编辑 .env：至少设置生产环境的 JWT_ACCESS_SECRET、JWT_REFRESH_SECRET、CORS_ORIGIN
docker compose config
docker compose up -d --build
docker compose ps
```

访问 `http://localhost:3333`。3333 提供 API、Socket.IO、前端页面和 `/live` HTTP-FLV 入口；3334 是 OBS 使用的 RTMP 端口。容器内 HTTP-FLV 默认使用 3335，不直接暴露。

默认 Compose 服务名为 `tongmu`。历史 volume 名 `zviewer-browser-data` 有意保留，避免仅因品牌改名而看不到已有数据。旧配置位于 `docker/legacy/`，不是推荐路线。

Docker 镜像默认不自动签发 HTTPS 证书；生产环境请在前面配置 Nginx 或 Caddy，并转发 WebSocket 升级请求。严格 NAT 下的 WebRTC 可能仍需要外部 TURN 服务。

## 环境变量

根 `.env.example` 只包含占位值，真实 `.env` 会被忽略，不能提交。

| 变量 | 用途 | 默认/说明 |
|---|---|---|
| `PORT` / `HOST` | HTTP 服务端口和监听地址 | `3333`；Docker 强制监听 `0.0.0.0` |
| `NODE_ENV` | 运行环境 | `production` |
| `CONFIG_DIR` | 运行时数据根目录 | `<project-root>/config` |
| `DATABASE_URL` | SQLite 路径或 PostgreSQL 连接串 | 默认 `config/dev.sqlite` |
| `CORS_ORIGIN` | CORS 允许来源 | 生产环境改为正式域名 |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | 登录令牌密钥 | 生产环境必须使用随机值 |
| `MEDIA_BROWSER_RESOLVER` | 启用 BrowserResolver | Docker 示例为 `true` |
| `MEDIA_BROWSER_MAX_CONCURRENCY` | Chromium 页面并发数 | `1` |
| `PLAYWRIGHT_EXECUTABLE_PATH` | 使用外部 Chromium 时的路径 | 可选 |
| `MEDIA_HANDLE_SECRET` | 加密媒体句柄密钥 | 缺省写入 `config/jwt-secrets.json` |
| `TYPEORM_MIGRATIONS` | 是否运行渐进式 migration | `false` |
| `VITE_API_URL` | 前端构建时 API 基础地址 | 留空使用当前 origin |
| `VITE_FLV_BASE_URL` | HTTP-FLV 拉流基础地址 | 留空使用 `/live` |
| `RTMP_PORT` / `HTTP_FLV_PORT` | OBS 推流和内部 FLV 端口 | `3334` / `3335` |

## 持久化与更新

所有运行时数据位于 `config/`，包括 `dev.sqlite`、`jwt-secrets.json`、SSL 文件、用户上传文件、头像和媒体切片。升级时保留整个 `config/`，不要删除 Compose volume。

```bash
docker compose pull        # 仅在使用外部镜像时需要
docker compose up -d --build
docker compose logs --tail=100 -f
```

当前根 Compose 使用源码构建，因此标准更新流程是拉取代码后重新执行 `docker compose up -d --build`。本仓库没有在 CI 中默认发布 Docker image。

## 本地开发

项目使用 npm workspaces；从 TongMu 根目录执行：

```bash
npm install
npm run dev                 # backend + frontend
npm run dev:backend
npm run dev:frontend
```

常用验证命令：

```bash
npm run lint -w backend
npm test -w backend
npm run build -w frontend
npm test -w frontend
npm run test:e2e
```

首次运行 E2E 时，如本机尚未安装浏览器，可执行 `npx playwright install chromium`。生产源码启动脚本仍保留在根目录；单文件打包脚本保留在 `build-all.js` 和 `packaging/`。

## 目录结构

```text
TongMu/
├── .github/workflows/    # CI 与手动构建
├── backend/              # Express + TypeScript + TypeORM/sql.js
├── frontend/             # React + Vite + Tailwind
├── e2e/                  # Playwright 验证
├── docs/                 # 架构与媒体核心验证文档
├── docker/               # entrypoint 与 legacy Compose
├── scripts/              # 开发和测试脚本
├── packaging/            # 单文件启动/打包辅助脚本
├── patches/              # 仍在使用的依赖补丁
├── references/           # 本机只读参考资料，永不上传
├── config/               # 本地运行时数据，永不上传
├── docker-compose.yml    # 推荐 BrowserResolver 部署入口
└── AGENTS.md             # 后续协作约束
```

## Beta 限制

- BrowserResolver 依赖 Playwright/Chromium；默认 Docker 镜像已包含，普通本机 Node 环境需要单独安装浏览器。
- 直连播放仍受源站 CORS、防盗链、登录凭证、过期地址和浏览器解码能力影响；Gateway fallback 不是所有来源的万能修复。
- HLS/DASH 清单可能包含 live、鉴权子资源或不同厂商扩展，失败时会显式返回原因。
- 服务器默认不做视频转码；浏览器端 playsvideo 等既有路径可能进行容器重封装或音轨处理。
- WebRTC 的 HTTPS、NAT、TURN 和公网网络质量仍依赖部署环境。
- Bilibili 大会员清晰度需要有效凭证或可选的 ZViewerCLI 本地代理；CLI 是独立项目，不属于本仓库。

## 上游项目与许可证

本项目当前发布源码沿用根目录 [MIT License](LICENSE)，版权声明为 `Copyright (c) 2025 Zero-wyc`。TongMu 从 [ZViewer](https://github.com/Zero-wyc/ZViewer) 演进而来；`references/zviewer-original/` 保存本机原始参考压缩包。

媒体核心实现审阅并参考了 [SyncTV](https://github.com/synctv-org/synctv) 的代理、manifest 和 provider 组织方式；本机副本及其 MIT 许可证位于 `references/synctv/`，并通过 `.gitignore` 排除。若未来直接复制或重新分发 SyncTV 代码，应同时保留其版权和许可证要求。

当前发布树中的归属说明见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

`zviewer-*` 文件名、localStorage key、旧环境变量、Updater 进程名以及历史 Docker volume 等兼容 identifier 暂不整体改名；它们不是当前用户可见品牌，改动可能破坏旧数据或升级流程。

## GitHub Actions

- `ci.yml`：在 push/PR 上执行后端 lint/test、前端 test/build、关键 E2E 和 Compose 配置检查，不依赖 Docker Hub secret。
- `build.yml`：按现有单文件流程构建 Windows/Linux artifact，并在 tag 或 main 时生成 Release；历史 `zviewer-*` artifact 文件名为兼容性保留项。
- `docker.yml`：仅 `workflow_dispatch` 手动构建 BrowserResolver 镜像，不登录 Docker Hub，也不自动 push。
