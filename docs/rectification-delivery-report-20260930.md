# TongMu 整改交付汇总报告

**日期：2026-09-30**

**核对材料：《TongMu_两轮整合复审交付包_20260929.zip》**

**交付代码分支：`codex/package-completion`**

**交付代码提交：`481b73d6b22c7e6fe821357e6cdb1c9e8121a942`**

## 一、交付结论

本次保留 TongMu 已有媒体整合架构，以真实电影网页解析与原画质播放为主线，完成交付包中已确认问题的代码整改、适用建议的选择性实施和本机验证。最初阶段限定的 A01、A02 已修复；后续依照用户追加要求，继续完成添加影片正确性、隐私与存储保护、交互可用性、发布门禁代码及必要的旧模块清理。

交付包的 20 个问题编号均已建立处理记录。完成情况需要按以下三种状态理解：

1. **代码完成并有本机验证**：解析降级、参数传递、旧结果覆盖、重复提交与持久重试、统一预览、安全错误、敏感数据迁移、原画质选择等。
2. **代码或局部验证完成，完整验收待补**：Docker/在线 CI、真机与 Safari、人工屏幕阅读器、观众键盘操作、真实历史运行数据及长期播放。
3. **选择性采纳或保留为后续建议**：大型组件拆分、通用动态播放列表、新 Provider 和其他上游扩展能力。本次没有把所有建议全部实现，也没有把两个参考项目的全部功能搬入 TongMu。

可用于交差的准确表述：

> TongMu 已按交付包完成当前源码核对与本机整改，修复统一网页解析、原画质选择及添加影片正确性问题，补齐敏感存储和交互保障，并完成自动回归及构建。代码保存在独立修复分支，未推送、未合并 main、未部署。实际 Docker/在线 CI、真机跨平台和长时间真实播放仍需人工验收；通用动态播放列表等按需扩展建议保留为后续范围。

## 二、压缩包是怎样阅读与核对的

### 2.1 读取的材料及作用

压缩包包含 13 个文件，主要材料如下：

| 材料 | 阅读和使用方式 | 核对结论 |
| --- | --- | --- |
| `请先看_交付说明.txt` | 确认阅读顺序、材料用途、构建与浏览器验证边界 | 包内补丁是候选，HTML 是交互原型，旧报告没有完成真实项目运行验收 |
| `TongMu_两轮合并审计与前端改造路线_20260929.md` | 作为合并、去重后的主清单，按 A/F/S/D/R 编号核对 | 共 20 个编号；逐项区分真实故障、交互缺口、设计建议与验收要求 |
| `附录_第一轮三轮详细审计.md` | 阅读架构、SyncTV/ZViewer 对照、安全与发布背景 | 用于理解现有架构和建议的来源，不能替代当前源码验证 |
| `TongMu_两轮合并_UI_原布局与改造交互示意_20260929.html` | 核对入口顺序、桌面/手机布局和交互建议 | 是可点击示意，不是真实产品截图；当前房间工作区已有后续前端成果，按实际页面调整 |
| `候选补丁与复现/TongMu_解析主链最小修复_候选.patch` | 阅读每个修改点，追踪真实调用链并与当前实现比较 | A01 的 `return await` 和 A02 的两层参数传递适用；最终实现进一步保留取消、安全错误和来源兼容策略 |
| `TongMu_解析降级回归复现.cjs`、`TongMu_媒体解析回归测试.test.cjs` | 理解隔离复现与测试目标，补入项目自己的测试体系 | 扩展到真实 HTTP fixture、Chromium、false/true、取消/超时和正常来源回归 |
| `复核证据/` 中的构建、安装、单测和静态扫描材料 | 核查报告实际执行了什么、哪些结论只来自静态分析 | 包内 30/30 测试、语法检查、构建失败和 npm 缓存不足均有明确边界；没有把缺依赖误报为产品代码故障 |

### 2.2 没有直接照套报告的原因

