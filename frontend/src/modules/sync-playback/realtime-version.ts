export interface AuthorityMetadata {
  version?: number
  sourceGeneration?: number
}

/** Strict guard for incremental authoritative events. Equal versions are duplicates. */
export function shouldApplyAuthoritativeEvent(
  current: AuthorityMetadata,
  incoming: AuthorityMetadata,
): boolean {
  if (incoming.version === undefined || incoming.sourceGeneration === undefined) {
    return current.version === undefined || current.sourceGeneration === undefined
  }
  if (current.version === undefined || current.sourceGeneration === undefined) return true
  if (incoming.sourceGeneration !== current.sourceGeneration) {
    return incoming.sourceGeneration > current.sourceGeneration
  }
  return incoming.version > current.version
}

/** Snapshot recovery accepts an equal version but never an older generation/version. */
export function shouldApplySnapshot(
  current: AuthorityMetadata,
  incoming: AuthorityMetadata,
): boolean {
  if (incoming.version === undefined || incoming.sourceGeneration === undefined) return true
  if (current.version === undefined || current.sourceGeneration === undefined) return true
  if (incoming.sourceGeneration !== current.sourceGeneration) {
    return incoming.sourceGeneration > current.sourceGeneration
  }
  return incoming.version >= current.version
}
