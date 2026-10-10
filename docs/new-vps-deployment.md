# TongMu 全新 VPS 部署准备（旧香港数据不保留）

> 本文只准备**未来**的部署。当前不部署、不购买云主机、不创建新证书、不重用旧香港数据库或密钥。
>
> 正式域名可以重新启用 `tongmu.eren.cc.cd`；以前的 DNS 记录已删除，等有新服务器时再新增 A 记录。
> 原香港 VPS `8.217.140.53` 已弃用，自动部署明确禁止再指向该地址。

## 1. 仓库已准备好的部分

- `.github/workflows/ci.yml`：测试、前端构建、Docker Chromium 烟测（沿用原方案）。
- `.github/workflows/deploy.yml`：**手动**发布；GitHub 先构建并发布带 SHA 和内容指纹的 GHCR 镜像，新 VPS 再按不可变 digest 拉取，健康检查确认后才视为成功。
- `.github/workflows/production-diagnostics.yml`：手动、只读诊断；与部署一样读取新的 production 环境。
- `scripts/deploy/bootstrap-ubuntu.sh`：新 Ubuntu 主机初始准备，不启动 TongMu。
- `scripts/deploy/preflight-new-vps.sh`：部署前只读检查，不打印密钥。
- `deploy/nginx/tongmu-http.conf.example`：Nginx HTTP 入口模板，之后由 Certbot 签发新 HTTPS 证书。

**新服务器还没有确定之前，不要配置 `TONGMU_DEPLOY_ENABLED=true`。**
配置不全会停止在 GitHub 部署任务的安全闸门，**不会尝试连接旧香港服务器**。
CI 和 Docker smoke 不需要服务器凭据，可以继续独立运行。

## 2. 新购 VPS 的基本要求

- 推荐 Ubuntu **24.04 x86-64**、2 vCPU、4 GiB RAM、至少 40 GiB 磁盘。
- 这是 Chromium BrowserResolver 的建议余量，不是项目的最低启动门槛。
- 新服务器需能访问 GitHub 和 GHCR。Docker 镜像较大，所以磁盘至少留 6 GiB 空闲才允许开始拉取（拉取步骤本身还有独立的大小预检）。
- 云平台安全组只开放 SSH、80、443；如果要从外部使用 OBS 推流，再按需要额外限制性开放 TCP 3334。不要把 3333 和容器内 3335 暴露公网。
- 更换 VPS 只替换部署目标、TLS 证书和运行环境，不需修改应用代码或 GitHub 构建逻辑。

## 3. 首次初始化（**以后拿到新 VPS 再执行**）

以普通 sudo 用户登录一台全新 Ubuntu 24.04 x86-64 VPS：

```bash
sudo apt-get update
sudo apt-get install -y git
git clone --depth 1 https://github.com/XYL333FYQ/TongMu.git ~/TongMu-bootstrap
sudo bash ~/TongMu-bootstrap/scripts/deploy/bootstrap-ubuntu.sh "$USER"
```

脚本安装 Docker Engine、Compose v2 和基本工具，创建 /opt/TongMu Git checkout，并创建权限 600 的**空** `.env` 文件。
**它不安装 Nginx，不启动容器，不改任何 DNS，不会访问香港旧 VPS。**
Docker 组更改后需**退出 SSH 重新登录**；加入 docker 组意味着拥有宿主机高权限，只授予可信的部署用户。

编辑 `/opt/TongMu/.env`，生产必需字段可参考（密钥自行在新 VPS 上生成）：

```dotenv
NODE_ENV=production
CORS_ORIGIN=https://tongmu.eren.cc.cd
JWT_ACCESS_SECRET=使用独立的至少32位随机字符串替换
JWT_REFRESH_SECRET=使用另一条独立的至少32位随机字符串替换
MEDIA_BROWSER_RESOLVER=true
MEDIA_BROWSER_MAX_CONCURRENCY=1
```

建议用 `openssl rand -hex 32` 分别生成两条不同的 JWT 密钥。
不要使用 `.env.example` 的默认密钥、`CORS_ORIGIN=*`，不要把 `.env` 上传 GitHub。
如果日后更换正式域名，同步改 `CORS_ORIGIN`。

执行只读预检：

```bash
cd /opt/TongMu
bash scripts/deploy/preflight-new-vps.sh
```

成功后才进行 GitHub 配置和首次部署。预检还会检查 git checkout、Docker/Compose 权限、`.env`、磁盘余量等。

## 4. GitHub Environment：production

在仓库 **Settings → Environments → New environment** 创建 `production`。
只有这套环境持有未来服务器凭据，不再使用旧的仓库级 `VPS_HOST / VPS_USER / VPS_PORT / VPS_SSH_KEY`。

