# TongMu 新服务器部署手册（全新开始，不迁移香港 VPS 数据）

本流程用于**未来购买的新 VPS**。准备仓库配置本身不会部署，也不会重新连接即将到期的阿里云香港 VPS。
推荐 Ubuntu 24.04 x86-64、至少 2 vCPU / 4 GB RAM / 40 GB 磁盘。TongMu 内含 Playwright/Chromium，低配服务器可能在浏览器解析时产生内存压力。

## 0. 为什么 GitHub 的旧 Secrets 不会误连香港

- `.github/workflows/deploy.yml` **仅支持手动 Run workflow**，无代码推送自动部署。
- 在构建耗时很长的 Chromium 镜像**之前**执行 VPS 预检。
- 生产部署与诊断均绑定 GitHub Environment `production`，只读取全新的 `PRODUCTION_*` 配置名称，而不是旧仓库级 `VPS_HOST/VPS_USER/VPS_PORT/VPS_SSH_KEY`。
- `DEPLOY_TARGET_GUARD=fresh-vps-ready` 必填，并显式拒绝旧香港公网 IP `8.217.140.53`。
- SSH 使用从目标机器控制台拿到的 Ed25519 **主机公钥**，不盲信未经校验的 `ssh-keyscan`。
- 新 VPS 不要求旧数据库、旧 Nginx 证书或旧域名解析；数据使用新建 Docker Volume。

## 1. 领取新的 Ubuntu VPS 后，进行一次初始化

以下命令在**新 VPS 的 SSH 终端**执行。不要在旧香港 VPS 上运行！

```bash
git clone https://github.com/XYL333FYQ/TongMu.git /tmp/tongmu-setup
sudo bash /tmp/tongmu-setup/scripts/deploy/bootstrap-ubuntu.sh "$USER"
```

脚本只安装 Git、Python3、Docker + Compose v2、Nginx + Certbot，准备 `/opt/TongMu` 和**未填写的** `.env`；不会启动 TongMu、不会删除任何现有数据。
执行完成后**断开 SSH 再重新登录**，使 Docker 用户组生效，检查：

```bash
docker compose version
docker info >/dev/null && echo 'Docker 权限正常'
```

全新系统上 `/opt/TongMu/.env` 由初始化脚本从 `.env.example` 创建，只有 SSH 用户可读。编辑它：

```bash
nano /opt/TongMu/.env
```

需要特别设置：

| .env 名称 | 要填写什么 |
| --- | --- |
| `JWT_ACCESS_SECRET` | 使用 `openssl rand -hex 32` 生成的**第一条**随机串 |
| `JWT_REFRESH_SECRET` | 再执行一次 `openssl rand -hex 32` 生成**另一条**随机串 |
| `CORS_ORIGIN` | 如 `https://tongmu.eren.cc.cd`，**不能用 `*`** |
| `VITE_API_URL` | 保持空；页面和 API 由同一域名转发 |
| `VITE_FLV_BASE_URL` | 无特殊独立 FLV 地址时保持空 |
| `MEDIA_BROWSER_RESOLVER` | 推荐 `true`（容器包含 Chromium） |

**不要把真实 `.env` 提交到 GitHub，也不要把 JWT 密钥发送到聊天里。**
新系统不用恢复香港 VPS 的 `zviewer-browser-data` 卷；首次启动会自动创建新的持久卷。

在新 VPS 上得到供 GitHub 固定身份的**SSH 主机公钥**（这是公开信息，非 SSH 私钥）：

```bash
sudo awk 'NR==1 {print $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub
```

记录新 VPS IP、SSH 用户（如 `ubuntu` 或 `azureuser`）、SSH 端口和这行主机公钥。

## 2. 将连接信息填到 GitHub Environment，不使用旧香港机密

进入仓库 `Settings → Environments`，建立名称精确为 **`production`** 的环境。

在该环境添加 **Variables**：

| 名称 | 值 |
| --- | --- |
| `DEPLOY_TARGET_GUARD` | `fresh-vps-ready` |
| `PRODUCTION_VPS_HOST` | 新 VPS 的公网 IP / DNS 主机名，**不是旧香港 IP** |
| `PRODUCTION_VPS_USER` | 新 VPS SSH 用户名 |
| `PRODUCTION_VPS_PORT` | SSH 端口，例如 `22` |
| `PRODUCTION_VPS_HOST_KEY` | 第 1 步命令返回的 `ssh-ed25519 AAAA...` 整行，不包含末尾注释 |

在该环境添加 **Secret**：

| 名称 | 值 |
| --- | --- |
| `PRODUCTION_VPS_SSH_KEY` | 对应新 VPS SSH 用户的**私钥**内容；不能填写 `.pub` 文件 |