合并报告说明，其 TongMu 上传快照记录的是 `main@de403bbfe563dabe03cdbe2a196594b9ab44fb3c`，包内不含 `.git`。它不能证明当前开发分支、真实 HEAD 或已部署版本。

因此实际流程是：读取当前 Git 状态和分支关系 → 选择包含前端有效成果的基线 → 阅读具体调用文件及现有测试 → 复现确认问题 → 最小修改 → 回归、构建、自审、独立提交。已存在的能力继续保留；静态不可达候选先检查消费者；报告中的操作建议不会自动扩大用户授权范围。

候选补丁提供了正确的两个核心方向。最终修改与它在 A01/A02 上一致，但测试覆盖和后续处理更完整：真实网页失败后的 Browser 回退、显式禁用、错误分类、资源释放、正常来源兼容都进入项目回归。没有执行一次覆盖式套补丁来代替核对。

## 三、两条分支怎样处理

| 项目 | 实际状态 |
| --- | --- |
| 原根目录 main | `de403bbfe563dabe03cdbe2a196594b9ab44fb3c`；未合并、未覆盖 |
| 选用开发基线 | `refactor/frontend-unification@a280e87d0ae5345c9339d4f1e3318bb955a59d9c` |
| 分支共同祖先 | 与上述 main SHA 相同 |
| 前端分支独有提交 | `13fbc5c` 保存阶段 2C 前端成果；`16e8e4a` 管理界面统一；`a280e87` 房间工作区与退出流程统一 |
| 已有媒体成果 | Emby/Jellyfin `3ac1df3`、类型化 HLS/DASH `be4e9cd`、manifest/proxy/slice-cache `75a26e6`；均沿用 |
| 最新修复分支 | `codex/package-completion`；阶段性分支保留为检查点 |
| 实际修改目录 | `C:\Users\ss\.codex\worktrees\media-parser-a01-a02\TongMu` |
| 最新代码提交 | `481b73d6b22c7e6fe821357e6cdb1c9e8121a942` |

检查结果支持从前端统一分支继续整改：它在 main 基础上包含额外有效前端成果。开发过程中保留 Provider、MediaDescriptor、客户端 PlaybackPlan、room grant、播放器和房间生命周期。没有发生强行合并、Git 重置、生产 config 覆盖或 references 源码导入。

**测试时必须使用修复 worktree。原根目录仍是 main，在那里直接启动不会自动得到这些整改。**

## 四、压缩包 20 项问题的最终处理表

“本机通过”只指下面测试矩阵中覆盖的行为，不等于全部平台、全部网站或生产验收。

