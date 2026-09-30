function requestKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  )
}

export class MovieSubmissionError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** In-memory only: credentials/URLs must never be written to browser storage. */
export function createMovieSubmitter(
  send: (body: string, key: string, scope: string) => Promise<void>,
  newKey = requestKey
) {
  const requests = new Map<string, { key: string; pending?: Promise<void> }>()
  return (scope: string, payload: unknown): Promise<void> => {
    const body = JSON.stringify(payload)
    const identity = JSON.stringify([scope, body])
    let entry = requests.get(identity)
    if (entry?.pending) return entry.pending
    if (!entry) {
      // Retain at most 32 failed requests; never evict an active POST.
      if (requests.size >= 32) {
        const failed = [...requests].find(([, candidate]) => !candidate.pending)
        if (failed) requests.delete(failed[0])
        else
          return Promise.reject(new Error('添加请求过多，请等待当前请求完成'))
      }
      entry = { key: newKey() }
      requests.set(identity, entry)
    }
    const current = entry
    const pending = Promise.resolve()
      .then(() => send(body, current.key, scope))
      .then(() => {
        requests.delete(identity)
      })
      .catch((error) => {
        // A conflict/deleted receipt requires a new explicit attempt. A lost
        // response or server error keeps the original key because creation may
        // already have committed.
        if (
          error instanceof MovieSubmissionError &&
          [400, 409].includes(error.status)
        )
          requests.delete(identity)
        throw error instanceof MovieSubmissionError
          ? error
          : new MovieSubmissionError(
              0,
              '添加结果尚未确认，请再次点击添加；重试不会重复创建影片'
            )
      })
      .finally(() => {
        current.pending = undefined
      })
    current.pending = pending
    return pending
  }
}