旧仓库级 `VPS_*` Secrets 不会被新版部署工作流读取；确认其他用途后可手动删掉。**当前无需填写任何新环境配置，直到真的买到新 VPS。**

首次配置私钥后，需确保对应的公钥已在新 VPS 的 `~/.ssh/authorized_keys` 中。新的 `PRODUCTION_VPS_SSH_KEY` 必须是可自动使用的无密码私钥；GitHub Actions 不交互输入解锁口令。

## 3. 先在新 VPS 建立 HTTP 反向代理，再配置正式 HTTPS

部署前准备 Nginx（也可以在部署后做，但正式公网访问前必须配置）。
下面以原来的 `tongmu.eren.cc.cd` 为例；你已经删除了旧 DNS 记录，后续如果仍想使用此域名，需要重新添加 **A → 新 VPS IP**，保持「仅 DNS」。也可以换新域名。

```bash
sudo sed 's/__TONGMU_DOMAIN__/tongmu.eren.cc.cd/g' \
  /opt/TongMu/deploy/nginx/tongmu.conf.example | sudo tee /etc/nginx/sites-available/tongmu >/dev/null
sudo ln -sfn /etc/nginx/sites-available/tongmu /etc/nginx/sites-enabled/tongmu
sudo nginx -t && sudo systemctl reload nginx
```

模板包含 Socket.IO/WebSocket、媒体流转发、上传大小及超时配置；上游为 `127.0.0.1:3333`，不需要公网开放 3333。
在**新 VPS 的安全组/防火墙**放行 TCP 80/443 以及 SSH 端口（如 22）；关闭不必要的公网端口。

当 DNS 已指向新 IP、且 80/443 公网可达时申请**新证书**（旧香港证书不用迁移）：

```bash
sudo certbot --nginx -d tongmu.eren.cc.cd --redirect
sudo nginx -t
```

Certbot 通常安装自动续期计划；部署后可以执行 `sudo certbot renew --dry-run` 验证续期链路。
这一步需要真正的新 VPS 和已生效的 DNS，**准备 GitHub 期间不要执行**。

## 4. 手动部署，不自动触发

确认新 VPS 的 `.env` 已填写、Docker 可用、GitHub `production` 的 Variables / Secret 完整后：

打开 GitHub → Actions → **Deploy TongMu** → **Run workflow**。

它会先检查目标及机器环境（缺配置信息就终止），再在 GitHub runner 构建/测试 Chromium 镜像、推送 GHCR，最后拉取已验证镜像到新 VPS，并校验 `/health` 版本。
**不要使用服务器上 `docker compose up -d --build` 进行耗时生产构建。** 当前部署脚本是增量拉取 GHCR 镜像，不重复传输相同的基础层。

验收：

```bash
curl -fsS http://127.0.0.1:3333/health
docker compose -f /opt/TongMu/docker-compose.yml --project-directory /opt/TongMu ps
```

公网 HTTPS 配好后再使用 `https://tongmu.eren.cc.cd/health` 验证，检查页面、登录、创建房间、Socket.IO 和媒体解析是否正常。
如需排查，通过 Actions 手动运行 **TongMu production diagnostics**，它也只使用同一个新环境。

## 5. 端口、媒体与长期维护

- **3333**：只监听本机，交给 Nginx 反向代理。
- **3334/TCP**：OBS RTMP 推流接口；默认仅绑定 `127.0.0.1`。确实需要远程 OBS 时，才在 `.env` 设置 `TONGMU_RTMP_BIND_IP=0.0.0.0` 并通过安全组仅向可信来源开放；**不使用时无需开放**。
- **3335**：容器内 HTTP-FLV，由 `/live` 转发；不需要公开开放。
- WebRTC 在复杂网络中可能需要额外 TURN；成功启动、健康检查和 PeerJS/Socket.IO 服务**不等于**真实音视频跨网络可用。
- 后续部署会沿用同一个 `zviewer-browser-data` 持久卷，不会清除新 VPS 运行数据。**没有备份的话，请勿运行 `docker compose down -v`**。
- 镜像更新失败不代表数据库可自动回滚；脚本保留的前一版镜像是软件版本回退，并非数据库降级。

## 6. 旧香港服务器在这里没有任何角色

这套准备方案不读取、不备份、不迁移香港 VPS 上的用户/房间/密钥，未来也不会自动连回 `8.217.140.53`。
仓库修改或 PR 合并只会触发原有代码 CI，不会触发 `Deploy TongMu`（该 workflow 只有 `workflow_dispatch`）。
