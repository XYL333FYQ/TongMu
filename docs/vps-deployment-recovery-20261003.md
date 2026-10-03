# VPS 部署故障与修复（2026-10-03）

## 已确认的原因

- 手动部署任务 [37104612057](https://github.com/XYL333FYQ/TongMu/actions/runs/37104612057) 在 VPS 上运行 `docker compose up -d --build`，停在 `npm ci --include=dev`，达到 60 分钟上限后被取消。新镜像没有完成，未切换到新版本。
- 同期旧应用健康请求已延迟到十几秒至一分钟，SSH 无法完成握手。资源争用/交换造成磁盘压力是可能原因；未找到能证明 OOM 的内核日志，不能将其写成已确认原因。
- 服务器重启后，旧容器不断退出。数据库锁保留了 9 月 21 日的 PID 1，而重启后的 Node 也使用 PID 1，旧版仅检查进程号，误判旧初始化器仍存活。
- 已停止唯一使用该数据卷的容器、校验并备份 `dev.sqlite`、留档旧锁，再启动原镜像。备份和当前数据库完整性检查均通过，用户/房间/影片记录数量相同，公网健康接口恢复 200。恢复版本为 `de403bb`，不是失败部署的新版。

## 当前部署流程

1. 仍仅由 `Deploy TongMu` 手动触发。
2. GitHub 执行现有 Docker 构建、历史库迁移、Chromium/BrowserResolver/媒体 smoke、持久化验证，并新增 SIGKILL 后同容器 PID 1 恢复验证。
3. 全部通过后，把同一个已验证镜像推送到与仓库关联的 GHCR 包，并把不可变 digest、镜像内容指纹和提交 SHA 交给部署任务。
4. VPS 使用短期 GitHub Actions token 拉取私有包。凭据只保存在本次部署的临时目录，镜像拉取后立即注销和删除。Docker 按内容摘要复用已存在的基础层，因此稳定的 Playwright/Chromium、系统和依赖层无需每次重传。
5. 拉取前检查磁盘空间，并清理名称匹配且没有活动传输/部署进程的 TongMu 临时目录。部署时验证镜像内容指纹和提交 SHA；使用根 `docker-compose.yml` 加 `docker-compose.deploy.yml`，以 `--no-build --pull never` 启动。端口、BrowserResolver、shared memory 和原数据卷保持原样。
6. 健康接口同时满足 `status=ok` 和本次提交 SHA 才算部署成功。健康后只删除 `tongmu-release:<SHA>` 中超过当前版和最近一版回滚镜像的标签；不做全局 Docker prune，不删除数据库卷。失败不自动降级数据库或删除旧镜像。

数据库锁新增进程启动时间和 Linux 内核启动身份；锁格式继续兼容旧版。复用的 PID 可以识别为旧进程，近期身份不明确的旧锁、实际活着的锁和其他主机的锁继续阻止并发启动。

## 验证边界

- Windows：后端构建、新增锁测试（3 通过，Linux 项跳过）、历史数据库迁移 34 项、更新器 16 项通过。
- Ubuntu WSL：新增锁测试 4 项通过；部署脚本对隔离 Git 仓库和模拟 Docker/HTTP 的 17 项测试通过，覆盖旧式兼容、不可变 digest 拉取、身份核验、磁盘门槛、活动传输/部署保护、废弃临时目录清理和精确镜像保留；镜像保留工具另有 2 项测试通过。
- Bash 语法和工作流 YAML 解析通过。`actionlint` 由于 `proxy.golang.org` TLS 握手超时未运行。WSL 验证不等同于实际 Docker 或 VPS 部署通过。
- 本机没有 Docker；GitHub Docker smoke 已通过实际容器 SIGKILL 后同容器 PID 1 恢复场景。
- 首次成功部署：[37114851448](https://github.com/XYL333FYQ/TongMu/actions/runs/37114851448)，应用版本 `aae6174`。后续 B 站自动画质修复部署：[37116448535](https://github.com/XYL333FYQ/TongMu/actions/runs/37116448535)，应用版本 `659b06884a9103fa1c21ecc10859ad3e41a34a20`；公网健康接口确认该版本、状态正常、重启次数 0。
- `659b068` 的 [CI 与 Docker 验证](https://github.com/XYL333FYQ/TongMu/actions/runs/37116448010) 全部通过。浏览器验收在确认新版上线后进行，详细边界见 [线上验收记录](production-acceptance-20261003.md)。
- 2026-10-03 新流程实测：CI `37142751621` 和部署 `37143537121` 均成功。VPS 按不可变摘要拉取 `ghcr.io/xyl333fyq/tongmu`，摘要为 `sha256:81e352eddeca9f372ad4a55b4bdb98d04598142304b0b25ccd0fcf0e82969615`，最终健康版本为 `b3a978ba245a84d4e41506f789486e6962e5970b`，公网 `/health` 返回 `status=ok`、`restartCount=0`。首轮 VPS 部署步骤耗时约 19 分 26 秒，Docker 日志记录多个镜像层下载完成；预检按镜像展开大小加 512 MiB 预留 `3,860,417,583` 字节。日志没有统计真实网络下载字节数，因此不能据此声称首轮只传输少量数据；后续同层缓存效果还需用重复部署实测。
- 同次部署后的磁盘检查：40G 文件系统已用 15G、可用 23G（40%）。Docker 报告镜像 11 个、其中 10 个正在被容器引用，总计 9.383GB，估算可回收 4.407GB；容器 7 个、其中 6 个运行，卷 2 个、总计约 440KB，构建缓存为 0。用户此前报告可用空间约 7GB，但本次部署日志未显示删除废弃传输目录或旧发布标签，因此不能确认多出的空间由哪次操作释放，也不能把回收空间归功于本次部署。部署脚本只管理自己创建的 `tongmu-release:<SHA>` 标签，不执行全局 prune，也不删除数据库卷。

## 运维入口

已有预构建镜像的手动启动方式：

```bash
cd /opt/TongMu
export TONGMU_BUILD_SHA="$(git rev-parse HEAD)"
docker compose -f docker-compose.yml -f docker-compose.deploy.yml up -d --no-build --pull never tongmu
```

仅在该提交对应镜像已导入时使用。不要用未通过验证的镜像替代当前服务，也不要在数据库已迁移后直接用旧镜像自动回滚。
