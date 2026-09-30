const NEGATIVE_HINT = /(?:^|[\W_])(ad|ads|advert|analytics|beacon|pixel|poster|thumb|preview|preroll)(?:[\W_]|$)/i;
const QUALITY_HINT = /(?:2160|1440|1080|720|4k|uhd)/i;

/** Keep the highest discovered sibling; never invent a quality destination. */
export function rankMediaCandidates<T extends { url: string; score: number }>(candidates: T[]): T[] {
  const facts = candidates.map(candidate => {
    const url = new URL(candidate.url);
    const match = /(^|[\/_.-])((?:2160|1440|1080|720|540|480|360|300|240|180)p|4k|uhd)(?=[\/_.-]|$)/i.exec(url.pathname);
    const height = match ? /4k|uhd/i.test(match[2]) ? 2160 : parseInt(match[2], 10) : 0;
    const path = match ? url.pathname.replace(match[0], `${match[1]}{quality}`) : url.pathname;
    return { candidate, height, family: `${url.origin}${path}${url.search}` };
  });
  const familyScores = new Map<string, number>();
  const familyHeights = new Map<string, number>();
  for (const fact of facts) {
    familyScores.set(fact.family, Math.max(familyScores.get(fact.family) ?? -Infinity, fact.candidate.score));
    familyHeights.set(fact.family, Math.max(familyHeights.get(fact.family) ?? 0, fact.height));
  }
  // A player can first request its 720p sibling while the playback API also
  // advertises 1080p. Both share the main-media relevance, then prefer quality.
  return facts.filter(fact => fact.height === familyHeights.get(fact.family))
    .sort((a, b) => familyScores.get(b.family)! - familyScores.get(a.family)! || b.height - a.height || b.candidate.score - a.candidate.score)
    .map(fact => fact.candidate);
}

export function scoreMediaCandidate(url: string, base: number): number {
  let score = base;
  if (/\.(?:m3u8|mpd)(?:[?#]|$)/i.test(url)) score += 20;
  if (/\.(?:mp4|webm|mkv|flv)(?:[?#]|$)/i.test(url)) score += 10;
  if (QUALITY_HINT.test(url)) score += 5;
  if (NEGATIVE_HINT.test(url)) score -= 80;
  return score;
}
