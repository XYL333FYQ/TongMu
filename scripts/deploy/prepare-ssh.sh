#!/usr/bin/env bash
# 使用来自服务器控制台的主机公钥固定 SSH 身份；不盲信 ssh-keyscan。
set -Eeuo pipefail
bash "$(dirname "$0")/verify-target.sh"
umask 077
install -d -m 700 "$HOME/.ssh"
printf '%s\n' "$VPS_SSH_KEY" > "$HOME/.ssh/tongmu_actions"
chmod 600 "$HOME/.ssh/tongmu_actions"
ssh-keygen -y -P '' -f "$HOME/.ssh/tongmu_actions" > /dev/null ||
  { echo '::error::PRODUCTION_VPS_SSH_KEY 无法作为无口令 SSH 私钥使用。' >&2; exit 1; }
if [[ "$VPS_PORT" == 22 ]]; then
  host_field="$VPS_HOST"
else
  host_field="[$VPS_HOST]:$VPS_PORT"
fi
printf '%s %s\n' "$host_field" "$VPS_SSH_HOST_KEY" > "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"
ssh-keygen -F "$host_field" -f "$HOME/.ssh/known_hosts" > /dev/null ||
  { echo '::error::SSH 主机公钥文件无法验证。' >&2; exit 1; }
echo '✓ 固定 SSH 主机公钥完成（不会将新 VPS 的身份校验交给未验证的 ssh-keyscan）。'