| 编号 | 报告问题 | 本次处理 | 完成状态与边界 |
| --- | --- | --- | --- |
| A01 | GenericWeb 异步失败中断 Provider 回退 | try 内等待 `provider.resolve`，失败进入已有降级判断；取消/安全错误终止；补 HTTP 和 Browser fixture | 代码完成，本机回归通过 |
| A02 | browserSniff 在新旧适配层丢失 | HTTP → ResolverContext → ProviderContext → LegacyResolverAdapter → Browser 保留明确 true/false | 代码完成；true 回退、false 禁用、Direct 不变均通过 |
| A03 | 解析失败没有稳定、安全的错误契约 | 白名单 code、安全 message、requestId、retryable；按已知事实分类 | 代码完成，本机通过；不根据未知站点异常猜测会员/DRM原因 |
| F01 | 输入变更后旧预览仍可能提交或覆盖 | 输入版本检查、清空过期结果、忽略旧响应；补取消信号 | 代码完成，快速输入切换与旧响应回归通过 |
| F02 | Enter/多入口重复提交；断网重试重复创建 | 函数入口防并发、API 层合并、独立请求编号、服务端持久记录、事务、冲突和删除墓碑 | 代码完成；连按、8 次并发、响应丢失、重启重放、权限和删除回归通过 |
| F03 | 普通 URL 和 B 站添加节奏不一致 | 普通链接先解析/预览/确认；自动识别 B 站后复用分集与画质选择 | 代码完成，本机真实页面交互通过；媒体库/番剧保留领域选择流程 |
| F04 | 默认诊断技术化且可能泄露地址 | 普通面板不显示能力 URL/原始异常，提供可操作消息；高级诊断脱敏 | 代码完成，敏感字符串回归通过；不宣称所有运行日志完全无敏感风险 |
| F05 | 手机房主添加入口不显眼 | 在播放器附近增加房主入口，切换已有工作区 | 代码完成，手机尺寸 E2E 验证播放器没有重挂；真机待测 |
| F06 | 播放进度缺少键盘操作 | slider 焦点、方向键/Home/End、时间描述，沿用房主/观众权限 | 代码完成，房主键盘通过；观众键盘及辅助技术人工验收待补 |
| F07 | 弹层焦点与键盘生命周期不完整 | dialog 语义、初始焦点、Tab 圈定、Esc、关闭后恢复焦点 | 代码完成，弹层及嵌套删除确认 E2E 通过；人工屏幕阅读器待测 |
| F08 | 输入/下拉控件语义和键盘不足 | 标签与错误关联，listbox/option、展开状态、键盘选择及焦点恢复 | 代码完成，现有消费者回归通过；无实际消费者的组合不伪称已实测 |
| F09 | 影片列表来源文案和删除操作不足 | 中文来源名称、手机空态、删除确认 | 代码完成，本机通过 |
| F10 | 添加成功后的输入/重复操作语义不统一 | 普通链接和 B 站成功后统一清空；结果不确定时允许同编号重试 | 代码完成，本机通过；成功后有意重复添加使用新编号 |
| F11 | 未连接媒体来源不可发现 | 保留入口，提示连接方式与房主权限，链接到个人空间 | 代码完成，本机通过；未连接时不伪装为可播放 |
| F12 | 旧布局、手机软键盘和多终端可用性风险 | 核对当前工作区，验证 360/390/430 竖屏与 844×390 横屏、滚动/聚焦和截图 | 当前布局已有成果，避免重复改；本机尺寸测试通过，Safari/真机软键盘待验收 |
| F13 | 主站品牌入口仍指向上游 | 主 GitHub 入口改为 TongMu，保留上游鸣谢与 CLI 地址 | 代码完成；许可与实际依赖信息保留 |
| S01 | 旧影片密码、敏感地址和短效 handle 存储不统一 | SecretVault 兼容迁移、敏感 URL/headers 加密、durable movie reference、备份/恢复与 key 校验 | 代码完成，历史 fixture/回滚/恢复通过；真实运行数据库副本待验收 |
| D01 | Docker 烟测没有真正阻拦自动发布 | CI 调用同 SHA Docker smoke，自动 deploy 等待完整 CI，保留旧 SHA 检查 | 门禁代码完成并核对；Docker/在线 CI/故障注入阻断部署未执行 |
| R01 | 大组件维护风险 | 只提取 B 站预览组件，保留正常挂载/解析/房间流程 | 选择性采纳；没有按行数重写全部组件 |
| R02 | 11 个静态不可达模块候选 | 核对 import、路由、脚本、测试、替代实现后删 8 个，保留 3 个导出/兼容边界 | 消费者核对与有限清理完成；构建及功能回归通过 |

## 五、主要修改怎样改善实际行为

### 5.1 网页解析能够继续走到 Browser

过去 GenericWeb 返回一个稍后失败的 Promise，注册中心已经把它直接返回，外层 try 没等到失败，因此不会尝试下一个 Provider。另一个断点是 `browserSniff=true` 穿过适配层时丢失，Browser 看不到用户已启用嗅探。

修复后，同一次解析请求可以从 GenericWeb 的“静态 HTML 没有媒体”继续进入 Browser 的动态网络发现。false 仍保持关闭。访问安全拦截、取消和超时不会借回退重新尝试绕过限制。

