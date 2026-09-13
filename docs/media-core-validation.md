# Media Core 实施与验证报告

## 修改范围
只修改 TongMu 主仓库；SyncTV 与原始 ZViewer 参考资料只读。未执行 reset、checkout、clean，未提交或推送。

## 核心文件
- backend/src/services/media/protocol.ts：公开/私有协议、传输候选、公开数据清理。
- backend/src/routes/stream/media.ts：解析、候选签发、HLS/MPD 分层代理、最高档清单。
- backend/src/services/media/{types,planner,handles,room-access}.ts：质量事实、能力规划、handle 模式、在线授权。
- backend/src/services/media/resolvers/{browser,generic-web,bilibili}.ts：保留 probe 安全头、Bilibili 入口及实际质量。
- backend/src/services/bilibili/{video,playurl,resolver}.ts：aid/bvid、精确 representation、同轨备选、取消 MP4 静默兜底。
- backend/src/modules/movie/movie.service.ts、modules/shared/dto/movie.dto.ts：私有输入持久化与公开序列化。
- backend/src/entities/SystemSettings.ts、services/system-settings.ts、routes/stream/resolve.ts：DASH 默认与旧配置迁移。
- frontend/src/modules/media/{mediaApi,localPlanner,transport}.ts：本机计划、有序重试、状态恢复。
- frontend/src/modules/player/engine-selector.ts、engines/{hls,dash,playsvideo}-engine.ts、hooks/usePlayerSource.ts、services/url-proxy.ts：播放器接入、最高档、错误提示及 token 边界。
- frontend/src/modules/room/watch-together/{movie-source-resolver,useWatchTogether}.ts：统一刷新持久化、本机代理重连。
- frontend/src/modules/room/components/{MoviePushPanel,BilibiliParseSettings}.tsx、store/systemSettingsStore.ts：私有输入提交及显式兼容偏好。
- backend/test/media-protocol.test.js、frontend/test/media.test.cjs、e2e/media-playback.spec.ts：行为回归。
- frontend/package.json、playwright.config.ts、scripts/start-e2e.js：测试入口与短 TTL fixture。
- docs/media-core.md：协议、调用链与 SyncTV 对比。

## 播放链路
原来：添加 URL → resolver/probe → 房主 planner → 强制 gateway → Movie/Socket → player。
现在：添加 URL → resolver/probe → 私有事实与公开候选分离 → Movie 保留私有刷新输入 → Socket 共享媒体 → 每个客户端规划 → Direct → 清单辅助 → 局部代理 → 全代理。
候选属于同一次解析，不重新使用每个观众账号解析。失败重挂保留时间、暂停状态、倍速和质量。

## 默认与失败策略
公开 MP4/WebM、无后缀媒体、HLS、DASH 默认 Direct；允许明确可公开的签名播放 URL。需要私有头或敏感 URL 的源直接提供代理。Bilibili DASH 当前含防盗链头，因此通常需代理。
HLS AES-128 允许仅 key 代理；DRM blocked。原生无 MSE HLS 为锁最高档使用清单辅助，片段仍直连。
不再存在本轮媒体核心中 Direct 失败自动转 720P MP4 的路径。HLS/DASH 默认固定最高档；未新增通用 Auto 质量选择 UI。显式 Bilibili MP4 兼容是用户选择，受 720P 上限约束。

## Bilibili 质量
默认请求最高档，由实际授权返回决定可用最高；显式 4K 返回其他档直接 QUALITY_UNAVAILABLE。
representation 按实际 qn/id 精确选取，backup URL 不换档。requested/actual/source maximum/available maximum 分开；未知信息不伪造。
BV 用 bvid，av 用 aid；b23.tv/bili2233.cn 支持安全短链解析。历史全局强制 MP4 默认通过版本字段一次性迁移。

## 公私隔离与授权
Cookie、Authorization、headers、原始输入不进入公开 descriptor/DTO。公开 sourceInput 为 media-movie:id，房主刷新时服务器按房间和在线身份读取私有值；Socket 使用同一 serializer。
BrowserResolver 不恢复 probe 跨源剥离的头。
roomGrant 过期后仍须验证对应活跃 Socket Session，满足条件才滚动授权。断线/踢出即撤销。handle 自身 12h 不被无限延长。

## 实际验证
| 命令 | 结果 |
| --- | --- |
| npm test -w backend | 47/47 通过，含 backend build/tsc，原有 37 项保留 |
| npm run lint -w backend | tsc --noEmit 通过 |
| npm run build -w frontend | tsc + Vite 通过 |
| npm test -w frontend | 5/5 通过 |
| npm run test:e2e -- --reporter=line | 12/12 通过，约 2.8 分钟 |
| git diff --check | 通过；仅 Git 的 LF/CRLF 提示 |

12 个浏览器用例在一次完整 E2E 运行中全部通过。
浏览器验证实际媒体加载、gateway 请求计数、extensionless、signed URL、HLS/DASH Direct、AES key 局部代理、同质量 fallback、在线短 TTL 授权、API/Socket 脱敏、房主刷新。
最后一项使用真实 MP4 和真实代理，通过派发 error 事件模拟运行期失败，验证 currentTime、paused、playbackRate、视频尺寸和代理 currentSrc。不声称该事件来自自然网络断线。
BrowserResolver 用 mock Chromium 驱动与 mocked HTTP response，实际执行 capture → probe → safe-fetch → descriptor；不是生产浏览器站点验收。
过程中曾出现 Node/V8 崩溃及前端构建退出 3221225477，原命令重跑成功。最终前端构建仍有已有的 mediabunny 动态导入及大 chunk 警告。

## 未解决/未验收
- 真实 Bilibili 登录、VIP、地区及实际 CDN 反盗链；当前为固定响应与调用链测试。
- 真实 Safari/iOS 原生 HLS；当前为策略单测，Chromium E2E。
- 通用 Auto 清晰度选择 UI 未新增；默认最高档已实现。
- 任意 signed URL 参数/路径的私密语义不能仅靠名称完全识别，需要后续 provider visibility 声明。
- 复杂 MPD Location/xlink/多 BaseURL/SegmentBase、LL-HLS 扩展仍需完善。
- 媒体 handle 12h 或源站签名到期仍需房主刷新；在线 grant 续期不等于源站签名续期。
- 通用 bounded probe 不能给所有媒体提供完整质量/codec 信息。

## 最值得复用的 SyncTV 源码
参考根目录 ../references/synctv：
1. synctv-proxy/src/slice_cache/{range,etag,keys,store}.rs：范围、对齐、实体一致性、按 URL+headers 隔离缓存。
2. synctv-proxy/src/mpd.rs：Location/index/sourceURL/xlink 与模板作用域 mapper。
3. synctv-proxy/src/manifest.rs：HLS resource 分类、URI 上限与 live/event/vod 生命周期。
4. synctv-media-providers/src/bilibili/client.rs：dash_video_query_params、resolve_short_link、parse_dash_info；连同 types.rs/service.rs 复用多音轨和 backup 模型。
5. synctv-proxy/src/redirect.rs：重定向策略；移植时保留 TS 对 token/API-key 与 credential provenance 的额外保护。

未来 Rust 替换 proxy/Range/cache/provider，沿用公开媒体与传输协议。Room/Socket、UI、同步互动、BrowserResolver 和通用网页提取继续属于 TongMu。
