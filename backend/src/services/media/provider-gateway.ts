import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { createFTPReadStream, type FTPConnectionParams } from '../ftp';
import { parseRangeHeader, pipeRangeStream, sendRangeNotSatisfiable } from '../proxy/range-stream';
import { redactMediaError } from './redact';
import type { MediaHandleResource } from './handles';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function localFileStillWithinRoot(filePath: string, rootPath: string): Promise<{ stat: fs.Stats; realPath: string }> {
  return Promise.all([fs.promises.realpath(filePath), fs.promises.realpath(rootPath)]).then(([realPath, realRoot]) => {
    const relative = path.relative(realRoot, realPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('文件引用已失效');
    return fs.promises.stat(realPath).then((stat) => {
      if (!stat.isFile()) throw new Error('文件引用已失效');
      return { stat, realPath };
    });
  });
}

async function pipeLocalFile(req: Request, res: Response, resource: MediaHandleResource): Promise<void> {
  const data = resource.providerData ?? {};
  const filePath = stringValue(data.filePath);
  const rootPath = stringValue(data.rootPath);
  const expectedSize = numberValue(data.fileSize);
  const contentType = stringValue(data.contentType) ?? 'application/octet-stream';
  if (!filePath || !rootPath || expectedSize === undefined) throw new Error('文件引用已失效');
  const current = await localFileStillWithinRoot(filePath, rootPath);
  const expectedMtime = numberValue(data.mtimeMs);
  if (current.stat.size !== expectedSize || (expectedMtime !== undefined && current.stat.mtimeMs !== expectedMtime)) {
    res.status(410).json({ success: false, message: '文件已变化，请重新解析' });
    return;
  }
  const parsed = parseRangeHeader(req.headers.range, current.stat.size);
  if (parsed === 'invalid') {
    sendRangeNotSatisfiable(res, current.stat.size);
    return;
  }
  const range = parsed;
  const stream = range
    ? fs.createReadStream(current.realPath, { start: range.start, end: range.end })
    : fs.createReadStream(current.realPath);
  pipeRangeStream(res, {
    stream,
    contentType,
    fileSize: current.stat.size,
    start: range ? range.start : 0,
    end: range ? range.end : Math.max(0, current.stat.size - 1),
    ranged: !!range,
    logTag: 'media-local-file',
    errorMessage: '本地文件读取失败',
  });
}

function ftpParams(value: unknown): FTPConnectionParams | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.serverUrl !== 'string' || typeof input.path !== 'string') return undefined;
  return {
    serverUrl: input.serverUrl,
    path: input.path,
    port: typeof input.port === 'number' ? input.port : undefined,
    username: typeof input.username === 'string' ? input.username : undefined,
    password: typeof input.password === 'string' ? input.password : undefined,
  };
}

async function pipeFtpFile(req: Request, res: Response, resource: MediaHandleResource): Promise<void> {
  const data = resource.providerData ?? {};
  const params = ftpParams(data.params);
  const fileSize = numberValue(data.fileSize);
  const contentType = stringValue(data.contentType) ?? 'application/octet-stream';
  if (!params || fileSize === undefined) throw new Error('FTP 文件引用已失效');
  const parsed = parseRangeHeader(req.headers.range, fileSize);
  if (parsed === 'invalid') {
    sendRangeNotSatisfiable(res, fileSize);
    return;
  }
  const range = parsed;
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.once('close', abort);
  const cleanup = () => res.off('close', abort);
  try {
    const stream = createFTPReadStream(
      params,
      range ? range.start : 0,
      range ? range.end : undefined,
      controller.signal,
    );
    stream.once('end', cleanup);
    stream.once('close', cleanup);
    stream.once('error', cleanup);
    pipeRangeStream(res, {
      stream,
      contentType,
      fileSize,
      start: range ? range.start : 0,
      end: range ? range.end : Math.max(0, fileSize - 1),
      ranged: !!range,
      advertiseRanges: data.seekSupported !== false,
      logTag: 'media-ftp',
      errorMessage: 'FTP 文件读取失败',
      softDestroy: true,
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Serve a sealed Local File/FTP handle; HTTP-backed providers stay on http-proxy. */
export async function pipeProviderMediaHandle(
  req: Request,
  res: Response,
  resource: MediaHandleResource,
): Promise<boolean> {
  if (resource.providerId !== 'local-file' && resource.providerId !== 'ftp') return false;
  try {
    if (resource.providerId === 'local-file') await pipeLocalFile(req, res, resource);
    else await pipeFtpFile(req, res, resource);
  } catch (error) {
    if (!res.headersSent) res.status(502).json({ success: false, message: redactMediaError(error) });
    else if (!res.writableEnded) res.destroy();
  }
  return true;
}
