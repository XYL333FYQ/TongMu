#!/usr/bin/env bash
# 新 Ubuntu VPS 专用：仅初始化依赖、/opt/TongMu 和 .env 模板，不启动 TongMu。
# 用法：sudo bash scripts/deploy/bootstrap-ubuntu.sh <现有SSH用户>
set -Eeuo pipefail

fail() { printf '初始化失败：%s\n' "$1" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || fail '请使用 sudo 执行。'
user="${1:-}"
[[ "$user" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail '请提供现有 Ubuntu SSH 用户名。'
getent passwd "$user" > /dev/null || fail '指定的 SSH 用户不存在。'
[[ -f /etc/os-release ]] || fail '不是受支持的 Ubuntu 系统。'
. /etc/os-release
[[ "$ID" == ubuntu ]] || fail '仅支持 Ubuntu。'
[[ "$VERSION_ID" == "22.04" || "$VERSION_ID" == "24.04" ]] ||
  fail '已验证的初始化目标为 Ubuntu 22.04 / 24.04。'

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git gnupg python3 nginx certbot python3-certbot-nginx

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  arch="$(dpkg --print-architecture)"
  codename="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' "$arch" "$codename" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
systemctl enable --now nginx
usermod -aG docker "$user"

root=/opt/TongMu
if [[ -d "$root/.git" ]]; then
  origin="$(git -C "$root" remote get-url origin)"
  case "$origin" in
    https://github.com/XYL333FYQ/TongMu|https://github.com/XYL333FYQ/TongMu.git) ;;
    *) fail '目标目录已有其他 Git 仓库，拒绝覆盖。' ;;
  esac
else
  if [[ -e "$root" ]] && [[ -n "$(ls -A "$root")" ]]; then
    fail '/opt/TongMu 非空且不是 Git 仓库，拒绝覆盖。'
  fi
  install -d -m 0755 -o "$user" -g "$(id -gn "$user")" "$root"
  runuser -u "$user" -- git clone --branch main https://github.com/XYL333FYQ/TongMu.git "$root"
fi

if [[ ! -e "$root/.env" ]]; then
  runuser -u "$user" -- cp "$root/.env.example" "$root/.env"
  echo '已创建 .env 模板。务必填写 JWT_ACCESS_SECRET、JWT_REFRESH_SECRET 和 CORS_ORIGIN。'
fi
chown "$user:$(id -gn "$user")" "$root/.env"
chmod 600 "$root/.env"
printf '新 VPS 基础初始化完成（TongMu 未启动）。\n'
printf '下一步：重新登录 SSH 使 Docker 用户组生效，再编辑 /opt/TongMu/.env。\n'
printf '新服务器的 SSH 主机公钥（复制到 GitHub Environment Variable PRODUCTION_VPS_HOST_KEY）：\n'
awk 'NR==1 { print $1 " " $2 }' /etc/ssh/ssh_host_ed25519_key.pub
