#!/usr/bin/env bash
set -Eeuo pipefail
cd /opt/TongMu
container="$(docker compose ps -q tongmu)"
[[ -n "$container" ]]
docker inspect --format 'TongMu state={{.State.Status}} restarts={{.RestartCount}}' "$container"
curl -fsS --max-time 5 http://127.0.0.1:3333/health
printf '\n'
# Use only public source requests and sanitized parser errors. Never dump env,
# credentials, database contents, signed playback URLs, or application logs.
docker exec -i "$container" node <<'NODE'
const { resolveBilibiliVideo } = require('/app/backend/dist/services/bilibili/resolver');
const { redactMediaError } = require('/app/backend/dist/services/media/redact');
async function probe(label, url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }, signal: AbortSignal.timeout(15000) });
    const isJson = (r.headers.get('content-type') || '').includes('json');
    const body = isJson ? await r.json() : null;
    await r.body?.cancel().catch(() => {});
    console.log(JSON.stringify({ label, status: r.status, contentType: r.headers.get('content-type'), code: body?.code, message: body?.message }));
  } catch (e) { console.log(JSON.stringify({ label, error: redactMediaError(e) })); }
}
(async () => {
  await probe('Bilibili public video API', 'https://api.bilibili.com/x/web-interface/view?bvid=BV15z4y1U7HS');
  for (const bv of ['BV15z4y1U7HS', 'BV1Zs411o7Ee']) {
    try {
      const r = await resolveBilibiliVideo({ url: bv, userId: '0' });
      console.log(JSON.stringify({ label: bv, success: true, quality: r.currentQn, format: r.format }));
    } catch (e) {
      console.log(JSON.stringify({ label: bv, success: false, code: e.code, error: redactMediaError(e) }));
    }
  }
  await probe('1905 public film page', 'https://www.1905.com/vod/play/85388.shtml');
  await probe('Filmzie public film page', 'https://filmzie.com/content/the-reality-of-time-2025');
  await probe('Internet Archive public film page', 'https://archive.org/details/night_of_the_living_dead');
})().catch(e => { console.error(redactMediaError(e)); process.exitCode = 1; });
NODE
