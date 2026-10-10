#!/usr/bin/env bash
# 在新 VPS 上只读检查部署前置条件；用 ssh < 本脚本执行，不包含秘密值的输出。
set -Eeuo pipefail

fail() { printf 'TongMu 新 VPS 尚未就绪：%s\n' "$1" >&2; exit 1; }
root="${TONGMU_DEPLOY_ROOT:-/opt/TongMu}"
[[ "$root" == /opt/TongMu ]] || fail '当前自动部署只支持 /opt/TongMu。'
[[ -d "$root/.git" ]] || fail '缺少 /opt/TongMu Git 仓库；先运行 bootstrap-ubuntu.sh。'
origin="$(git -C "$root" remote get-url origin 2>/dev/null)" || fail '无法读取 Git remote。'
case "$origin" in
  https://github.com/XYL333FYQ/TongMu|https://github.com/XYL333FYQ/TongMu.git) ;;
  *) fail 'Git 仓库不是官方指定的 TongMu 仓库。' ;;
esac
[[ -f "$root/.env" && -r "$root/.env" ]] || fail '缺少可读取的 /opt/TongMu/.env。'
[[ "$(stat -c '%a' "$root/.env")" == "600" ]] ||
  fail '.env 权限不是 600，请执行 chmod 600 /opt/TongMu/.env。'

# 不 source .env（避免执行用户填写的 Shell 内容），只检查必须的生产配置。
grep -Eq '^JWT_ACCESS_SECRET=[^[:space:]]{32,}$' "$root/.env" ||
  fail 'JWT_ACCESS_SECRET 未设置强随机值（至少 32 位、不含空格）。'
grep -Eq '^JWT_REFRESH_SECRET=[^[:space:]]{32,}$' "$root/.env" ||
  fail 'JWT_REFRESH_SECRET 未设置强随机值（至少 32 位、不含空格）。'
grep -Eq '^CORS_ORIGIN=https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(,https://[A-Za-z0-9.-]+(:[0-9]{1,5})?)*$' "$root/.env" ||
  fail 'CORS_ORIGIN 必须是明确的正式 HTTPS 来源，不能是 *。'
command -v docker >/dev/null || fail 'Docker 未安装。'
docker info > /dev/null 2>&1 || fail '当前 SSH 用户没有 Docker 权限或 Docker 未启动。'
docker compose version > /dev/null || fail '未安装 Docker Compose v2。'
command -v git >/dev/null || fail 'Git 未安装。'
command -v python3 >/dev/null || fail 'Python3 未安装（部署镜像校验需要）。'
cd "$root"
docker compose config --quiet ||
  fail 'Compose 或 .env 配置无效。'
printf '✓ TongMu 新 VPS 已初始化；Git 仓库、Docker/Compose、生产 .env 和强随机凭据均通过部署前检查。\n'
