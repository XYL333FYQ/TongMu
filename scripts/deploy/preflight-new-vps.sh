#!/usr/bin/env bash
# Read-only preflight for a fresh Ubuntu VPS; never installs, restarts or edits services.
set -Eeuo pipefail
root="${TONGMU_DEPLOY_ROOT:-/opt/TongMu}"

die() { printf 'TongMu preflight FAILED: %s\n' "$*" >&2; exit 1; }

[[ "$root" = /* && "$root" != "/" && -d "$root/.git" ]] || die "项目目录不存在：$root（请先运行 bootstrap）"
cd "$root"
command -v git >/dev/null || die "缺少 git"
command -v docker >/dev/null || die "缺少 Docker"
command -v python3 >/dev/null || die "缺少 Python 3"
docker compose version >/dev/null || die "缺少 Docker Compose v2"
docker info >/dev/null 2>&1 || die "当前 SSH 用户无法使用 Docker（检查 docker 组并重新登录）"
[[ -z "$(git status --porcelain)" ]] || die "部署目录有未提交的文件改动"
origin="$(git remote get-url origin)"
case "$origin" in
  https://github.com/XYL333FYQ/TongMu|https://github.com/XYL333FYQ/TongMu.git|git@github.com:XYL333FYQ/TongMu.git) ;;
  *) die "远端 Git 仓库不是预期的 TongMu 项目" ;;
esac
[[ -f .env && -r .env ]] || die "缺少可读取的 .env（bootstrap 会创建空文件，请先填写生产配置）"

python3 - <<'PY'
import os
import re
import sys
from urllib.parse import urlsplit

with open(".env", encoding="utf-8") as stream:
    entries = {}
    for line in stream:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        entries[name.strip()] = value.strip().strip("'\"")

def fail(message):
    print("TongMu preflight FAILED: " + message, file=sys.stderr)
    sys.exit(1)

for key in ("JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"):
    value = entries.get(key, "")
    if len(value) < 32 or value.startswith("your-") or re.search(r"\s", value):
        fail(key + " 未设置为至少 32 位的强随机字符串")
if entries["JWT_ACCESS_SECRET"] == entries["JWT_REFRESH_SECRET"]:
    fail("JWT_ACCESS_SECRET 和 JWT_REFRESH_SECRET 必须是不同值")
origin = entries.get("CORS_ORIGIN", "")
parts = urlsplit(origin)
if not origin or "*" in origin or "," in origin or parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.path not in ("", "/") or parts.query or parts.fragment:
    fail("CORS_ORIGIN 必须是正式 HTTPS 域名（如 https://tongmu.eren.cc.cd），不可使用通配符")
if entries.get("NODE_ENV", "production") != "production":
    fail("NODE_ENV 必须是 production")
print("✓ 生产密钥与 CORS 域名格式已检查（未打印敏感值）")
PY

docker compose -f docker-compose.yml config --quiet || die "Docker Compose 配置检查未通过"

# The image size is ~GiB-scale. Keep room for the incoming image and its rollback copy.
free_bytes="$(df -B1 --output=avail "$root" | tail -1 | tr -d ' ')"
[[ "$free_bytes" =~ ^[0-9]+$ ]] || die "无法确认可用磁盘空间"
if (( free_bytes < 6 * 1024 * 1024 * 1024 )); then
  die "磁盘可用空间不足 6 GiB，请清理空间或扩容后再部署"
fi
echo "✓ 新 VPS 只读预检通过：Docker、仓库、持久卷声明、生产配置、磁盘均可用"
