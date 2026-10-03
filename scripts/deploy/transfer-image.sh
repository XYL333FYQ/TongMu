#!/usr/bin/env bash
set -Eeuo pipefail

deployment_id="${1:?Missing deployment ID}"
archive_bytes="${2:?Missing archive size}"
[[ "$deployment_id" =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ ]]
[[ "$archive_bytes" =~ ^[0-9]{1,12}$ && "$archive_bytes" -gt 0 ]]
staging="/opt/TongMu.deploy/$deployment_id"
ssh_options=(-i ~/.ssh/tongmu_actions -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=3)
printf 'Transferring verified archive: %s bytes.\n' "$archive_bytes"
timeout 60m scp "${ssh_options[@]}" -P "$VPS_PORT" \
  image/image.tar.gz image/image.sha256 image/image-id.txt image/image-content.sha256 image/image_identity.py \
  "$VPS_USER@$VPS_HOST:$staging/" &
transfer_pid=$!
stop_transfer() {
  kill "$transfer_pid" 2>/dev/null || true
  wait "$transfer_pid" 2>/dev/null || true
}
trap stop_transfer EXIT
previous_bytes=0
stalled_checks=0
while kill -0 "$transfer_pid" 2>/dev/null; do
  sleep 60
  if ! kill -0 "$transfer_pid" 2>/dev/null; then break; fi
  # Report byte counts only; do not emit credentials, image contents or URLs.
  received="$(timeout 30s ssh "${ssh_options[@]}" -p "$VPS_PORT" "$VPS_USER@$VPS_HOST" \
    "stat -c %s '$staging/image.tar.gz' 2>/dev/null || printf 0")" || received=unknown
  if [[ "$received" =~ ^[0-9]{1,12}$ ]]; then
    printf 'Archive transfer: %s / %s bytes (%s%%).\n' "$received" "$archive_bytes" "$((received * 100 / archive_bytes))"
    if (( received > previous_bytes )); then stalled_checks=0; else stalled_checks=$((stalled_checks + 1)); fi
    previous_bytes=$received
  else
    printf '%s\n' 'Transfer progress check could not reach the VPS.'
    stalled_checks=$((stalled_checks + 1))
  fi
  if (( stalled_checks >= 5 )); then
    printf '%s\n' 'Archive transfer stopped making measurable progress; refusing to start the new image.' >&2
    exit 1
  fi
done
wait "$transfer_pid"
trap - EXIT
printf '%s\n' 'Verified image payload transferred; checking checksum and image identity next.'
