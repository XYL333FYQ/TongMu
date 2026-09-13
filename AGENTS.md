# TongMu Agent Instructions

## 工作范围

- TongMu 根目录是唯一工作项目；后续命令、路径和 Git 操作默认从这里执行。
- `references/` 只读，仅供比较和查阅；不得修改、提交或把其中的源码纳入 TongMu。
- 修改前先阅读相关文件和现有实现，保持当前任务范围，不做无关重构。
- 不使用 `git reset --hard`、`git clean -fd`、`git checkout .`，不强制覆盖已有修改，不自动 commit、push 或重新初始化 Git。

## 媒体与兼容性长期原则

1. Original Quality First。
2. Direct First。
3. Proxy as Fallback。
4. Transport fallback 不得改变 quality。
5. 不默认视频转码。
6. 私有 credentials 不得进入 public DTO。
7. Room 共享 `MediaDescriptor`。
8. `PlaybackPlan` 属于客户端。
9. BrowserResolver 是长期保留能力。
10. 修改媒体层时必须参考现有 tests。
11. 不允许为了品牌改名破坏旧数据库/API 兼容。
12. `references/synctv` 和 `references/zviewer-original` 默认只读。

## 目录与运行数据

- `config/` 保存 SQLite、密钥、证书、上传文件和媒体运行数据；除非明确处理数据迁移，不改变 `/app/config` 和现有 Docker volume 语义。
- `.env`、数据库、JWT secrets、日志、测试产物和 `references/` 不得进入 GitHub。
- 默认部署入口是根目录 `docker-compose.yml`，它必须保留 BrowserResolver、Playwright、Chromium 和合理的 `shm_size`。

## 验证

- 代码变更后运行最直接、最相关的 lint/build/test；没有执行的验证必须明确说明。
- 不能因为构建通过就默认功能正确；修改媒体行为时还要覆盖现有 Media Protocol、Direct/Gateway、HLS/DASH、BrowserResolver 和 E2E 验证。
- 遇到未提交修改时保留它们，最终报告清楚区分本次变更与既有工作。
