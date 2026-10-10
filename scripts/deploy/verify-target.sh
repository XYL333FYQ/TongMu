#!/usr/bin/env bash
# 本脚本只校验新 VPS 配置，不执行 SSH、构建或部署。
set -Eeuo pipefail

fail() { printf '::error::TongMu 生产部署目标校验失败：%s\n' "$1" >&2; exit 1; }

[[ "${DEPLOY_TARGET_GUARD:-}" == "fresh-vps-ready" ]] ||
  fail '没有配置 production 环境的 DEPLOY_TARGET_GUARD=fresh-vps-ready。为避免误部署到旧香港 VPS，已停止。'
[[ -n "${VPS_HOST:-}" && -n "${VPS_USER:-}" && -n "${VPS_PORT:-}" ]] ||
  fail '缺少 production 环境的 PRODUCTION_VPS_HOST / PRODUCTION_VPS_USER / PRODUCTION_VPS_PORT。'
[[ -n "${VPS_SSH_KEY:-}" && -n "${VPS_SSH_HOST_KEY:-}" ]] ||
  fail '缺少 production 环境的 PRODUCTION_VPS_SSH_KEY / PRODUCTION_VPS_HOST_KEY。'

[[ "$VPS_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ && "$VPS_HOST" != *..* ]] ||
  fail 'VPS_HOST 只能是 IPv4 地址或不含端口的 DNS 主机名。'
[[ "$VPS_HOST" != "8.217.140.53" && "$VPS_HOST" != "localhost" && "$VPS_HOST" != "127.0.0.1" ]] ||
  fail '禁止将旧香港 VPS 或本机作为新生产目标。'
[[ "$VPS_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] ||
  fail 'VPS_USER 必须是 Linux 用户名（不包含空格或特殊字符）。'
[[ "$VPS_PORT" =~ ^[0-9]{1,5}$ ]] &&
  (( 10#$VPS_PORT >= 1 && 10#$VPS_PORT <= 65535 )) ||
  fail 'PRODUCTION_VPS_PORT 必须为 1–65535。'
[[ "$VPS_SSH_HOST_KEY" =~ ^ssh-ed25519[[:space:]]AAA[A-Za-z0-9+/=]+$ ]] ||
  fail 'PRODUCTION_VPS_HOST_KEY 必须是目标机的 ssh-ed25519 公钥（不含注释）。'

printf '✓ TongMu 新生产目标配置完整且不是旧香港 VPS；SSH 主机公钥已固定。\n'
