const NEGATIVE_HINT = /(?:^|[\W_])(ad|ads|advert|analytics|beacon|pixel|poster|thumb|preview|preroll)(?:[\W_]|$)/i;
const QUALITY_HINT = /(?:2160|1440|1080|720|4k|uhd)/i;

export function scoreMediaCandidate(url: string, base: number): number {
  let score = base;
  if (/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(url)) score += 20;
  if (/\.(?:mp4|webm|mkv|flv)(?:[?#]|$)/i.test(url)) score += 10;
  if (QUALITY_HINT.test(url)) score += 5;
  if (NEGATIVE_HINT.test(url)) score -= 80;
  return score;
}
