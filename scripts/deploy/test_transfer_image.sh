#!/usr/bin/env bash
set -Eeuo pipefail
script="$(cd "$(dirname "$0")" && pwd)/transfer-image.sh"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir "$fixture/bin"
cat > "$fixture/bin/scp" <<'SH'
#!/usr/bin/env bash
case "$TRANSFER_TEST_MODE" in
  failure) exit 23 ;;
  progress) /usr/bin/sleep 0.15 ;;
  stalled) exec /usr/bin/sleep 2 ;;
esac
SH
cat > "$fixture/bin/ssh" <<'SH'
#!/usr/bin/env bash
if [[ "$TRANSFER_TEST_MODE" = stalled ]]; then printf 0; exit; fi
value=$(cat "$TRANSFER_TEST_COUNTER" 2>/dev/null || printf 0)
value=$((value + 100))
printf '%s' "$value" > "$TRANSFER_TEST_COUNTER"
printf '%s' "$value"
SH
cat > "$fixture/bin/sleep" <<'SH'
#!/usr/bin/env bash
exec /usr/bin/sleep 0.01
SH
chmod +x "$fixture/bin/"*
export PATH="$fixture/bin:$PATH" VPS_HOST=fixture.invalid VPS_USER=fixture VPS_PORT=22
export TRANSFER_TEST_COUNTER="$fixture/counter"
identifier=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1-1
TRANSFER_TEST_MODE=progress bash "$script" "$identifier" 100000 > "$fixture/progress.log"
grep -q 'Archive transfer:' "$fixture/progress.log"
grep -q 'payload transferred' "$fixture/progress.log"
if TRANSFER_TEST_MODE=failure bash "$script" "$identifier" 100000 > "$fixture/failure.log" 2>&1; then
  printf '%s\n' 'Failed copy was incorrectly accepted.' >&2; exit 1
fi
if TRANSFER_TEST_MODE=stalled bash "$script" "$identifier" 100000 > "$fixture/stalled.log" 2>&1; then
  printf '%s\n' 'Stalled copy was incorrectly accepted.' >&2; exit 1
fi
grep -q 'stopped making measurable progress' "$fixture/stalled.log"
if TRANSFER_TEST_MODE=progress bash "$script" '../../outside' 100000 >/dev/null 2>&1; then
  printf '%s\n' 'Unsafe staging identifier was incorrectly accepted.' >&2; exit 1
fi
printf '%s\n' 'Transfer tests passed: progress, copy failure, stalled transfer, invalid staging.'
