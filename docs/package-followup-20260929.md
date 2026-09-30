# 交付包补充核对与真实站点验收

## 基线与处理原则

本轮分支 `codex/package-completion` 从前轮累计提交 `6e38d9cc7d618ea325244faa4ff715a8b15287db` 建立。原开发基线仍是 `refactor/frontend-unification` 的 `a280e87d0ae5345c9339d4f1e3318bb955a59d9c`；根目录 main 仍为 `de403bbfe563dabe03cdbe2a196594b9ab44fb3c`。旧审计快照、候选 patch 和 HTML 示意均作为参考，当前源码和实际消费者决定实现。

本文件更新 `remediation-20260929.md` 中 F03、F10、R01/R02 的旧决策，不把前轮的选择性完成描述为整个交付包已经完成。

## 追加整改

- **F03/F10**：通用网页/直链入口改为解析、预览、确认添加；自动识别 B 站后复用既有分集与画质路径。成功后统一清空输入。解析和切换画质期间不能提交旧结果。
- **F01/F02**：输入版本 fence、同步 in-flight guard 与 AbortSignal 保留。2026-09-30 在用户要求完成可本地处理项后，补上 API 层合并并发添加、失败重试复用请求编号，以及绑定用户/房间的服务端持久幂等记录。相同编号重试返回同一影片；不同内容或已删除影片返回 409；成功后的再次添加生成新编号，允许有意重复添加。详见 `local-completion-and-manual-acceptance-20260930.md`。
- **R01**：只提取 B 站预览展示组件 `BilibiliLinkPreview`。保留挂载、房间、解析和播放既有实现，没有为了行数拆写业务。
- **R02**：对报告列出的 11 个静态候选核对 import、路由、脚本、测试和替代实现后删除 8 个旧模块：DirectSharePage、DirectWatchPage、ConnectionStatsPanel、StreamStatusPanel、signalingApi、WebDAVMountPanel、OpenListMountPanel、useAppStore。旧 direct 路由此前已经跳转主页；当前 SharePage/WebRTC、MountManager/MountFormModal、authStore 保留。danmaku/index、server-files/index 为导出边界，useStreamPush 为明确兼容 re-export，保留这三个文件。
- **真实电影 HLS 故障**：ODC 107 分钟电影的 1080p playlist 有 1066 个分片。网页来源通过认证代理重写清单时触发原 1000 个资源限制，返回 502。先新增回归复现失败，再把有限默认预算调整为 10000；4 MiB 输入限制、递归深度、URL 校验、授权和同画质策略保留。新增超限拒绝测试。更大输出和 CPU 预算是该调整的代价，不是取消资源限制。
- **慢 SPA 发现窗口**：外站偶发在页面加载后的 5 秒窗口内尚未发出媒体请求，复现为 NO_MEDIA_FOUND。先用延迟到第 6 秒的网络响应测试复现；仅在结果为空时延长观察，最多再等 10 秒且不超过原请求 deadline，每 250ms 检查取消。已有候选不会额外等待。
- **Browser CONNECT 生命周期**：真实站点的嗅探连接发生 `write ECONNABORTED`，开发后端进程退出。增加 CONNECT 断开回归，补客户端/上游错误处理、双向 socket 清理和代理关闭时的活动 tunnel 销毁。仍先验证目标、解析公共 DNS 并固定到通过检查的 IP；没有放宽 SSRF 策略。
- **网页候选画质**：实际播放曾测得 720p，解析 title 为 `master_720p.m3u8`。API 同时公布 720p/1080p，而旧评分只加相同的 quality bonus。现在只对已发现的同源、同路径质量后缀变体统一主媒体相关性并保留最高变体；不生成或猜测 1080p URL，也不把无关高分辨率广告提升为主片。同系列低清变体不再作为探测失败的隐式降级候选。GenericWeb 与 Browser 共用这一选择规则；已有单一 720p 来源仍可正常解析。

## 两个参考项目的源码复核

只读参考位于根 checkout 的 `references/synctv-main` 和 `references/ZViewer-main`，没有把它们加入 Git 或修改。