主要文件：`backend/src/services/media/providers/{registry,types,legacy-resolver-adapter}.ts`，以及 `backend/test/media-provider-fallback.test.js`。

### 5.2 原画质和真实电影长清单

用户提供 ODC 网页与 1080p HLS 直链后，真实验证发现了报告候选补丁没有覆盖的三个问题：

1. 网页 API 同时返回 720p/1080p，旧评分可能先选中 720p。现在 GenericWeb/Browser 共用同系列候选排序，保留已发现的最高画质；低清同系列不作为隐式探测降级。不猜造 1080p 地址，也不把不相关高分辨率广告当主片。
2. 107 分钟电影的 1080p 清单含 1066 个分片，超过原 1000 资源上限，代理重写时返回 502。默认有限预算调到 10000；4 MiB 输入限制、深度与 URL/授权检查保留，并测试超限仍拒绝。
3. 慢网页可能在最初 5 秒以后才发媒体 API。只在没有候选时延长观察，最多再等 10 秒，并受原 deadline 和取消约束。

主要文件：`services/media/candidates.ts`、`resolvers/{generic-web,browser}.ts`、`manifest/mapper.ts`。

前轮实际播放两个样本均得到 **1920×1080**，播放时间前进超过 2 秒。这个结论是短时解码成功；完整电影、15 分钟以上稳定性、会员来源和 Safari 仍需验收。当前选择规则不能保证任意未知网站都能识别最高画质。

### 5.3 浏览器故障与取消释放

真实站点 CONNECT 连接曾触发 `write ECONNABORTED` 并使开发后端退出。补上上下游错误处理、双向 socket 清理和活动 tunnel 销毁；目标验证、公共 DNS 检查与固定到已验证 IP 的策略保留。

后续专项发现，旧取消逻辑只能在导航结束后检查信号，page 创建失败还可能泄漏并发槽。本轮将 page 创建纳入清理，取消/deadline 主动关闭 context 并停止 probe；完整 POST 已提交、客户端断开等待响应，也会取消服务端解析。

主要文件：`resolvers/browser-safe-proxy.ts`、`resolvers/browser.ts`、`routes/stream/media.ts`；测试覆盖停住导航、超时、page 创建失败和真实 HTTP 断开。

### 5.4 添加流程与重复请求

例如用户粘贴 A 后立刻改成 B，A 的慢响应不能再覆盖 B 的预览；确认添加必须使用当前输入对应的结果。通用入口识别 B 站后可以选择集数、画质，再确认加入。

重复添加分两种情况：

- 连续 Enter/双击：共享在途请求，只发一个 POST。
- 服务端已经创建但前端没收到响应：复用同一个请求编号；服务端返回原影片 ID，不创建第二条。

成功后主动再添加同一 URL 会生成新编号，因此合法的重复条目和不同分集不被永久禁止。不同内容复用编号、已删除影片的迟到请求返回 409。权限始终先检查，服务端记录不会进入公开 DTO。

主要文件：`MoviePushPanel.tsx`、`BilibiliLinkPreview.tsx`、`roomStore.ts`、`lib/movieSubmission.ts`、后端 movie 路由/服务、`movie-create-idempotency.ts`、`MovieCreateRequest.ts` 及新 migration。

边界：前端失败编号只保留在当前页面内，最多 32 个；刷新、其他设备或记录淘汰后的新操作生成新编号。服务端记录随数据库持久保存，房间删除时清除。没有承诺跨设备永久按影片去重。

### 5.5 密码、地址、诊断和数据库兼容

旧 Movie 密码迁移到现有 SecretVault；带已知敏感参数的 Movie/PlaybackState 地址和播放 headers 加密。可重新解析的短效地址改用持久的影片引用，在需要播放时由服务器重新解析。

