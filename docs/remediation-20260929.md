# TongMu 交付包整改记录（2026-09-29）

## 范围与基线

本轮依据桌面上的《TongMu_两轮整合复审交付包_20260929.zip》，将报告作为核对清单、候选补丁作为参考，以实际源码决定修改。最初 A01/A02 阶段完成后，用户在目标模式中授权继续按推荐路线分轮整改，并要求自主判断和控制成本。

- 根 checkout：`main`，`de403bbfe563dabe03cdbe2a196594b9ab44fb3c`。
- 选用开发基线：`refactor/frontend-unification`，`a280e87d0ae5345c9339d4f1e3318bb955a59d9c`。
- 两分支的共同祖先为上述 main SHA；前端分支在其上增加 `13fbc5c`、`16e8e4a`、`a280e87`，保留阶段 2C、管理界面及房间工作区成果。
- 已有媒体整合包括 Emby/Jellyfin `3ac1df3`、类型化 HLS/DASH `be4e9cd` 和 manifest/cache `75a26e6`。本轮沿用 Provider、MediaDescriptor、客户端 Planner、房间 grant 和播放器生命周期。
- 修改在独立 worktree `C:/Users/ss/.codex/worktrees/media-parser-a01-a02/TongMu` 中进行，累计分支为 `codex/movie-url-storage`。阶段分支是逐轮检查点，最新成果以累计分支为准。
- 未推送、未合并 main、未部署；没有修改 `references/`、生产 config 或 Docker volume 语义。

## 逐项判断与实现

后续用户要求继续核对完整交付包后，F03/F10/R01/R02 的追加实施与真实 ODC 站点验证记录在 [`package-followup-20260929.md`](package-followup-20260929.md)。下表为前轮检查点，相关旧决策以后续记录为准。

| 编号 | 当前处理 | 提交 / 主要文件 |
| --- | --- | --- |
| A01 | 注册中心在 try 内 `await provider.resolve`，异步失败才会进入现有降级判断；取消、超时和访问安全错误停止降级 | `f0ecade`、`e621ed4`；`backend/src/services/media/providers/registry.ts` |
| A02 | `browserSniff` 从 ResolverContext 进入 ProviderContext，再传回旧适配层；false 不启用嗅探 | `f0ecade`；providers `types.ts`、`legacy-resolver-adapter.ts` |
| F01/F02 | 输入版本号阻止旧 A/B 请求覆盖新预览；入口同步 in-flight guard 阻止 Enter 连按产生重复 POST | `bb39f87`；`MoviePushPanel.tsx` |
| F03 | 不采用全来源统一两步预览的界面重设计。保留 B 站解析、画质选择、确认添加，普通网页/直链通过 Media Core 单步添加；通用入口识别 B 站时不会提供独立画质预览，需选 B 站入口 | 设计建议明确保留为后续产品决策，不宣称已经实现 |
| F04/A03 | 默认诊断不显示媒体能力 URL 或原始异常；API 返回白名单 code、安全 message、requestId、retryable；不猜测登录/DRM 原因 | `1994a49`、`e621ed4`；`mediaApi.ts`、`resolution-error.ts`、stream route、网页/浏览器 resolver |
| S01 | Movie 密码迁移到 SecretVault；敏感 Movie/PlaybackState URL 和播放 headers 加密；可重新解析的短效 handle 改为 durable movie reference；普通公开直链仍可 Direct 播放 | `1138264`、`d106ab2`；Movie/PlaybackState、movie service、两项 migrations、upgrade/restore、`movie-url-storage.ts`、客户端 source resolver |
| D01 | main push 的 CI 调用同 SHA Docker smoke，自动 deploy 等待整个 CI 成功；旧 SHA 拦截保留 | `68be449`；`.github/workflows/{ci,docker,deploy}.yml`；仅静态验证，未执行 GitHub/Docker |
| F05 | 手机播放器附近增加房主添加入口，切换现有工作区，不重挂 video | `aef087e`；`RoomLayout.tsx` |
| F06 | slider 可聚焦，支持方向键/Home/End、时间描述；房主控制和观众请求沿用现有权限路径 | `12d37fd`；`PlayerControlBar.tsx`；房主真实键盘通过，观众键盘请求未单独实测 |
| F07 | dialog 语义、初始焦点、Tab 圈定、Esc、关闭后焦点恢复；嵌套删除确认实测 | `e23ea54`、`aa92d02`；`Modal.tsx`、E2E |
| F08 | Input 标签与错误关联；Dropdown listbox/option、展开状态、方向键选择与焦点恢复 | `218ebe2`；`Input.tsx`、`Dropdown.tsx`；现有 Dropdown 消费者在添加面板内，没有 modal 内消费者 |
| F09/F13 | 补来源中文名称、删除确认、手机空态；主 GitHub 链接指向 TongMu，保留上游鸣谢和 CLI 地址 | `1683a60`；`MovieListPanel.tsx`、`Header.tsx` |
| F10 | 采用保留通用 URL 草稿的方案，成功后的重复提交提示已添加；改动链接后才能再次提交。B 站保留既有清空行为 | `bb39f87`；连按 E2E 覆盖单 POST |
| F11 | 无挂载的媒体库来源仍可见，提示连接和房主权限，个人空间在新页打开；保留支持手填的来源 | `33db767`；`MoviePushPanel.tsx` |
| F12 | 当前工作区已非报告旧四卡固定 340px 网格；360/390/430 竖屏、844×390 横屏验证无横向溢出，输入聚焦和添加按钮可滚动到视口，保存并检查截图 | `aa92d02`；`e2e/media-playback.spec.ts`；真机与 Safari 仍待验收 |
| R01/R02 | 文件大与静态不可达属于维护候选；没有按行数重构，也没有把静态候选直接当死代码删除 | 本轮不实施大组件拆分或候选模块删除；逐项消费者审计留在独立维护任务 |

