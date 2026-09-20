import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { logger, runWithRequestContext } from './logger';
import { boundedMatchedRoute, httpMethod, metrics, statusClass } from './metrics';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/;

export function acceptedRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) return undefined;
  return value;
}

export function requestIdFromHeader(value: unknown): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  return acceptedRequestId(candidate) ?? randomUUID();
}

function pathSegments(value: string): string[] {
  return value.split('/').filter(Boolean);
}

export function resolveMatchedRoute(req: Pick<Request, 'route' | 'originalUrl'>): string {
  const routePath = req.route?.path;
  if (typeof routePath !== 'string' || !routePath.startsWith('/')) return 'UNMATCHED';
  const originalPath = (() => {
    try { return new URL(req.originalUrl, 'http://tongmu.invalid').pathname; }
    catch { return ''; }
  })();
  const concrete = pathSegments(originalPath);
  const template = pathSegments(routePath);
  if (template.length > concrete.length) return 'UNMATCHED';
  const prefix = concrete.slice(0, concrete.length - template.length);
  // Prefix segments come only from Express router mounts. Reject anything
  // outside TongMu's fixed public/internal roots instead of logging raw paths.
  const root = prefix[0] ?? template[0];
  if (root !== 'api' && root !== 'health' && root !== 'internal' && root !== 'live') {
    return 'UNMATCHED';
  }
  return boundedMatchedRoute(`/${[...prefix, ...template].join('/')}`);
}

export function chunkBytes(chunk: unknown, encoding?: BufferEncoding): number {
  if (chunk === null || chunk === undefined) return 0;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, encoding);
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

function authCategory(req: AuthenticatedRequest): string {
  if (!req.user) return 'anonymous';
  if (req.user.role === 'root') return 'root';
  if (req.user.role === 'guest') return 'guest';
  if (req.user.role === 'admin') return 'privileged';
  return 'authenticated';
}

export function httpObservabilityMiddleware(): RequestHandler {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const requestId = requestIdFromHeader(req.headers['x-request-id']);
    res.setHeader('X-Request-Id', requestId);
    const start = process.hrtime.bigint();
    let bytes = 0;
    let completed = false;
    let matchedRouteBeforeCompletion: string | undefined;
    const originalWrite = res.write;
    const originalEnd = res.end;

    res.write = function observedWrite(this: Response, chunk: unknown, ...args: unknown[]): boolean {
      matchedRouteBeforeCompletion ??= resolveMatchedRoute(req);
      bytes += chunkBytes(chunk, typeof args[0] === 'string' ? args[0] as BufferEncoding : undefined);
      return Reflect.apply(originalWrite, this, [chunk, ...args]) as boolean;
    } as typeof res.write;
    res.end = function observedEnd(this: Response, chunk?: unknown, ...args: unknown[]): Response {
      matchedRouteBeforeCompletion ??= resolveMatchedRoute(req);
      bytes += chunkBytes(chunk, typeof args[0] === 'string' ? args[0] as BufferEncoding : undefined);
      return Reflect.apply(originalEnd, this, [chunk, ...args]) as Response;
    } as typeof res.end;

    const complete = (event: 'finish' | 'close') => {
      if (completed) return;
      completed = true;
      res.off('finish', onFinish);
      res.off('close', onClose);
      res.write = originalWrite;
      res.end = originalEnd;
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      const matchedRoute = matchedRouteBeforeCompletion ?? resolveMatchedRoute(req);
      const method = httpMethod(req.method);
      const responseClass = statusClass(res.statusCode);
      metrics.increment('http_requests_total', { method, matched_route: matchedRoute, status_class: responseClass });
      metrics.observe('http_request_duration_seconds', { method, matched_route: matchedRoute }, durationMs / 1_000);
      metrics.increment('http_response_bytes_total', { matched_route: matchedRoute, status_class: responseClass }, bytes);
      logger.info('http', 'request_completed', {
        requestId,
        method,
        matchedRoute,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        responseBytes: bytes,
        authCategory: authCategory(req),
        completion: event,
      });
    };
    const onFinish = () => complete('finish');
    const onClose = () => complete('close');
    res.once('finish', onFinish);
    res.once('close', onClose);

    runWithRequestContext({ requestId }, next);
  };
}

export function metricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:1|true|yes|on)$/i.test(env.OBSERVABILITY_METRICS_ENABLED ?? '');
}

export const prometheusContentType = 'text/plain; version=0.0.4; charset=utf-8';
