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
  # The deployment id is validated above; remove only its private registry auth
  # directory and known payload files, never the persistent application volume.
  if [[ -d "$staging" && ! -L "$staging" ]]; then
    docker_auth="$staging/docker-auth"
    if [[ -d "$docker_auth" && ! -L "$docker_auth" && "$(readlink -f -- "$docker_auth")" = "$staging/docker-auth" ]]; then
      rm -rf -- "$docker_auth"
    fi
    rm -f -- "$staging/image.tar.gz" "$staging/image.sha256" "$staging/image-id.txt" "$staging/image-content.sha256" "$staging/image_identity.py" "$staging/health.json"
    rmdir -- "$staging" 2>/dev/null || true
  fi
}
if [[ "$phase" = cleanup ]]; then cleanup; exit 0; fi
[[ "$phase" = prepare || "$phase" = deploy || "$phase" = prepare-registry || "$phase" = deploy-registry ]]
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

if [[ "$phase" = prepare-registry ]]; then
  image_bytes="${4:?Missing image size}"
  [[ "$image_bytes" =~ ^[0-9]{1,12}$ && "$image_bytes" -gt 0 ]]
  if [[ ! -d "$staging_root" ]]; then mkdir -m 700 "$staging_root"; fi
  staging_root_real="$(readlink -f -- "$staging_root")"
  [[ "$staging_root_real" = "${root}.deploy" ]]
  # Canceled SCP runs can leave partial archives behind. Remove only inactive,
  # strictly named TongMu deployment staging directories; keep live transfers.
  shopt -s nullglob
  for abandoned in "$staging_root_real"/*; do
    [[ -d "$abandoned" && ! -L "$abandoned" ]] || continue
    abandoned_id="${abandoned##*/}"
    [[ "$abandoned_id" =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ && "$abandoned_id" != "$deployment_id" ]] || continue
    abandoned_real="$(readlink -f -- "$abandoned")"
    [[ "$abandoned_real" = "$staging_root_real/$abandoned_id" ]] || continue
    abandoned_sha="${abandoned_id:0:40}"
    active_file_transfer="$(pgrep -a -u "$(id -u)" -f 'sftp-server|scp -t' || true)"
    active_deploy="$(pgrep -f -- "deploy-registry $abandoned_sha $abandoned_id" || true)"
    if [[ -n "$active_file_transfer" || -n "$active_deploy" ]]; then
      printf 'Keeping active TongMu staging transfer: %s\n' "$abandoned_id"
      continue
    fi
    abandoned_bytes="$(du -sb -- "$abandoned_real" | awk '{print $1}')"
    [[ "$abandoned_bytes" =~ ^[0-9]+$ ]]
    rm -rf -- "$abandoned_real"
    printf 'Removed abandoned TongMu transfer staging: %s bytes (%s)\n' "$abandoned_bytes" "$abandoned_id"
  done
  shopt -u nullglob
  docker_root="$(docker info --format '{{.DockerRootDir}}')"
  # Registry pulls reuse matching base layers already stored by Docker. Reserve
  # the full new image plus margin so a slow filesystem never fills mid-pull.
  required=$((image_bytes + 536870912))
  for directory in "$(dirname "$root")" "$docker_root"; do
    available="$(df -B1 --output=avail "$directory" | tail -1 | tr -d ' ')"
    [[ "$available" =~ ^[0-9]+$ ]]
    if (( available < required )); then
      printf 'Insufficient free disk space for registry pull: need %s bytes.\n' "$required" >&2
      exit 1
    fi
  done
  if [[ ! -d "$staging_root" ]]; then mkdir -m 700 "$staging_root"; fi
  mkdir -m 700 "$staging"
  printf 'Registry pull preflight passed; reserving %s bytes including margin.\n' "$required"
  exit 0
fi

if [[ "$phase" = deploy-registry ]]; then
  registry="${4:?Missing registry image}"
  digest="${5:?Missing immutable image digest}"
  expected_content="${6:?Missing portable image identity}"
  [[ "$registry" =~ ^ghcr\.io/[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9._-]*$ ]]
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ && "$expected_content" =~ ^[0-9a-f]{64}$ ]]
  [[ -d "$staging" ]]
  trap cleanup EXIT
  docker_auth="$staging/docker-auth"
  [[ "${DOCKER_CONFIG:-}" = "$docker_auth" && -f "$docker_auth/config.json" ]]
  export DOCKER_CONFIG="$docker_auth"
  docker_root="$(docker info --format '{{.DockerRootDir}}')"
  check_checkout

  # Pull by immutable digest. Docker downloads only absent content-addressed
  # layers and reuses the existing Chromium, OS and dependency layers.
  nice -n 10 docker pull "$registry@$digest"
  docker logout ghcr.io > /dev/null 2>&1 || true
  rm -rf -- "$docker_auth"
  unset DOCKER_CONFIG
  image="tongmu-release:$expected_sha"
  docker tag "$registry@$digest" "$image"
  actual_content="$(docker image inspect "$image" | python3 scripts/deploy/image_identity.py)"
  if [[ "$actual_content" != "$expected_content" ]]; then
    printf '%s\n' 'Pulled image filesystem or startup configuration does not match the verified build.' >&2
    exit 1
  fi
  if ! docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" |
    grep -Fx "TONGMU_BUILD_SHA=$expected_sha" > /dev/null; then
    printf '%s\n' 'Pulled image is missing the expected build commit.' >&2
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
      # Keep the active release and one immediately previous release. Remove
      # only tags we created under tongmu-release; never prune Docker globally.
      set +e
      release_listing="$(docker image ls --no-trunc --format '{{.ID}}\t{{.Repository}}\t{{.Tag}}')"
      listing_status=$?
      mapfile -t release_ids < <(printf '%s\n' "$release_listing" |
        awk -F '\t' '$2 == "tongmu-release" && $3 ~ /^[0-9a-f]+$/ && length($3) == 40 {print $1}' | sort -u)
      if (( listing_status != 0 )); then
        printf '%s\n' 'Warning: could not list old TongMu releases for cleanup.' >&2
      fi
      if (( ${#release_ids[@]} > 0 )); then
        if ! docker image inspect "${release_ids[@]}" |
          python3 scripts/deploy/retained-release-images.py "$expected_sha" |
          while IFS= read -r old_image; do
            [[ "$old_image" =~ ^tongmu-release:[0-9a-f]{40}$ ]] || continue
            docker image rm -- "$old_image" || exit 1
          done; then
          printf '%s\n' 'Warning: deployment passed, but cleanup of old TongMu image tags failed.' >&2
        fi
      fi
      set -e
      printf '%s\n' 'Post-deploy disk and Docker image usage:'
      df -h "$(dirname "$root")" "$docker_root"
      docker system df
      exit 0
    fi
    printf 'Waiting for the verified application (%s/30)...\n' "$attempt"
    sleep 2
  done
  printf '%s\n' 'New image did not become healthy. Persistent data and previous images were retained; database migration may prevent automatic rollback.' >&2
  "${compose[@]}" ps
  exit 1
fi

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