| 能力 | 参考源码 | TongMu 当前实现与本轮判断 |
| --- | --- | --- |
| 播放能力按容器/codec/pipeline 同组匹配 | SyncTV `synctv-core/src/provider/playback_profile.rs` 的 PlaybackMediaCapability、supports_media、cache_fingerprint | 已适配为 `playback-profile.ts`、客户端 `playbackProfile.ts` 和 `localPlanner.ts`；继续保留，不复制 Rust 服务架构 |
| Provider 接口与可选动态播放列表 | SyncTV `synctv-core/src/provider/traits.rs` 的 DynamicPlaylistProvider、list_playlist、resolve_item | 当前 registry、ProviderContext 和 adapters 已统一；A01/A02 修复异步降级与参数传递。B 站已有分集、媒体库已有浏览路径；报告原文为“真有多集需求再做动态播放列表”，因此通用动态合约为按需后续建议，非本轮必修缺陷；不表述成已经整合 |
| Range / 分片缓存 | SyncTV `synctv-proxy/src/slice_cache/range.rs` 的 ClientRangePlan、ContentRange | TongMu 已有 ByteRange、typed manifest、可选 slice-cache、validator 失效策略；本轮复核并修正真实长清单限制，没有重新移植 proxy |
| 播放时刷新短效地址 | ZViewer `backend/src/services/movie-direct-resolver.ts` 的 TTL cache、inFlight、挂载反查 | 已有对应服务；TongMu 用 durable movie reference、Provider 和 room grant 扩展，保持数据库/API 兼容 |
| B 站分集与画质确认 | ZViewer `frontend/src/modules/room/components/MoviePushPanel.tsx` 与 B 站 resolver | 保留现有领域实现，补通用入口自动识别和确认步骤，修复旧结果覆盖与重复点击 |
| HLS 播放生命周期 | ZViewer `frontend/src/modules/player/engines/hls-engine.ts` 的 attach/destroy | TongMu 已加 generation、资源清理和最高画质选择；本轮验证真实 1080p 与代理路径，不引入默认视频转码 |

这两套参考仍有可选能力未采用；采用清单中的历史 COMPLETE 只代表相应代码阶段，不能证明容器、真实外部账户或全部平台运行通过。

## 实际验证与限制

真实样本使用用户提供的 ODC 电影网页与 `playlist_1080p.m3u8`。显式外部测试由 `TONGMU_REAL_MEDIA_SMOKE=true` 启用，不使常规 CI 依赖外站。测试完成后暂停播放，不下载整部电影。

常规 E2E 继续保留 2 秒 token/grant 故障注入；真实外部测试使用 5 分钟测试会话预算，避免网络延迟反复触发故障注入。生产授权参数没有改变。

| 命令 | 实际结果 |
| --- | --- |
| `npm run build -w backend` | 通过 |
| `node --test backend/test/bilibili-media.test.js backend/test/media-protocol.test.js backend/test/phase3a-manifest.test.js backend/test/media-provider-fallback.test.js` | 67 通过；包含 SSRF/凭证跨域、取消/超时、画质保持、长清单、CONNECT 中断与慢 SPA |
| `npm test -w frontend` | 39 通过 |
| `npm run build -w frontend` | 通过；已有动态导入及大包警告 |
| `$env:TONGMU_REAL_MEDIA_SMOKE='true'; npx playwright test e2e/media-playback.spec.ts --grep 'authorized real ODC'` | 最终 2 通过（1.7 分钟）；网页 Browser→授权代理，直链 HLS→Direct。两者解码均为 1920×1080，播放时间分别超过 2.09/2.96 秒后仍保持 1080p |
| `npx playwright test e2e/media-playback.spec.ts e2e/release-stability.spec.ts` | 41 通过、3 跳过（4.2 分钟）；跳过的两项外站测试已按上一行单独执行，另一项为未启用可选 slice cache 的条件测试。保持生产解析限流，测试按真实 RateLimit 剩余额度等待 |
| `git diff --check` | 通过 |

Docker CLI 缺失，实际容器/GitHub Actions 未执行；没有推送、合并 main 或部署。真实样本验证不等于所有电影站点、会员账户、完整长时间播放或 Safari 验收。网页预览与播放仍可能重复进行浏览器解析，外站加载耗时明显；没有把这次短时播放表述成流畅性/性能或整部电影验收。日志包含未运行 CLI 的连接失败、初始匿名 401、MIME 和 bufferStalled 警告，不能宣称控制台零错误。

## 交付与审查

独立代码提交：`7c1344e` 为真实网页解析及原画质修复，`2c858bb` 为已核对消费者的旧模块清理，`a0a1597` 为链接预览与 E2E。文件及 diff 可用 `git show --stat <SHA>` 和 `git diff 6e38d9c..codex/package-completion` 审查。

自行审查了参数和 AbortSignal 传递、旧输入版本 fence、画质切换期间禁止提交、安全错误展示、Provider 权限及网络策略、highest sibling 选择、清单上限和 socket 清理。没有把测试产物、数据库、JWT 密钥或 references 加入提交。

2026-09-30 补完服务端持久幂等与主动取消清理后，本机处理和验证结果更新在 `local-completion-and-manual-acceptance-20260930.md`。剩余外部验收为实际 Docker/CI、真机跨平台及长时间真实播放；通用动态 playlist、新来源和大规模拆组件仍属于按需建议。本文上方测试结果是前轮记录，不替代最新提交的验收。
