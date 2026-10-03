# TongMu 最终整合与界面整改交付记录

更新日期：2026-10-03。本记录保存最终源码、本机回归和内置浏览器验收的证据。GitHub 检查必须对应交付提交的同一 SHA；远程运行链接、本地/远程一致结果及部署未触发结论随最终交付回复提供，不把推送前的工作流配置当成运行成功。

## 交付范围与整合结论

本轮围绕“发现房间 → 创建或加入 → 选择内容 → 一起看、听音乐或投屏 → 返回或明确退出”统一房间行为、权限和界面。品牌保持英文 TongMu；产品支持中英文，首次进入默认中文，语言偏好持久保存。切换语言不改变用户输入、房间内容或播放会话。本交付说明使用中文。

两个本地参考目录保持只读。采用的是经检查的能力和设计长处，不是完整复制两个上游项目。媒体仍遵循原画质优先、Direct 优先、Gateway 回退不降画质；私有凭证保留在服务端，房间共享媒体描述，客户端独立生成播放方案，BrowserResolver 保留。逐项采用、修复、暂缓及未验证范围见 [整合复核](final-integration-review.md) 和 [采用矩阵](upstream-adoption-matrix.md)。参考归档没有 Git 元数据，因此不声称认证其上游精确提交。

## 需求与实现对应

以下路径均相对 TongMu 根目录，便于在当前源码中复查。

| 需求 | 工作方式与主要文件 | 对应验证 |
| --- | --- | --- |
| 创建与访问规则 | `backend/src/modules/room/room-policy.ts`、`backend/src/modules/room/handlers/room-lifecycle.handler.ts`、`frontend/src/components/JoinRoomDialog.tsx`：名称、临时/固定、公开/私密、协作预设及高级限制；服从平台创建资格 | 房间策略、访客、创建资格和迁移测试 |
| 发现、密码与审核 | `backend/src/routes/rooms.ts`、`backend/src/modules/viewer/handlers/viewer-join.handler.ts`、`frontend/src/pages/HallPage.tsx`、`frontend/src/modules/room/guestNickname.ts`：私密房间不进入公开目录，精确房间号/邀请可访问；游客昵称复用 | 授权、加入与完整 E2E；Firefox/WebKit 重点流程覆盖密码重试、审核、满员和登录限制 |
| 协作与内容来源 | `backend/src/modules/room/permission-core.ts`、`room-permission.service.ts`、`frontend/src/modules/room/components/MoviePushPanel.tsx`：服务端授权；统一选片入口，可入队或播放；仅共享选入房间的内容，不公开完整私人媒体库 | HTTP/socket 串行授权、权限撤销、私人来源及前端提交回执测试 |
| 三种活动 | `backend/src/modules/room/room-experience.service.ts`、`backend/src/modules/music/music-sync.service.ts`、`frontend/src/modules/room/components/RoomLayout.tsx`：切走视频/音乐时暂停并保留进度和列表；投屏停止后需手动重开 | 活动切换、失活播放器、音乐时序及资源释放测试 |
| 请求与意见投票 | `backend/src/modules/room/activity-poll.ts`、`backend/src/modules/room/handlers/room-experience.handler.ts`、`frontend/src/modules/room/components/ActivityDiscussion.tsx`：成员请求，主持接受/拒绝/发起默认 60 秒投票；每人一票可修改，结果不自动切换 | 成员身份、修改投票、超时与切换失效测试 |
| 房主与临时代理 | `backend/src/modules/room/room-session.service.ts`、`backend/src/modules/room/room-experience.service.ts`：断线 30 秒按实际房间权限选代理，同权限随机；原房主返回恢复，正式转交后不收回；游客代理不获得所有权管理权限 | 代理权限、回归主持、正式转交、旧 socket 延迟断开竞态测试 |
| 保留与清理 | `backend/src/entities/Room.ts`、`backend/src/entities/MusicRoomState.ts`、`backend/src/modules/playback-memory/playback-memory.service.ts`：临时房间空置 24 小时清理，返回取消计时；固定房间保留设置、队列和进度，无人时释放活动资源；聊天不长期保存 | 空房计时、固定房间恢复、运行时缓存清理及真实数据库测试 |
| 导航与明确退出 | `frontend/src/modules/room/RoomRuntime.tsx`、`frontend/src/modules/room/leaveRoom.ts`、`frontend/src/components/ReturnToRoomButton.tsx`、`frontend/src/lib/mediaTeardown.ts`：普通导航保留房间和已启动媒体；状态条提供返回、静音、停止共享、退出；换房先处理当前房间 | 房间生命周期、媒体 teardown 和完整浏览器回归，包含播放时导航、投屏及语音资源释放 |
| 旧数据与接口兼容 | `backend/src/migrations/1790900000000-AddRoomExperience.ts`、`backend/src/migrations/database-upgrade.ts`：增量迁移，兼容旧事件/路由及原有访问限制，不因品牌改名破坏数据库 | 34 项迁移测试、7 项影片幂等回执测试 |
| 全站视觉与交互 | `frontend/src/styles/tongmu-experience.css`、`frontend/src/components/AppNavigation.tsx`、`frontend/src/modules/room/components/RoomLayout.tsx`、`frontend/public/tongmu-mark.png`：统一背景、品牌、间距和状态反馈；大厅直接承载使用，账户/房间/平台设置分层；中英文及共享动效见 `frontend/src/i18n/`、`frontend/src/components/ui/motion.ts` | 前端渲染测试、构建、本地 E2E 和 [整页截图验收](screenshots/README.md) |
| 可访问性与适配 | `frontend/src/components/ui/Form.tsx`、`frontend/src/components/ui/Input.tsx`、`frontend/src/components/ui/InputPassword.tsx`、`frontend/src/components/ui/Modal.tsx`、`frontend/src/components/ui/Dropdown.tsx`、`frontend/src/components/ui/Select.tsx`：标签关联输入，错误可被识别；弹窗下拉层级和焦点归属修复；按可用宽高调整布局 | 类型检查、键盘行为、减少动画、触摸目标和完整页面宽高检查；缩放与硬件边界见截图记录 |

