#!/usr/bin/env bash
set -Eeuo pipefail

phase="${1:?Expected prepare, deploy, or cleanup}"
expected_sha="${2:?Missing commit}"
deployment_id="${3:?Missing deployment ID}"
[[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$deployment_id" =~ ^${expected_sha}-[0-9]+-[0-9]+$ ]]
root="${TONGMU_DEPLOY_ROOT:-/opt/TongMu}"
[[ "$root" = /* && "$root" != / ]]
staging_root="${root}.deploy"
staging="$staging_root/$deployment_id"
[[ ! -L "$staging_root" && ! -L "$staging" ]]

cleanup() {
  # Only known payload files, never recursively remove deployment or data directories.
  if [[ -d "$staging" && ! -L "$staging" ]]; then
    rm -f -- "$staging/image.tar.gz" "$staging/image.sha256" "$staging/image-id.txt" "$staging/image-content.sha256" "$staging/image_identity.py" "$staging/health.json"
    rmdir -- "$staging" 2>/dev/null || true
  fi
}
if [[ "$phase" = cleanup ]]; then cleanup; exit 0; fi
[[ "$phase" = prepare || "$phase" = deploy ]]
cd "$root"

check_checkout() {
  if [[ -n "$(git status --porcelain)" ]]; then
    printf '%s\n' 'Refusing deployment: the VPS checkout has local changes.' >&2
    exit 1
  fi
  git fetch origin main
  if [[ "$(git rev-parse origin/main)" != "$expected_sha" ]]; then
    printf '%s\n' 'Refusing a stale deployment: main changed after this image was built.' >&2
    exit 1
  fi
}
check_checkout

if [[ "$phase" = prepare ]]; then
  archive_bytes="${4:?Missing archive size}"
  image_bytes="${5:?Missing image size}"
  [[ "$archive_bytes" =~ ^[0-9]{1,12}$ && "$image_bytes" =~ ^[0-9]{1,12}$ ]]
  (( archive_bytes > 0 && image_bytes > 0 ))
  docker_root="$(docker info --format '{{.DockerRootDir}}')"
  # Allow for the archive, unpacked layers, and a 1 GiB reserve on both filesystems.
  required=$((archive_bytes + image_bytes + 1073741824))
  for directory in "$(dirname "$root")" "$docker_root"; do
    available="$(df -B1 --output=avail "$directory" | tail -1 | tr -d ' ')"
    [[ "$available" =~ ^[0-9]+$ ]]
    if (( available < required )); then
      printf 'Insufficient free disk space: need %s bytes.\n' "$required" >&2
      exit 1
    fi
  done
  if [[ ! -d "$staging_root" ]]; then mkdir -m 700 "$staging_root"; fi
  mkdir -m 700 "$staging"
  exit 0
fi

[[ -d "$staging" ]]
trap cleanup EXIT
read -r archive_sha archive_name < "$staging/image.sha256"
[[ "$archive_sha" =~ ^[0-9a-f]{64}$ && "$archive_name" = image.tar.gz ]]
[[ "$(sha256sum "$staging/image.tar.gz" | cut -d ' ' -f 1)" = "$archive_sha" ]]
expected_image_id="$(cat "$staging/image-id.txt")"
[[ "$expected_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]

# Import while the existing application keeps running. Never build on the VPS.
nice -n 10 docker load --input "$staging/image.tar.gz"
image="tongmu-release:$expected_sha"
actual_image_id="$(docker image inspect --format '{{.Id}}' "$image")"
if [[ "$actual_image_id" != "$expected_image_id" ]]; then
  printf '%s\n' 'Docker image-store IDs differ; checking portable content identity.'
fi
expected_content="$(cat "$staging/image-content.sha256")"
[[ "$expected_content" =~ ^[0-9a-f]{64}$ ]]
actual_content="$(docker image inspect "$image" | python3 "$staging/image_identity.py")"
if [[ "$actual_content" != "$expected_content" ]]; then
  printf '%s\n' 'Loaded image filesystem or startup configuration does not match the verified image.' >&2
  exit 1
fi
if ! docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" |
  grep -Fx "TONGMU_BUILD_SHA=$expected_sha" > /dev/null; then
  printf '%s\n' 'Loaded image is missing the expected build commit.' >&2
  exit 1
fi
check_checkout
git checkout main
git merge --ff-only origin/main
[[ "$(git rev-parse HEAD)" = "$expected_sha" ]]

export TONGMU_BUILD_SHA="$expected_sha"
compose=(docker compose -f docker-compose.yml -f docker-compose.deploy.yml)
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-build --pull never tongmu
health_file="$staging/health.json"
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:3333/health > "$health_file" &&
    python3 - "$health_file" "$expected_sha" <<'PY'
import json, sys
with open(sys.argv[1]) as source:
    health = json.load(source)
sys.exit(0 if health.get("status") == "ok" and health.get("commitSha") == sys.argv[2] else 1)
PY
  then
    printf 'TongMu deployment verified: %s\n' "$expected_sha"
    exit 0
  fi
  printf 'Waiting for the verified application (%s/30)...\n' "$attempt"
  sleep 2
done
printf '%s\n' 'New image did not become healthy. Persistent data and previous images were retained; database migration may prevent automatic rollback.' >&2
"${compose[@]}" ps
exit 1
