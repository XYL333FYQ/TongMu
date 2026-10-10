#!/usr/bin/env bash
# GitHub CI 用：验证 fresh-VPS 目标 guard 能阻止未配置/旧香港/错误 SSH key。
set -Eeuo pipefail
script="$(cd "$(dirname "$0")" && pwd)/verify-target.sh"
dummy_private_key='-----BEGIN OPENSSH PRIVATE KEY-----'
host_key='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGV4YW1wbGVrZXltYXRlcmlhbGZvcnRlc3Rz'

run_guard() {
  env -i PATH="$PATH" HOME="$HOME" \
    DEPLOY_TARGET_GUARD="${1}" VPS_HOST="${2}" VPS_PORT="${3}" \
    VPS_USER=ubuntu VPS_SSH_KEY="$dummy_private_key" VPS_SSH_HOST_KEY="$host_key" \
    bash "$script" >/dev/null 2>&1
}
run_guard fresh-vps-ready 203.0.113.10 22 ||
  { echo 'valid future IP should pass'; exit 1; }
run_guard fresh-vps-ready new-vps.example.net 2222 ||
  { echo 'valid future hostname should pass'; exit 1; }
if run_guard fresh-vps-ready 8.217.140.53 22; then
  echo 'old Hong Kong IP must be rejected' >&2; exit 1
fi
if run_guard '' 203.0.113.10 22; then
  echo 'missing environment guard must be rejected' >&2; exit 1
fi
if run_guard fresh-vps-ready 203.0.113.10 0; then
  echo 'invalid port must be rejected' >&2; exit 1
fi
if run_guard fresh-vps-ready 'bad host; rm -rf /' 22; then
  echo 'malformed host must be rejected' >&2; exit 1
fi
echo '✓ 新 VPS 目标隔离检查通过：有效新目标可用；旧香港和缺失配置均被拒绝。'
