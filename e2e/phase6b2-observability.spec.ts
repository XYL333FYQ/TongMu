import { expect, test } from '@playwright/test';

const BACKEND_ORIGIN = 'http://127.0.0.1:3333';

test('Phase 6B-2 health echoes a bounded request ID and metrics stay disabled by default', async ({ request }) => {
  const requestId = 'phase6b2-e2e.safe-123';
  const health = await request.get(`${BACKEND_ORIGIN}/health`, {
    headers: { 'X-Request-Id': requestId },
  });

  expect(health.status()).toBe(200);
  expect(health.headers()['x-request-id']).toBe(requestId);
  await expect(health.json()).resolves.toMatchObject({ status: 'ok' });

  const metrics = await request.get(`${BACKEND_ORIGIN}/internal/metrics`);
  expect(metrics.status()).toBe(404);
  expect(metrics.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  await expect(metrics.json()).resolves.toMatchObject({
    success: false,
    message: 'Metrics disabled',
  });
});
