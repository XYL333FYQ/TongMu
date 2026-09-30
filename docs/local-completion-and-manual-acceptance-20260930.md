# TongMu 本机整改完成与人工验收交接

## 在哪里测试

- 工作分支：`codex/package-completion`。
- 实际改动目录：`C:\Users\ss\.codex\worktrees\media-parser-a01-a02\TongMu`。
- 本轮开始提交：`17c2d838bcacaa286428a7947d96cea27ab646f4`。
- 原开发基线：`refactor/frontend-unification@a280e87d0ae5345c9339d4f1e3318bb955a59d9c`；本补充分支从累计整改 `6e38d9cc7d618ea325244faa4ff715a8b15287db` 建立。
- 原根目录的 `main@de403bbfe563dabe03cdbe2a196594b9ab44fb3c` 保持不变；在原目录运行 main 看不到本轮整改。
- 没有推送、合并 main 或部署。运行测试使用独立临时数据库；没有把生产数据库、密钥或 references 加入提交。

```powershell
Set-Location 'C:\Users\ss\.codex\worktrees\media-parser-a01-a02\TongMu'
git branch --show-current
git log -1 --oneline
```

## 本轮补完的缺口与原因

### F02：添加请求的持久幂等

按钮防连按只能防止当前页面同时提交。服务端已经建好影片但响应丢失时，用户再次点击仍可能重复创建。本轮用独立的添加请求编号解决，不按 URL 永久去重。

- `frontend/src/lib/movieSubmission.ts`、`store/roomStore.ts`：同用户、后端、房间、相同请求内容合并在途 POST；网络/未知服务端失败保留编号，重试复用；成功后清除，允许主动再次添加。冲突或明确无效请求后下一次操作使用新编号。
- `MoviePushPanel.tsx`：添加响应不确定时提示再次确认结果，不再误称链接解析失败。
- `backend/src/modules/movie/movie-create-idempotency.ts`、`movie.routes.ts`、`movie.service.ts`：权限先检查，再按用户/房间/编号查持久记录；影片与记录在同一事务提交。相同请求返回既有影片，内容改变或影片已删返回 409。没有编号的旧客户端保持原行为。
- `entities/MovieCreateRequest.ts`、`1790800000000-AddMovieCreateRequests.ts`、`data-source.ts`、`database-upgrade.ts`：添加一张私有请求记录表。保存编号哈希及加密的请求内容指纹，不保存原请求或密码/URL；原 V2 fingerprint 继续识别，真实执行新 migration，沿用升级前备份和密钥校验。
- 服务端记录随数据库重启保留，房间删除时级联清除；影片删除保留编号墓碑，防止迟到重试复活影片。记录不会进入 Movie DTO 或 Socket 广播。

边界：前端只在当前页面内保留最多 32 个失败请求，不把敏感请求存进 localStorage/sessionStorage。刷新页面、不同设备或编号被淘汰后，新操作使用新编号；不是跨设备按影片去重。房间长期保留时请求记录会增长。部署时数据库与 SecretVault key 必须作为一组保留。

### A01/A02 补充：取消和超时真正释放浏览器

旧实现只在页面加载后检查取消；卡在导航或响应 body 时仍占用浏览器。创建 page 又在 finally 外，失败时可能泄漏并发槽。

- `services/media/resolvers/browser.ts`：取消/到期主动关闭 context，并停止 probe；创建 page 纳入清理范围；关闭失败也归还并发槽。
- `routes/stream/media.ts`：完整 POST body 已读完后，客户端断开等待响应也会触发取消；请求结束移除监听器与定时器。
- 测试覆盖卡住导航、deadline、page 创建失败、真实 HTTP 断开。SSRF、跨域凭证、原画质、DRM 与源站限制策略保持原有边界。

## 压缩包与两个参考项目的处理结论

完整问题清单与前轮提交见 `remediation-20260929.md`、`package-followup-20260929.md`。A01/A02、F01–F13 的有效问题、S01、D01 的门禁代码及 R01/R02 消费者核对已处理或有具体适配决策；候选补丁没有机械覆盖当前源码。

SyncTV 的 Provider、播放能力同组匹配、会话生命周期、Range/manifest/cache 思路已适配；ZViewer 的房间、播放器、挂载刷新、B 站分集/画质、语音音乐基底保留并补回归。来源与许可见 `docs/integration-v2/upstream-adoption-matrix.md` 和 notices，参考目录只读。

报告对动态播放列表的原文是“真有多集需求再做动态播放列表”，对拆组件、新 Provider 也要求按可复现目标选择。当前 B 站分集和媒体库浏览已经存在；本轮没有额外加入通用动态合约、所有上游直播源或重写大组件。这些是未采用的可选建议，不是伪称实现完成。

## 本机实际验证

| 命令 | 实际结果 |
| --- | --- |
| `npm run build -w backend` | 通过 |
| `npm test -w backend` | Node 测试 168 通过、1 条条件跳过；迁移与 HTTP 专项另列如下 |
| `npm run test:migrations -w backend`（补完 HTTP 专项后） | 历史/升级/恢复 34 通过，幂等及 HTTP 断开专项 7 通过 |
| `npm test -w frontend` | 42 通过 |
| `npm run build -w frontend` | 通过；保留既有动态导入和大包警告 |
| `npx eslint frontend/src/lib/movieSubmission.ts` | 通过；三文件 lint 尝试报告 2990 项，包含旧文件 CRLF/组件规则及新增行格式问题；没有大面积格式化旧文件，不把这些全算成旧问题，也不宣称全量 lint 通过 |
| 本机 `node backend/dist/index.js --browser-runtime-smoke` | Chromium 启动通过 |
| 本机 `--browser-resolver-smoke` | GenericWeb 失败 → Browser；false 禁用；Direct 不变，均通过 |
| 本机 `--media-runtime-smoke` | Direct/HLS/DASH 探测通过；这是本机 fixture，不是 Docker 结果，也不是完整解码证明 |
| `$env:SLICE_CACHE_E2E='true'; $env:SLICE_CACHE_ENABLED='true'; npx playwright test e2e/media-playback.spec.ts e2e/release-stability.spec.ts` | 最终 43 通过、2 跳过（4.4 分钟）；仅跳过用户交接的两项 ODC 外站测试；可选缓存读取复用/身份隔离也通过 |
| `git diff --check` | 通过 |