本轮还修复了成员初始快照缺少完整成员目录、服务器重启恢复列表时私有字段可能进入公共 DTO、房主返回的媒体进度恢复，以及旧连接迟到的断线清理覆盖新主持身份的问题。细节和测试依据见整合复核，不能据此推断任意上游媒体源均已通过真实账号验收。

## 分支、工作目录与运行数据

- 本地 `main` 已快进至整合基线 `fd3dff9`，完整保留相对原 `main` 的 25 个 `codex/package-completion` 提交。
- 所有额外本地分支已通过正常 `git branch -d` 清理，当前仅有 `main`；额外 clean worktree 已正常移除，没有强制覆盖修改。
- 额外工作目录中被忽略的 `config`、日志、E2E 和测试运行文件已在移除前逐文件 SHA256 核对保留，位置：`C:\Users\ss\.codex\worktree-preservation\TongMu-20261002-media-parser-a01-a02`。这些运行数据不进入仓库。
- 本轮不部署 VPS。`.github/workflows/deploy.yml` 仅由 `workflow_dispatch` 手动触发；CI 与 Docker 验证保留。最终交付以推送后同一 SHA 的远程/本地一致和检查结果为准。
- 原远程 `main` 为 `de403bbfe563dabe03cdbe2a196594b9ab44fb3c`。最终提交前核对拓扑、远程和暂存路径；运行数据、密钥、日志、`references/` 与临时脚本不进入提交。`.env`、`config/`、日志、参考项目及 E2E 运行目录的忽略规则已核对。
- CI 在 `main` 推送和 PR 上验证；`main` 推送通过普通验证后继续调用 Linux Docker smoke。手动 Docker workflow 保留。根 Compose 继续使用 BrowserResolver 镜像、Playwright/Chromium、`shm_size: 1gb` 和原 `zviewer-browser-data:/app/config` 持久卷。

