# Media Protocol v1 — Direct First

本项目当前唯一工作树是仓库根目录 `TongMu`。`references/synctv` 与 `references/zviewer-original` 只读；它们是本机参考资料，不属于发布仓库。

## 产品与媒体边界

旧链路：添加输入 → Bilibili/Direct/Generic/Browser resolver → bounded probe → descriptor → 房主能力 planner → 无条件加密 gateway URL → Movie（含原始输入和房主计划）→ movie-list → player → 全量代理 HLS/DASH 子资源。

新链路：房主输入 → resolver/probe 私有媒体事实 → public descriptor + 有序 transportPlan → Movie 服务器保存原始 sourceInput，公开 DTO 仅 `media-movie:<id>` → movie-list → 每个客户端 localPlanner → 现有 engine + transport wrapper → CDN Direct；实际失败后逐项尝试同媒体候选。

公开协议在 `backend/src/services/media/protocol.ts`，前端入口在 `frontend/src/modules/media/mediaApi.ts`。现有 HTTP / Socket / Movie 字段保持兼容；历史 input/originalUrl 在公开 resolve 响应中为空字符串，持久化公开元数据中移除。`playbackPlan` 不再持久化为房间共同答案。`PrivateMediaSource` 定义服务器输入及凭证来源；加密媒体 handle 仅把不可解密的 capability 交给客户端。

## 传输候选

- DIRECT：MP4/WebM、无后缀媒体、公开 HLS/MPD；不能需要 Cookie、Authorization、Referer、Origin、自定义 UA 等浏览器不能按要求设置的请求头。
- 公开签名 URL 可直连：无 userinfo/fragment、无 token/cookie/auth/password/secret/API-key 参数、无私有请求头。签名 URL 是有意共享的播放能力；凭证采集 resolver 的头部要求仍会使其进入代理。
- MANIFEST_ASSISTED：服务器读取/解析清单，子清单继续辅助处理，公开媒体段仍直连。
- PARTIAL_PROXY：HLS 在上述基础上只中转 key，保留 AES-128 支持。DASH 当前与 manifest assisted 共用实现，没有假称单独实现 DASH key 代理。
- FULL_PROXY：浏览器无法完成上述方式，或者源本身需要服务器私有头/私有 URL。加密 handle 绑定 room/user，所有源站跳转沿用 safe-fetch 与 Range 校验。

候选 URL 在一次 resolve 中签发；客户端失败后才请求备用 URL，不需要重新调用 provider。失败不改 representation、codec 或清晰度。wrapper 保存 currentTime、播放/暂停和 playbackRate；一次 attach 最多尝试各候选一次。本机成功的传输方式供重连沿用，未写进房间媒体。最终失败通过现有 message UI 提示。

网关不会把应用 JWT 或 roomGrant 追加到直连 CDN 子资源。DASH assisted 检测到私有凭证子资源时拒绝该候选，继续 full proxy。Manifest fetch 使用 safe-fetch 返回的最终 headers/provenance，避免 A→B→A 再恢复 Cookie。

## 原画与 Bilibili

- BV 与 av 保持不同身份：view 请求分别用 bvid / aid，拿到标准 bvid 后才请求 playurl。
- b23.tv、bili2233.cn 进入 BilibiliResolver，短链逐跳使用公共网络安全策略。
- 未指定质量时向源站请求最高档（qn=127），DASH flags 4048；账号权限由源站返回决定，不凭 VIP 布尔值假定可用画质。
- 实际 representation 必须匹配返回 quality 的 id；没有对应轨道明确报错，不能随意按带宽选另一档。
- 显式指定 qn 后若实际不一致，抛出 QUALITY_UNAVAILABLE。CDN HEAD/小 Range 探测失败也不调用 MP4 兼容接口；保留同 representation 的地址让实际播放决定。
- MP4 仅在明确 preferMp4=true 时使用，最高请求 qn=64，并标注兼容上限。Bilibili MP4 不再无条件添加 DASH 防盗链头。
- sourceMaximumQuality 来自源站质量目录；availableMaximumQuality 仅在 Highest 解析时用实际返回档位；未知值不伪造。requestedQuality、actualQuality、actualCodec、actualBandwidth 分开。
- HLS.js 与标准 dash.js 默认锁最高 representation，关闭默认视频 ABR。Bilibili 双轨本来就是一档视频 representation。视频重编码未启用；现有 playsvideo 保留视频，仅必要时 remux / 转音频。

新数据库默认 DASH enabled。旧库通过 `mediaPolicyVersion` 一次性把历史全局 dashDisabled=true 改为 false；这是主动废弃旧版强制 MP4 默认，用户逐影片 preferMp4 选择保留。现有项目仍使用 synchronize，初始化 schema 会增加版本列；没有擅自切换数据库管理策略。

## 安全与生命周期