## 回归额外发现：DASH 模板代理认证

完整媒体回归真实失败后，核对基线发现 `dashAssetUrl` 已把 `&` 写成 `&amp;`，随后 XMLSerializer 再次转义。解析后出现 `amp;sourceGeneration`，且 token/grant 又被追加一次，造成代理分片 403 和播放时间不前进。

提交 `9059493` 只调整 stream route 的模板 URL 拼装：返回原始 URL，由 XML 序列化负责一次转义；模板分支不重复追加认证。回归先用 DOMParser 读取真实 XML 属性，修改前 `sourceGeneration` 为 null，修改后 generation、token、grant 各保留一次，DASH 占位符不受损。没有降低授权要求、改变画质或绕过源站限制。

## 执行过的验证

依赖已安装，以下命令在整改 worktree 中执行；已有结果与本轮最终复查分别列出。

| 命令 | 实际结果 |
| --- | --- |
| `npm test -w backend`（S01 URL 阶段） | 159 通过、1 跳过；数据库迁移 suite 34 通过 |
| `npm run build -w backend`（DASH 最终修复后） | 通过 |
| `node --test backend/test/bilibili-media.test.js backend/test/media-protocol.test.js`（DASH 最终修复后） | 49 通过，含 XML 认证和既有安全/manifest 测试 |
| `node --test --test-name-pattern="DASH template authentication" backend/test/media-protocol.test.js` | 修改前失败；修改后 1 通过 |
| `npm test -w frontend` | 39 通过 |
| `npm run build -w frontend`（F09/F13 后，最终新增仅 tests 和后端） | 通过；已有 MediaBunny 动态导入与大包警告仍存在 |
| `npx playwright test e2e/media-playback.spec.ts`（DASH 修复前） | 28 通过、5 失败、1 跳过；两项 DASH 实际 bug，三项 storage/media-server 请求收到 429 |
| `npx playwright test e2e/media-playback.spec.ts --grep "real DASH nested\|DASH reattaches\|storage providers resolve\|playback converges through mediaApi"`（DASH 修复后，新启动环境） | 上述 5 项全部通过；未放宽生产每分钟 20 次解析限流 |
| `npx playwright test e2e/media-playback.spec.ts --grep "movie deletion requires confirmation"` | 1 通过 |
| `npx playwright test e2e/media-playback.spec.ts --grep "movie workspace remains usable\|nested delete confirmation"` | 2 通过 |
| 本机调用 `runBrowserResolverContainerSmoke()` | 真实 Chromium/HTTP fixture 通过：GenericWeb 失败、false 拒绝浏览器、true 回退 Browser、Direct 不变；这不是 Docker 执行结果 |
| `git diff --check` | 通过 |

完整 E2E 单次批量运行尚无全绿结果；上述五项在修复后隔离重跑通过。测试产物在 ignored `test-results/`，可重复生成；末次批量日志为本机临时目录 `TongMu-remediation-e2e.log`。完整日志包含初始 401、故障注入 403、媒体 MIME/网络警告，不能表述为控制台零错误。

## 集成结论与未验证范围

当前采用的架构已经吸收 ZViewer 与 SyncTV 的部分领域能力，而不是直接把两个项目拼接。已有 `docs/integration-v2/upstream-adoption-matrix.md`、`provenance-inventory.md`、两份 upstream notes 和第三方 notices 记录采用/适配/保留/延后边界。本轮保留这些边界，并验证当前播放相关路径；不把历史文档中的 COMPLETE 当作全功能、全平台验收。

- 本机未发现 Docker CLI，容器启动、容器 Chromium、迁移 smoke、故意注入 A01 后阻止部署均未运行；D01 只能交付门禁代码，不能声称运行验收完成。
- 没有推送，GitHub Actions 的同 SHA 行为未在线执行；手动 workflow_dispatch 部署仍属于原有运维入口。
- 真机软键盘、Safari 工具栏、触屏长期播放、人工屏幕阅读器验收未执行；截图不能替代这些验证。
- 迁移测试覆盖活动数据库记录、失败回滚和密钥恢复路径；不清除旧备份或 SQLite 历史空闲页中的旧内容，备份需继续按含敏感数据处理。
- 敏感 URL 判断是已知字段策略，不能证明所有站点自定义查询名都被识别；真实第三方站点、会员登录/限流行为不等同本地 fixture。
- Direct/Proxy 仍保持同 representation/quality，未引入默认转码、DRM 绕过或源站访问限制绕过。
- 本轮不宣称全仓库 lint 通过；未为了格式化或历史告警修改无关模块。

代码与 tests 已按轮独立提交。本轮结束后应保留累计分支供审查；合入与部署需另行明确授权。
