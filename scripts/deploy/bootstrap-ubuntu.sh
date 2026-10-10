#!/usr/bin/env bash
# Ubuntu 24.04 x86_64 only. Prepares a brand-new host; never starts TongMu.
set -Eeuo pipefail

die() { echo "TongMu bootstrap FAILED: $*" >&2; exit 1; }
[[ "$(id -u)" == 0 ]] || die "请使用 sudo bash 执行"
[[ -f /etc/os-release ]] || die "无法识别操作系统"
. /etc/os-release
[[ "$ID" == "ubuntu" && "$VERSION_ID" == "24.04" ]] || die "自动初始化目前只支持 Ubuntu 24.04"
[[ "$(uname -m)" == "x86_64" ]] || die "当前镜像仅验证了 x86_64；不自动初始化其他架构"
user="${1:-}"
[[ -n "$user" && "$user" != root ]] || die "用法：sudo bash bootstrap-ubuntu.sh <部署用户名>"
id "$user" >/dev/null 2>&1 || die "用户 $user 不存在"
group="$(id -gn "$user")"
root="/opt/TongMu"

if [[ -e "$root" || -L "$root" ]]; then
  die "$root 已存在：为了保护原有数据，初始化不会覆盖。请手动检查后继续。"
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git python3 docker.io docker-compose-v2 openssl
systemctl enable --now docker
docker compose version >/dev/null || die "安装后仍无法运行 Docker Compose v2"
usermod -aG docker "$user"
install -d -o "$user" -g "$group" -m 755 "$root"
if ! runuser -u "$user" -- git clone --branch main --single-branch https://github.com/XYL333FYQ/TongMu.git "$root"; then
  rmdir "$root" 2>/dev/null || true
  die "无法从 GitHub 克隆 TongMu"
fi
# Deliberately empty; do not put default JWT secrets or CORS=* on a production host.
install -o "$user" -g "$group" -m 600 /dev/null "$root/.env"
cat <<MESSAGE
✓ 新 VPS 的 Docker、Compose、Git 和 /opt/TongMu 已初始化。
✓ 已创建仅部署用户可读取的空 .env；未安装 Nginx、未开通端口、未启动应用。
下一步：重新登录 SSH 以获得 docker 组权限，填写 /opt/TongMu/.env，
再运行 bash /opt/TongMu/scripts/deploy/preflight-new-vps.sh。
之后才配置 GitHub production Environment，并手动启用未来 VPS 部署。
MESSAGE