| 位置 | Key | 内容 |
|---|---|---|
| Environment Variables | `TONGMU_PRODUCTION_HOST` | **新 VPS** 公网 IP 或 DNS 主机名 |
| Environment Variables | `TONGMU_PRODUCTION_SSH_USER` | 新 VPS 的普通部署用户 |
| Environment Variables | `TONGMU_PRODUCTION_SSH_PORT` | 新 VPS 的 SSH 端口（例如 22） |
| Environment Variables | `TONGMU_PRODUCTION_SSH_HOST_KEY_SHA256` | 新 VPS SSH ED25519 公钥指纹 |
| Environment Secrets | `TONGMU_PRODUCTION_SSH_KEY` | 与新 VPS 用户授权公钥对应的 SSH 私钥 |
| Environment Variables | `TONGMU_DEPLOY_ENABLED` | **最后一步才填 `true`**，未设置时部署任务拒绝执行 |

在新 VPS 上读取**公钥指纹**（不要复制私钥）：

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

复制输出中的 `SHA256:...` 一段到 `TONGMU_PRODUCTION_SSH_HOST_KEY_SHA256`。
GitHub Action 会扫描服务端 ED25519 公钥并与固定指纹比较，不接受未核对的服务器身份。

**注意：Environment 名称本身不提供凭据，必须填写上述条目。**
如果目前仓库级旧 `VPS_*` Secrets 仍存在，可以在核实其它工作流不再使用后删除；新工作流采用**不同的命名**，避免误用旧主机。

## 5. 第一次部署（未来再操作）

1. 确认 DNS 和部署用户就绪，预检全部通过。
2. 在 production Environment 设置 `TONGMU_DEPLOY_ENABLED=true`。
3. 进入 **Actions → Deploy TongMu → Run workflow** 手动运行；代码 push **不会**自动部署。
4. GHCR 构建/验证在 GitHub 运行；SSH 远程脚本只会在目标检查、主机指纹和预检全部成功后启动容器。
5. 检查 `http://127.0.0.1:3333/health`（需在新 VPS 上运行），确认报告的 `commitSha` 与部署提交一致。

**部署可用并不等于域名已经完成切换。** HTTPS、Nginx、浏览器与媒体解析仍需单独验收。

## 6. HTTPS、域名和反向代理（未来再操作）

到时先在 Cloudflare DNS 为 `tongmu.eren.cc.cd` 添加指向**新 VPS IP** 的 A 记录。
证书申请时使用 **仅 DNS（灰云）**，在新 VPS 开放 TCP 80、443。

```bash
sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx
sed 's/__TONGMU_DOMAIN__/tongmu.eren.cc.cd/g' \
  /opt/TongMu/deploy/nginx/tongmu-http.conf.example | \
  sudo tee /etc/nginx/sites-available/tongmu >/dev/null
sudo ln -sfn /etc/nginx/sites-available/tongmu /etc/nginx/sites-enabled/tongmu
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d tongmu.eren.cc.cd
sudo certbot renew --dry-run
```

该模板反代到 `127.0.0.1:3333`，带 Socket.IO/WebSocket Upgrade、长连接和大文件支持。
**初始模板故意不包含不存在的 HTTPS 证书路径**，Certbot 会在新服务器上签发并写入对应 Nginx 配置。
不要复制旧香港 VPS 的证书。完成后测试：

```bash
curl -fsS https://tongmu.eren.cc.cd/health
```

若未来想用别的域名，修改模板替换值、Cloudflare 记录、Certbot `-d` 参数和 `CORS_ORIGIN`，不需要重写源代码。

## 7. 全新数据的边界

- 本次明确放弃旧香港数据。**不要恢复任何旧 `dev.sqlite` 或 `zviewer-browser-data` 卷。**
- 新 `docker compose` 首次启动时会创建新的 `zviewer-browser-data`，挂载在 `/app/config`。
- 以后更新版本时**保留**该卷；`docker compose down -v` 会删除它，不能用作日常重启操作。
- 首次部署后需要重新创建账号、管理员配置以及外部媒体源凭据。
- `JWT_ACCESS_SECRET` 和 `JWT_REFRESH_SECRET` 对全新实例分别生成；旧用户数据已经放弃，无需恢复旧 JWT。
- `CORS_ORIGIN` 必须匹配未来的实际公网 HTTPS 域名。

## 8. 公网验收与故障处理

部署成功后建议至少验收：登录/注册、私人房间双窗口加入和状态同步、视频直连与 BrowserResolver 解析、代理网关播放、手机浏览器适配。
若用 WebRTC 语音，必须额外验证真实跨 NAT 场景；Nginx HTTPS 成功不能证明 TURN 媒体中继已经可用。
若希望公网完全自动化验收，可在获得新服务器后扩展单独的无副作用 smoke workflow。

**重要：新版本升级可能对数据库做不可逆迁移；本仓库的镜像回滚不等于数据库回滚。** 全新实例首次启动前不需备份旧香港数据，但以后承载真实用户数据时应对整个 `/app/config` 卷做周期性备份。

