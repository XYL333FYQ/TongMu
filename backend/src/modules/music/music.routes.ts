import { Router } from 'express';
import { createMusicFixtureRouter } from './music-fixture.routes';
import { createNcmMusicRouter } from './ncm/routes';

/** Together Listen HTTP surface: deterministic fixture plus bounded NCM API. */
export function createMusicRouter(): Router {
  const router = Router();
  router.use(createMusicFixtureRouter());
  router.use(createNcmMusicRouter());
  return router;
}