普通公开直链继续允许 Direct；私有凭证留在服务器。新幂等表只存编号哈希和加密的内容指纹，不保存原请求内容。升级前备份、旧 key 读取、新 key 校验、失败回滚和恢复保持显式流程，未知 schema 不猜测升级。

新增/调整 migration：`1790600000000-EncryptMoviePasswords`、`1790700000000-ProtectMovieUrls`、`1790800000000-AddMovieCreateRequests`；配套调整 `Movie.ts`、`PlaybackState.ts`、`movie-url-storage.ts`、data-source、upgrade/restore。

### 5.6 有限清理旧模块

删除的 8 个模块：DirectSharePage、DirectWatchPage、ConnectionStatsPanel、StreamStatusPanel、signalingApi、WebDAVMountPanel、OpenListMountPanel、useAppStore。

这些模块经过实际消费者检查；当前 SharePage/WebRTC、MountManager/MountFormModal、authStore 等有效实现保留。`danmaku/index`、`server-files/index` 和 `useStreamPush` 是导出或兼容边界，因此保留。B 站预览被提取为小组件，播放器、挂载、房间同步没有按“文件太长”全面重写。

### 5.7 回归额外发现的 DASH 认证问题

DASH 模板 URL 先把 `&` 转成 `&amp;`，XMLSerializer 又转义一次；认证参数还被重复追加。结果出现错误的参数名和分片 403。

修复后 URL 拼装交给 XML 序列化做一次转义，token/grant/sourceGeneration 只保留一份，DASH 模板占位符保持完整。真实 XML 属性解析回归在修改前失败、修改后通过。

主要文件：`backend/src/routes/stream/media.ts`；独立提交 `9059493`。

## 六、SyncTV 与 ZViewer 的取长补短结果

参考源码在根 checkout 的 `references/synctv-main`、`references/ZViewer-main`，保持只读。项目已有采用台账、源头记录、上游 notes 和第三方 notices；历史 COMPLETE 标记只代表对应阶段实现，不代替当前运行验收。

| 参考项目与能力 | TongMu 的处理 | 本次新增或复核 |
| --- | --- | --- |
| SyncTV Provider 与上下文 | 适配到 TypeScript registry/providers，统一来源解析与私有凭证上下文 | 修复异步降级、browserSniff、取消和错误边界；没有重新搬 Rust 服务 |
| SyncTV 按容器/codec/pipeline 同组匹配 | 已有 playback-profile、客户端 profile、localPlanner；房间共享事实，各客户端选自己的方案 | 保留，回归验证能力匹配和 Direct/Proxy 同画质 |
| SyncTV 播放会话生命周期 | 已有 provider 会话 start/progress/cleanup 与 generation 约束 | 保留，不给无会话来源伪造会话能力 |
| SyncTV Range/manifest/slice cache | 已有 ByteRange、typed HLS/DASH、缓存与 validator 策略 | 修复长清单，执行缓存复用与身份隔离 E2E |
| ZViewer 房间/播放器/语音音乐 | 保留既有领域基底和同步/权限生命周期 | 添加入口切换不重挂播放器；未整体重写 |
| ZViewer 短效媒体刷新与挂载反查 | 沿用服务，以 durable movie reference、Provider、room grant 扩展 | 敏感持久存储和授权刷新回归 |
| ZViewer B 站分集与画质 | 保留已证明合理的操作与解析路径 | 通用入口自动识别并进入同一预览、分集和画质确认流程 |
| ZViewer HLS attach/destroy | 保留并配合 TongMu generation/资源清理与最高画质规则 | 同画质回退、播放生命周期和真实 1080p 验证 |

通用动态播放列表合约、更多高频站点适配、完整上游直播/运营管理和大规模组件拆分尚未实现。交付包把这些列为按可复现目标选择的后续能力；当前 B 站分集与媒体库浏览已有独立实现，本次没有增加重复流程。

## 七、实际测试结果与证据

