import type { Request } from 'express';

const ANIME_REQUEST_TIMEOUT_MS = 30_000;

export interface AnimeRouteRequestContext {
  signal: AbortSignal;
  deadline: number;
  cleanup: () => void;
}

/** Bound catalog/scrape work to the client request and one shared deadline. */
export function createAnimeRouteRequestContext(req: Request): AnimeRouteRequestContext {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const deadline = Date.now() + ANIME_REQUEST_TIMEOUT_MS;
  const timer = setTimeout(abort, ANIME_REQUEST_TIMEOUT_MS);
  req.once('aborted', abort);

  return {
    signal: controller.signal,
    deadline,
    cleanup: () => {
      clearTimeout(timer);
      req.off('aborted', abort);
    },
  };
}
