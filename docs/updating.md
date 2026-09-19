# 更新 TongMu

## 自动更新支持范围

自动检查默认关闭。管理员需要同时配置可信 TongMu 仓库
`TONGMU_UPDATE_REPOSITORY` 和 `TONGMU_UPDATE_TRUSTED_KEYS` 公钥集合。只有
root 可以检查、暂存更新；使用登录 Cookie 的更新操作还必须来自同一站点。

自动更新只接受带 canonical manifest、SHA-256 和 Ed25519 签名的 TongMu
GitHub Release 资产。旧 `zviewer-*` 文件名仅是下载兼容副本，不能替代签名
metadata。相同版本但不同 SHA 会被当作可疑替换而拒绝，低版本不会自动安装。

## 单文件版更新

1. 在 root 管理页面检查并暂存更新。
2. 等待系统报告签名、大小、SHA-256 和归档检查全部完成。
3. 使用随包的 `start.bat restart` 或 `./start.sh restart` 重启，不要手工把
   新包逐文件覆盖到运行中的目录。
4. 启动器会在停服后切换程序文件，并用 `/health` 核对新版本和构建 SHA。

`config/`、自定义 `CONFIG_DIR`、数据库、上传、密钥和证书不在程序包中，
也不参与程序回滚。启动后可访问 `/health` 查看当前 `version`、`commitSha`
和 `buildId`。

单文件包不内置 Chromium。使用 BrowserResolver 时需安装兼容的
Chromium/Chrome，并把 `PLAYWRIGHT_EXECUTABLE_PATH` 指向其可执行文件；根
Compose 镜像仍是包含 Playwright/Chromium 的推荐部署方式。

## 失败与恢复

下载、签名、哈希或解压失败不会影响当前安装。切换中断会由事务标记继续；
新版本健康检查失败时启动器恢复旧程序。如果新版本启动期间已经迁移数据库，
旧程序可能无法读取新 schema，此时还必须按照 `docs/upgrade-v2.md` 使用该次
升级前的 Phase 6A 备份恢复数据库。不要把“程序已回滚”理解为“数据库也已
回滚”。

不支持无条件 downgrade。需要手动更新时，也应在独立目录解压 canonical
包、核对 manifest 签名/大小/SHA-256，保留现有 `config/`，再切换程序目录；
不要上传无 sidecar 的旧 zip，服务端会拒绝它。

## Docker

当前 Compose 从源码构建，容器内自更新不是正式发布边界。Docker 部署仍应
拉取明确 commit/tag 后重新构建，并保留 `/app/config` volume。Docker/browser
image 的真实 release smoke 属于 Phase 6B-2。
