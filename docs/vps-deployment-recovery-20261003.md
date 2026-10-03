# VPS 部署故障与修复（2026-10-03）

## 已确认的原因

- 手动部署任务 [37104612057](https://github.com/XYL333FYQ/TongMu/actions/runs/37104612057) 在 VPS 上运行 `docker compose up -d --build`，停在 `npm ci --include=dev`，达到 60 分钟上限后被取消。新镜像没有完成，未切换到新版本。
- 同期旧应用健康请求已延迟到十几秒至一分钟，SSH 无法完成握手。资源争用/交换造成磁盘压力是可能原因；未找到能证明 OOM 的内核日志，不能将其写成已确认原因。
- 服务器重启后，旧容器不断退出。数据库锁保留了 9 月 21 日的 PID 1，而重启后的 Node 也使用 PID 1，旧版仅检查进程号，误判旧初始化器仍存活。
- 已停止唯一使用该数据卷的容器、校验并备份 `dev.sqlite`、留档旧锁，再启动原镜像。备份和当前数据库完整性检查均通过，用户/房间/影片记录数量相同，公网健康接口恢复 200。恢复版本为 `de403bb`，不是失败部署的新版。

## 修复后的部署流程

1. 仍仅由 `Deploy TongMu` 手动触发。
2. GitHub 执行现有 Docker 构建、历史库迁移、Chromium/BrowserResolver/媒体 smoke、持久化验证，并新增 SIGKILL 后同容器 PID 1 恢复验证。
3. 全部通过后才导出同一镜像，并通过 Actions artifact 传给部署任务（保留一天，不增加镜像仓库账号或 VPS 凭证）。
4. 上传前拒绝脏工作目录、过期提交和磁盘空间不足。导入前验证压缩包 SHA-256，导入后验证可跨 Docker 镜像存储实现的内容指纹（文件系统层与启动配置）和构建提交。镜像 ID 在 containerd 与传统存储之间可能不同，不能单独作为内容不一致的证据。
5. 使用根 `docker-compose.yml` 加 `docker-compose.deploy.yml`，以 `--no-build --pull never` 启动。VPS 不再安装 npm 依赖或编译；端口、BrowserResolver、shared memory 和原数据卷保持原样。
6. 健康接口同时满足 `status=ok` 和本次提交 SHA 才算部署成功。失败不自动降级数据库或删除旧镜像，临时上传文件正常退出时清理。

数据库锁新增进程启动时间和 Linux 内核启动身份；锁格式继续兼容旧版。复用的 PID 可以识别为旧进程，近期身份不明确的旧锁、实际活着的锁和其他主机的锁继续阻止并发启动。

## 验证边界

- Windows：后端构建、新增锁测试（3 通过，Linux 项跳过）、历史数据库迁移 34 项、更新器 16 项通过。
- Ubuntu WSL：新增锁测试 4 项通过；真实 Bash 部署脚本对隔离 Git 仓库和模拟 Docker/HTTP 的 8 项测试通过，覆盖成功导入、损坏包、身份不符、脏目录、过期提交、磁盘不足、旧版本假健康、存储 ID 差异和启动配置变化。
- Bash 语法和 ShellCheck 已检查。WSL 验证不等同于实际 Docker 或 VPS 部署通过。
- 本机没有 Docker；GitHub Docker smoke 已通过实际容器 SIGKILL 后同容器 PID 1 恢复场景。
- 首次成功部署：[37114851448](https://github.com/XYL333FYQ/TongMu/actions/runs/37114851448)，应用版本 `aae6174`。后续 B 站自动画质修复部署：[37116448535](https://github.com/XYL333FYQ/TongMu/actions/runs/37116448535)，应用版本 `659b06884a9103fa1c21ecc10859ad3e41a34a20`；公网健康接口确认该版本、状态正常、重启次数 0。
- `659b068` 的 [CI 与 Docker 验证](https://github.com/XYL333FYQ/TongMu/actions/runs/37116448010) 全部通过。浏览器验收在确认新版上线后进行，详细边界见 [线上验收记录](production-acceptance-20261003.md)。

## 运维入口

已有预构建镜像的手动启动方式：

```bash
cd /opt/TongMu
export TONGMU_BUILD_SHA="$(git rev-parse HEAD)"
docker compose -f docker-compose.yml -f docker-compose.deploy.yml up -d --no-build --pull never tongmu
```

仅在该提交对应镜像已导入时使用。不要用未通过验证的镜像替代当前服务，也不要在数据库已迁移后直接用旧镜像自动回滚。
