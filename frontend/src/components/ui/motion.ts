/** Matches --tm-motion-exit; all disclosure cleanup follows the same motion. */
export const DISCLOSURE_EXIT_MS = 160

export function disclosureExitDuration(): number {
  if (typeof document === 'undefined') return DISCLOSURE_EXIT_MS
  const reduced =
    document.body.dataset.reducedMotion === 'true' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  return reduced ? 1 : DISCLOSURE_EXIT_MS
}