依赖已在整改环境安装。下面以最终代码阶段的结果为准；旧包的 30 项单测、旧文档的 39/41 项结果属于历史记录，不与最终结果相加。

| 命令 | 实际结果 | 主要证明范围 |
| --- | --- | --- |
| `npm test -w backend` | **168 通过，1 跳过**；同时执行后面两套专项 | Provider、协议、manifest、来源兼容、隐私与安全策略等既有/新增 Node 测试 |
| `npm run test:migrations -w backend` | **34 项迁移通过 + 7 项幂等/HTTP专项通过** | 历史 schema、身份/数据保留、key/回滚/恢复；并发、重启、冲突、删除、权限、旧客户端和断开取消 |
| `npm test -w frontend` | **42 通过** | 播放规划、生命周期、权限、API提交合并和重试编号等 |
| `npm run build -w backend` | 通过 | 后端 TypeScript 编译 |
| `npm run build -w frontend` | 通过；有既有动态导入和大包警告 | 前端类型检查和生产构建；不代替功能验收 |
| `npx eslint frontend/src/lib/movieSubmission.ts` | 通过 | 新增提交 helper 的定向 lint |
| 三个改动前端文件的 lint 尝试 | 报告 2990 项，包含 CRLF/组件规则和新增行格式问题 | 没有大面积格式化旧文件；不宣称全量 lint 已通过 |
| 启用 `SLICE_CACHE_E2E=true`、`SLICE_CACHE_ENABLED=true` 后运行媒体和稳定性 E2E | **43 通过，2 跳过，约 4.4 分钟** | 真实本机浏览器/HTTP/媒体 fixture，含 Direct/Gateway、HLS/DASH、Browser、提交、交互与缓存 |
| 本机 `--browser-runtime-smoke` | `ok:true` | Chromium 能启动 |
| 本机 `--browser-resolver-smoke` | `ok:true` | GenericWeb失败 → Browser、false禁用、Direct正常 |
| 本机 `--media-runtime-smoke` | `ok:true` | Direct/HLS/DASH探测；不是Docker或完整解码证明 |
| 前轮显式 ODC 外站 E2E | **2 通过，约 1.7 分钟** | 网页与直链均短时解码为1920×1080并播放前进 |
| `git diff --check` | 通过 | diff 无空白格式错误 |

完整 E2E 的两项跳过是 ODC 外站用例；用户要求最新真实验收由本人接手，因此本轮没有重新执行它们。后端另有一条测试跳过，不把跳过项算作通过。

测试过程如实记录过失败：DASH 认证和长清单先失败后修复；两项旧 E2E 曾批量失败、隔离复跑通过，随后修正影片列表加载等待和故障模拟范围，最终完整套通过。两秒 token/grant 故障注入及每分钟 20 次解析限制保留，没有靠放宽生产参数使测试通过。

本机证据位置：

- `%TEMP%/TongMu-final-backend.log`
- `%TEMP%/TongMu-final-frontend-test.log`
- `%TEMP%/TongMu-final-frontend-build.log`
- `%TEMP%/TongMu-final-local-e2e.log`
- `%TEMP%/TongMu-final-migrations.log`
- `%TEMP%/TongMu-real-ODC-1080p.log`（前轮真实站点）

测试产物和日志不进入 Git。日志含初始匿名 401、故障注入 403、CLI 连接失败、MIME/缓冲警告，不能写成控制台零错误。临时日志可能被系统清理；可使用提交中的测试重复生成证据。

## 八、独立提交与审查入口