浏览器测试明确模拟过响应丢失，确认重试同编号、同影片 ID、列表仅一条。两秒 token/grant 故障注入保持启用；401/403 先走原有刷新流程，不改生产时限。全套中两项旧测试曾失败，单独复跑通过；进一步修正影片列表加载等待和限定失败来源的模拟，保留真实正常来源解析。

前轮 ODC 网页与直链的真实播放都测到 1920×1080 且时间前进；本轮用户要求将真实验收交给本人，因此没有用前轮短时结果宣称新提交的真机/长播放验收完成。

## 交给你的验证

### 1. 真实电影、手机与观众

在上述改动目录启动测试实例（不要在仍为 main 的原目录测试）：

```powershell
$env:CONFIG_DIR = Join-Path $env:TEMP 'TongMu-manual-acceptance-20260930'
$env:DATABASE_URL = Join-Path $env:CONFIG_DIR 'test.sqlite'
$env:MEDIA_BROWSER_RESOLVER = 'true'
npm run dev
```

这些变量把数据放入独立测试目录并启用网页浏览器解析。浏览器访问启动日志给出的前端地址，使用测试账号与空测试房间：

1. 分别添加 ODC 电影网页和你提供的 `playlist_1080p.m3u8`，先预览再确认，确认视频真实尺寸为 1920×1080；不能仅凭“1080p”文字或文件名判断。
2. 播放至少 15 分钟，拖动到电影后段、暂停/恢复，观察是否持续缓冲或自动降到 720p。浏览器控制台可读取实际播放器尺寸：`[...document.querySelectorAll('video')].map(v => ({width:v.videoWidth,height:v.videoHeight,time:v.currentTime}))`。
3. 第二设备/观众加入，房主切换 B 站分集与画质，确认观众同步；观众键盘方向键请求拖动仍遵守房主权限。
4. 手机打开添加区、拉起软键盘、横竖屏切换、关闭抽屉；播放器不重置，按钮仍可见。Safari/iPhone 和安卓各测一次。
5. 切断网络后恢复再点“添加”，检查没有重复条目；取消解析后再解析，检查没有一直提示浏览器忙。每个需登录来源用自己的合法账号测，不提供 DRM 绕过。

记录设备/浏览器、时间、网址、实际尺寸、失败提示/requestId；不要分享 cookies、带签名完整播放 URL、JWT 或数据库密钥。

### 2. Docker 容器

本机没有 Docker CLI，以下未执行。只使用新的隔离项目名/测试 volume；先保证本机 3333/3334 端口空闲，保留原生产实例和 config。

```powershell
# 如果当前改动目录还没有 .env，再复制示例，已有 .env 不覆盖。
if (!(Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
$env:TONGMU_BUILD_SHA = git rev-parse HEAD
docker compose -p tongmu-acceptance-20260930 config --quiet
docker compose -p tongmu-acceptance-20260930 up -d --build
Invoke-RestMethod http://127.0.0.1:3333/health
docker compose -p tongmu-acceptance-20260930 exec -T tongmu node backend/dist/index.js --browser-runtime-smoke
docker compose -p tongmu-acceptance-20260930 exec -T tongmu node backend/dist/index.js --browser-resolver-smoke
docker compose -p tongmu-acceptance-20260930 exec -T tongmu node backend/dist/index.js --media-runtime-smoke
docker compose -p tongmu-acceptance-20260930 up -d --force-recreate
```

health 的 commitSha 应与刚才 HEAD 完全一致，三个 smoke 应返回 `ok:true`。重建后测试影片/账号仍应存在。实际历史数据库升级请先完整备份整个 config 与密钥，在隔离副本验证；CI 的 Docker workflow 已包含历史 fixture 与恢复后数据核对。结束仅停止该测试项目：`docker compose -p tongmu-acceptance-20260930 down`，不删除 volume。

### 3. GitHub Actions 与发布门禁

未推送，不能在本机宣称在线 CI 成功。由你在独立测试仓库/分支发起 PR 或手动运行 Docker workflow，记录运行链接与 SHA。验证 Docker 失败时 CI 失败、故意破坏 A01 后 fixture 阻止门禁；同 SHA 的 CI 成功前不能发布。故障注入只在丢弃式测试分支做，不修改本交付分支，不合并 main 或开启生产部署来证明门禁。

## 自审与未验证风险

已核对：请求编号全链路、旧 API 无编号兼容、角色权限先于重放、事务回滚、重启读取、已删除影片墓碑、秘密不进入 DTO/明文指纹、原 V2 升级路径与新 entity 的 schema 一致性、取消/超时清理、同质量 transport fallback。新增记录只读写现有 config 数据库，Docker volume 语义保持不变。

还需你的证据：真实 Docker/在线 CI、实际历史运行数据副本、Safari/真机软键盘/屏幕阅读器、会员来源与长期播放。更大的 manifest 资源预算、外站重复解析开销、SQLite 旧空闲页/旧备份敏感内容及未识别的站点自定义敏感参数仍按前轮风险说明保留。构建成功不能替代这些验收。
