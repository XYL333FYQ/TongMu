/**
 * Shared byte-range response helpers for local and remote-backed files.
 * Providers supply a stream; this module owns HTTP range semantics.
 */
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { redactMediaError } from '../media/redact';
import {
  parseByteRangeHeader,
  resolveByteRange,
  type ResolvedByteRange,
} from './byte-range';

export type ParsedRange = ResolvedByteRange;

/** Compatibility helper for known-size single-range consumers. */
export function parseRangeHeader(
  rangeHeader: string | string[] | undefined,
  fileSize: number,
): ParsedRange | 'invalid' | null {
  const parsed = parseByteRangeHeader(rangeHeader);
  if (!parsed) return null;
  const resolved = resolveByteRange(parsed, fileSize);
  return resolved.kind === 'single' ? resolved.range : 'invalid';
}

export function sendRangeNotSatisfiable(
  res: Response,
  fileSize: number,
  message = '请求的字节范围不可满足',
): void {
  res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
  res.json({ success: false, message });
}

export interface PipeRangeStreamOptions {
  stream: Readable;
  contentType: string;
  fileSize: number;
  start?: number;
  end?: number;
  /** Whether the response represents one resolved Range request. */
  ranged: boolean;
  /** Advertise seek support when this provider knows it supports byte ranges. */
  advertiseRanges?: boolean;
  logTag: string;
  errorMessage: string;
  errorCode?: string;
  cors?: 'wildcard' | 'global';
  softDestroy?: boolean;
}

function setWildcardCors(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
}

/** Pipe a provider stream with exactly matching 200/206 and length headers. */
export function pipeRangeStream(res: Response, options: PipeRangeStreamOptions): void {
  const {
    stream,
    contentType,
    fileSize,
    start = 0,
    end = Math.max(0, fileSize - 1),
    ranged,
    advertiseRanges = true,
    logTag,
    errorMessage,
    errorCode,
    cors = 'wildcard',
    softDestroy = false,
  } = options;

  if (cors === 'wildcard') setWildcardCors(res);
  res.setHeader('Content-Type', contentType);
  if (advertiseRanges) res.setHeader('Accept-Ranges', 'bytes');
  const responseLength = ranged ? Math.max(0, end - start + 1) : fileSize;
  res.setHeader('Content-Length', String(responseLength));
  if (ranged) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  } else {
    res.status(200);
  }
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Proxy-Buffering', 'no');

  res.on('close', () => {
    if (!res.writableFinished && !stream.destroyed) stream.destroy();
  });

  stream.once('error', (err) => {
    console.error(`[${logTag}] stream error:`, redactMediaError(err));
    if (!res.headersSent) {
      res.status(502).json({ success: false, message: errorMessage, code: errorCode });
    } else if (!res.writableEnded) {
      if (softDestroy) res.end();
      else res.destroy();
    }
  });

  if (res.req?.method === 'HEAD') {
    if (softDestroy) stream.destroy();
    res.end();
    return;
  }
  // Providers must return a stream bounded to [start,end] for ranged responses.
  stream.pipe(res);
}

export {
  formatContentRange,
  parseByteRangeHeader,
  parseContentRangeHeader,
  resolveByteRange,
  type ByteRangeRequest,
  type ByteRangeResolution,
} from './byte-range';