| 提交 | 主要内容 |
| --- | --- |
| `f0ecade` | A01/A02 解析回退与参数传递 |
| `bb39f87` | 旧输入结果检查、客户端防重复添加 |
| `1994a49`、`e621ed4` | 诊断隐私、安全错误契约 |
| `68be449` | 同 SHA Docker/CI 发布门禁代码 |
| `1138264`、`d106ab2` | Movie密码、敏感URL/headers与兼容迁移 |
| `33db767`、`aef087e`、`12d37fd`、`e23ea54`、`218ebe2`、`1683a60`、`aa92d02` | 来源发现、手机入口、键盘/弹层/基础控件、文案删除与手机回归 |
| `9059493` | DASH XML认证参数修复 |
| `7c1344e` | 真实网页原画质、长清单、慢SPA与CONNECT清理 |
| `2c858bb` | 核对消费者后删除8个旧模块 |
| `a0a1597` | 通用链接识别、预览、确认与E2E |
| `481b73d` | 持久重试、API并发合并、主动取消清理、迁移/HTTP/浏览器回归与交接文档 |

对比原开发基线 `a280e87` 到交付代码 `481b73d`：**71 个文件，新增 2752 行、删除 2515 行**，含文档、测试及 8 个旧模块删除；该数字不能解读成全部是业务代码重写。

```powershell
Set-Location 'C:\Users\ss\.codex\worktrees\media-parser-a01-a02\TongMu'
git show --stat 481b73d
git diff --stat a280e87..481b73d
git diff a280e87..481b73d -- backend/src/services/media
```

本报告是对上述代码提交的汇总；后续仅修改文档的提交不会改变这里记录的代码验收 SHA。

## 九、未完成验收与已知边界

| 项目 | 未完成原因/边界 | 接手动作 |
| --- | --- | --- |
| 实际Docker、容器Chromium、容器重建持久性 | 本机没有Docker CLI | 按交接文档在隔离Compose项目执行三个smoke、health SHA和重建检查 |
| 在线CI与故意引入A01阻断发布 | 未推送，没有GitHub运行证据 | 在测试仓库/分支运行；记录SHA/链接；故障注入不得触及生产分支 |
| Safari/iPhone/安卓真机、软键盘与辅助技术 | 本机viewport/键盘测试不覆盖真实设备环境 | 按交接步骤测试，记录设备、浏览器及现象 |
| 长期真实播放、会员来源与所有站点 | 只有用户提供的两个合法ODC短时样本验证 | 最新代码下复测原画质、至少15分钟播放、后段拖动及第二设备同步 |
| 真实历史运行数据库 | 已通过Git证据构建的fixture，未拿生产数据库做写验证 | 完整备份config和key，在隔离副本验收升级/恢复 |
| 全仓库lint与包大小 | 已有大量格式/规则和构建警告 | 留为独立维护范围，本次没有为清零告警扩散修改 |
| 动态playlist、新Provider、大规模拆组件 | 报告为按需建议，未实施全部扩展 | 有明确产品需求、样本和验收标准后再开范围 |

继续保留的技术风险：外站预览/播放可能重复解析且耗时明显；更高manifest资源预算增加输出与CPU开销；前端请求编号不跨页面/设备保存；幂等记录随房间长期保存会增长；旧SQLite空闲页和旧备份不被清理；敏感URL识别依赖已知参数，不能保证覆盖所有站点自定义字段。

没有新增默认视频转码、DRM绕过或源站访问限制绕过。Direct/Proxy传输回退保持同representation/quality；源站只提供720p或最高候选不可用时，不能虚构1080p或无条件承诺原画质成功。

## 十、交付文件与下一步

本报告是用于交差的汇总入口。详细材料仍保留：

- `docs/remediation-20260929.md`：第一轮逐项核对、提交与历史验证边界。
- `docs/package-followup-20260929.md`：后续适配、两个参考项目复核及ODC真实样本记录。
- `docs/local-completion-and-manual-acceptance-20260930.md`：最新补完、测试目录、Docker命令及人工验收步骤。
- `docs/integration-v2/upstream-adoption-matrix.md`、`provenance-inventory.md`、上游notes与notices：能力采用、源头及许可记录。

本次交付状态为：**代码整改及本机验证完成，独立分支可审查，外部与人工验收待补；尚未发布生产。**