## 已验证结果与当前验收状态

| 检查 | 已确认结果 | 限制 |
| --- | --- | --- |
| 后端构建与测试 | `.backend-lifecycle-stable.log`：245 PASS、1 SKIP、0 FAIL；常规 174 PASS，迁移 34 PASS，幂等回执 7 PASS，房间集成 30 PASS | Windows 不允许创建测试符号链接，Local File 遍历及符号链接逃逸用例整体跳过；不算通过。房间测试使用隔离 SQL.js 数据和真实处理器；媒体 HTTP/JWT 测试使用受控上游 |
| 前端测试与生产构建 | `.frontend-final-confirmed.log`：80 PASS、0 FAIL、0 SKIP；`.frontend-build-final-confirmed.log` 和最后卡片调整后的 `.frontend-build-cards-final.log`：类型检查和生产构建通过；`.backend-type-final-delivery.log`：后端类型检查通过 | 最后卡片样式另运行大厅 4 项测试，并重新查看 16 种宽高。既有 mediabunny 动态导入及大包警告仍在；构建通过不代替功能验收 |
| lint | `.lint-delta-bilingual.log`：188 个修改的 src TS/TSX 文件对照，排除 `prettier/prettier` 后新增非格式规则问题为 0 | 该对照记录原始 4797 errors、13 warnings，并非全站 lint 总数；全站 lint 命令仍失败，不能声称通过 |
| 完整本地 E2E | `.e2e-delivery-confirmed.log`：62 项中 59 PASS、3 SKIP、0 FAIL。覆盖 Direct/Gateway、HLS/DASH、BrowserResolver、多人选片及播放、活动切换、30 秒代理/正式转交、导航、退出、合成投屏、fake 语音、中英文和动效 | 本轮默认跳过两项外部 ODC 和一项需显式启用的切片缓存测试。此前开启缓存的 `.e2e-final-stable.log` 为 60 PASS / 2 SKIP；外部样本另行实际播放，不把跳过算通过。最后窄侧栏标签样式另外经人工复查和针对性回归 |
| 外部媒体单独验证 | `.e2e-external-final.log`：ODC Direct 与页面解析 2 PASS，均实际解码 1920×1080 | 仅这两个当时可访问的外部样本；不能推断全部来源或真实账号能力。记录含可恢复媒体/网络诊断，PASS 不表示控制台零告警 |
| 最终针对性回归 | `.e2e-final-focused.log`：显式开启切片缓存后 3 PASS / 0 FAIL，验证授权 Range、原画质与上游读取边界、手机横竖布局，以及入队/立即播放/导航保持会话 | 在最后窄侧栏标签和计数文案修正后执行；两种语言的 1024×768 实际点击、单行宽度及重载恢复另有内置浏览器证据 |
| CI 环境与测试隔离修正 | `.e2e-ci-fixture-fixed.log`：3 PASS / 0 FAIL，覆盖重复 Enter、静态页面解析和 BrowserResolver 动态页面解析 | CI 同时安装 Chrome 与 Playwright Chromium；前者供前端媒体测试，后者供后端 BrowserResolver。防重复测试延后响应而非真实授权请求，仍保留一次提交与成功提示断言；未延长生产凭证或取消过期测试 |
| 认证刷新后的解析 | `.e2e-ci-auth-retry-fixed.log`：3 PASS / 0 FAIL；动态页面用例主动等访问令牌过期后再解析，并实际播放 | 测试看现有 `apiFetch` 一次认证刷新后的最终响应；第二次认证失败或 422 仍立即参与失败断言，不延长期限，不跳过播放检查 |
| Firefox / WebKit | `.e2e-firefox-stable.log`、`.e2e-webkit-stable.log`：各 6 PASS，覆盖语言持久化、菜单键盘/减少动画、私密密码重试、审核与满员、请求投票、登录限制 | 重点流程验证，未运行这两个引擎的完整媒体套件；不等同 macOS/iOS/Android 真机验收 |
| 截图与人工操作 | [截图与操作记录](screenshots/README.md)、[视口几何记录](screenshots/viewport-checks.json)：大厅和播放房间各检查 16 种宽高，另外检查账户、管理、登录、创建、错误和短高度设置窗口 | 真实内置浏览器操作；720×450 用于等效 200% 重排，未称为原生缩放或手机真机验证。控制台包含预期无效链接错误及可恢复 HLS 诊断 |
| GitHub CI / Docker | [整合版本 bf3d241 的实际运行](https://github.com/XYL333FYQ/TongMu/actions/runs/37098598521) 全部通过：Linux 后端 246 PASS / 0 SKIP，前端 80 PASS，E2E 60 PASS / 2 SKIP；Docker 镜像、历史库升级、构建身份、Chromium、BrowserResolver、媒体运行及持久卷重建检查通过 | 最后卡片底部对齐与对应截图在此后补齐，最终交付提交仍需对应同 SHA 的检查；结果绑定最终交付回复与 [main 检查列表](https://github.com/XYL333FYQ/TongMu/actions?query=branch%3Amain)。VPS 部署仅手动触发 |

媒体回归必须分别核对 Media Protocol、Direct/Gateway、HLS/DASH、BrowserResolver 与真实浏览器播放；当前结果按各套测试的覆盖范围解释，不用单项绿灯代替整个媒体链路验收。

## 验证边界

Windows 本机运行的后端、前端和浏览器检查是当前实际环境证据。Firefox/WebKit 测试属于浏览器引擎验证；模拟手机视口属于布局验证，均不等于 iOS、Android 或 macOS 真机通过。投屏自动化用 canvas 流替代系统 capture picker，仅验证信令、活动切换和清理；语音自动化使用 fake 设备，不认证真实麦克风、扬声器、系统授权或硬件兼容性。

连续流程、完整宽高清单、深色和中英文页面、触摸及键盘检查详见截图记录。品牌图像生成出处和共享动效节奏见 [品牌与动效](design/brand-and-motion.md)。没有把未验证的真实系统软键盘、安全区域或硬件选择器列为通过。

最后完整回归曾出现一次房主返回时的预期页面重载打断测试读状态。修正仅在该轮询中原子读取主持身份和 Socket，并只对“Execution context was destroyed”重试；15 秒期限和真实权限/身份断言保留。其他错误仍抛出。独立代理交接用例随后通过，完整冻结回归结果见上表。

首轮 [GitHub CI](https://github.com/XYL333FYQ/TongMu/actions/runs/37096382742) 的浏览器回归为 58 PASS / 2 SKIP / 2 FAIL，不能算通过，Docker 因前置失败未执行。随后补齐后端解析器需要的 Chromium，并将防重复提交测试与两秒夹具凭证过期分开；解析测试也直接断言失败响应的内容，避免只等待成功响应而掩盖原因。对应三项本机回归通过。最终远程结论必须以交付回复中同 SHA 的后续实际运行结果为准。

第二轮 [GitHub CI](https://github.com/XYL333FYQ/TongMu/actions/runs/37097428779) 为 59 PASS / 2 SKIP / 1 FAIL：防重复测试通过，解析测试捕获了现有 `apiFetch` 自动刷新前的首次 401。最后修正观测时机，允许一次现有认证刷新后检查最终响应，并在本机主动等待令牌过期验证这条流程；三项针对性测试通过。产品认证策略没有改动，失败的第二次认证响应仍会使测试失败。

未验证的网络源、系统或硬件能力保持未验证状态；它们不进入“完成”统计。
