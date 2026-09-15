/** Fetch subtitle text without allowing a stale media generation to commit it. */
export interface GenerationBoundSubtitleFetchOptions {
  url: string
  generation: number | undefined
  getCurrentGeneration: () => number | undefined
  signal?: AbortSignal
}

export async function fetchGenerationBoundSubtitleText({
  url,
  generation,
  getCurrentGeneration,
  signal,
}: GenerationBoundSubtitleFetchOptions): Promise<string | null> {
  if (signal?.aborted || getCurrentGeneration() !== generation) return null

  try {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const content = await response.text()
    if (signal?.aborted || getCurrentGeneration() !== generation) return null
    return content
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return null
    }
    throw error
  }
}