BrowserResolver 和 GenericWebResolver 不再覆盖 probe 已经消毒的 headers。BrowserResolver 完整调用链测试包含网络响应捕获、跨 origin redirect、真实 probe、安全返回；Chromium 页面驱动被 mock，HTTP 安全链没有 mock 掉。

Movie.sourceInput 是服务器私有刷新材料。公开 sourceInput 字段只保留影片引用；resolve 对引用读取数据库，并核对 roomId 与当前 Socket Session 的 sharer 身份。观众不能用自己的 Cookie 重新解析房间共享媒体。更新 Movie 时忽略 opaque 引用对原始私有 sourceInput 的覆盖。旧 Movie 中含敏感 query 的媒体 URL 在序列化时改为加密 handle。

roomGrant 的 nominal TTL 与活跃会话授权分开：签名/结构必须有效，每次请求核对相同 roomId/socketId 的未结束 Session；连续在线时滚动授权至下一时间窗，已写进 HLS/MPD 的旧 token 无需整片重写。离开、踢出、断线或进程启动清理 Session 立即撤销，过期 token 单独不能脱离 Session 使用。媒体 handle 自身仍是 12h；到期按房主统一刷新流程处理。

## 与 SyncTV 的逐项比较和下一步

以下位置相对只读参考目录 `references/synctv`：

| 模块 | 已读取的参考位置 | 本轮决策 / 后续复用 |
| --- | --- | --- |
| HLS | `synctv-proxy/src/manifest.rs` | SyncTV 有 Manifest/Segment/Part/Key/Init/Auxiliary 分类、1000 URL 上限和 master/live/event/vod 生命周期；比当前简单 URI rewrite 更完整。优先移植 typed URL mapper 与对应测试，接 TransportMode，不默认全量代理。 |
| MPD | `synctv-proxy/src/mpd.rs` | SyncTV 覆盖 Location、SegmentURL index、sourceURL、xlink:href 和模板作用域。当前 TS 保留已测试的继承模板物化与 BaseURL 解析；未来通过相同 transportPlan 接 Rust mapper，不搬产品层。 |
| Range/cache | `synctv-proxy/src/slice_cache/range.rs`, `etag.rs`, `keys.rs`, `store.rs` | TS 已有真实 206/非零 Range 被忽略时停止传输的测试；SyncTV 具备 suffix/open-ended、多范围识别、slice 对齐、ETag 一致性和 URL+headers 隔离缓存键。最值得完整复用整个 slice_cache 子模块及 range/store/lifecycle/backend tests，而非在 TS 重写。 |
| Redirect | `synctv-proxy/src/redirect.rs` | SyncTV 跨源丢 Cookie/Auth/Proxy-Auth，并把 Referer 收窄到 origin。TS 额外按 token/API-key 名称剥离和不可恢复 provenance，保留并作为 Rust 接入契约测试。 |
| Bilibili | `synctv-media-providers/src/bilibili/client.rs`（dash_video_query_params、resolve_short_link、parse_dash_info）, `types.rs`, `service.rs` | 参考 aid/bvid 分离、qn127/4048、backup_urls 和多音轨模型。当前 strict requested-vs-actual、无 MP4 网络降档策略要保留，未来移植 provider 时必须带上。 |

长期留在 TongMu：Room/Socket、权限、UI、互动、同步、播放器事件、BrowserResolver、generic webpage extraction、TongMu adapters。未来可替换：HTTP transport / Range / manifest mapper / slice cache / provider。没有引入 Rust sidecar、Redis、集群或 gRPC management。

## 明确限制

- 尚未用真实 Bilibili 登录/VIP/地区限制账号验证；provider 行为由固定响应、解析调用链及 quality/backup 测试验证。
- 无 MSE 的原生 HLS 使用 MANIFEST_ASSISTED：服务器只保留 master 的最高视频档，保留音频/字幕 rendition groups，媒体段仍直连。单档策略有测试，但尚无真实 Safari/iOS 设备验收。
- 通用 probe 只读有界媒体头，没有 ffprobe；不能凭未知 metadata 声称源最大分辨率/codec 已识别。
- MPD Location/xlink/多 BaseURL 备选/复杂 SegmentBase 和 LL-HLS steering/变量等仍需成熟 mapper；本轮不是完整 Rust media core 迁移。
- 当前 signed URL 安全判断依赖来源及参数名，不能识别任意站点把私有凭证隐藏在普通参数或路径中的语义。需要 provider 显式 URL visibility 元数据来扩展。
- 12h 媒体 handle 到期仍需房主刷新；roomGrant 续期不延长源站签名 URL 本身有效期。

## 验证记录

最终命令、通过数量及未验证边界见 `media-core-validation.md`。测试 fixture 用两秒 roomGrant/access JWT 验证持续在线授权，并通过浏览器请求拦截制造真实 Direct fetch 失败。没有用构建成功代替实际播放。
