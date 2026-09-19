import { Router, raw } from 'express';
import type { Response } from 'express';
import {
  authenticateToken,
  AuthenticatedRequest,
  requireRoot,
} from '../middleware/auth';
import {
  getUpdateInfo,
  applyUpdate,
  applyUpdateFromFile,
  pendingUpdateState,
  UpdateNotConfiguredError,
  type UpdateStageEvent,
} from '../services/updater';

const router = Router();

const UPDATE_SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/i,
  /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/i,
  /\b(?:authorization|cookie|provider[_ -]?credential|signing[_ -]?private[_ -]?key)\b\s*[:=]/i,
];

export function safeUpdateErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error || '');
  if (!raw || UPDATE_SECRET_PATTERNS.some((pattern) => pattern.test(raw))) return fallback;
  const withoutUrlQueries = raw.replace(/https?:\/\/[^\s]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      return `${url.origin}${url.pathname}`;
    } catch { return '[invalid URL]'; }
  });
  return withoutUrlQueries.slice(0, 512);
}

function reportUpdateError(scope: string, error: unknown, fallback: string): string {
  const message = safeUpdateErrorMessage(error, fallback);
  console.error(`[updater:${scope}] ${message}`);
  return message;
}

export function requireUpdateMutationOrigin(
  req: AuthenticatedRequest,
  res: import('express').Response,
  next: import('express').NextFunction,
) {
  // Bearer-authenticated automation is not vulnerable to ambient-cookie CSRF.
  // Cookie-authenticated browser mutations must prove exact same origin.
  if (/^Bearer\s+\S+$/i.test(req.get('authorization') || '')) {
    next();
    return;
  }
  const origin = req.get('origin');
  const forwardedProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol;
  const forwardedHost = (req.get('x-forwarded-host') || '').split(',')[0].trim();
  const host = forwardedHost || req.get('host');
  if (!origin || !host) {
    res.status(403).json({ success: false, message: '更新请求缺少同源证明' });
    return;
  }
  try {
    if (new URL(origin).origin !== new URL(`${protocol}://${host}`).origin) {
      res.status(403).json({ success: false, message: '拒绝跨源更新请求' });
      return;
    }
    next();
  } catch {
    res.status(403).json({ success: false, message: '更新请求来源无效' });
  }
}

router.use(authenticateToken, requireRoot);

/** 查看当前更新事务；不包含 token、签名私钥或配置内容。 */
router.get('/state', (_req, res) => {
  res.json({ success: true, transaction: pendingUpdateState() });
});

/**
 * 向 SSE 客户端推送一个事件。
 * SSE 协议格式：`data: <json>\n\n`，前端用 ReadableStream 读取并按 `\n\n` 分割。
 *
 * 内部检查 res.writableEnded，避免客户端提前断开后写入已关闭的响应导致崩溃。
 */
function sendSSE(res: Response, event: UpdateStageEvent): void {
  if (res.writableEnded) return;
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    // 客户端已断开，忽略写入错误
  }
}

/** 检查更新 */
router.get(
  '/check',
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const includePrerelease = req.query.includePrerelease === 'true';
      const info = await getUpdateInfo(includePrerelease);
      res.json({ success: true, info });
    } catch (err) {
      const message = reportUpdateError('check', err, '检查更新失败');
      res.status(err instanceof UpdateNotConfiguredError ? 503 : 500).json({
        success: false,
        message,
      });
    }
  },
);

/**
 * 从 GitHub Releases 下载并应用更新（SSE 流式响应）。
 *
 * 与旧版 POST /apply 的区别：返回 `text/event-stream`，
 * 逐步推送 downloading / extracting / starting / done / error 事件，
 * 前端可实时展示下载进度条与阶段提示。
 *
 * 注意：仍保留 POST /apply 作为无进度的兼容接口。
 */
router.post(
  '/apply-stream',
  requireUpdateMutationOrigin,
  async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    // 设置 SSE 响应头（不显式设置 Connection 等 hop-by-hop 头部，避免代理冲突）
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    try {
      const includePrerelease = req.query.includePrerelease === 'true';
      await applyUpdate(includePrerelease, (event) => sendSSE(res, event));
    } catch (err) {
      sendSSE(res, {
        stage: 'error',
        message: reportUpdateError('apply-stream', err, '应用更新失败'),
      });
    } finally {
      res.end();
    }
  },
);

/** 从 GitHub Releases 下载并应用更新（无进度，兼容旧接口） */
router.post(
  '/apply',
  requireUpdateMutationOrigin,
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      const includePrerelease = req.query.includePrerelease === 'true';
      const result = await applyUpdate(includePrerelease);
      res.json(result);
    } catch (err) {
      const message = reportUpdateError('apply', err, '应用更新失败');
      res.status(err instanceof UpdateNotConfiguredError ? 503 : 500).json({
        success: false,
        message,
      });
    }
  },
);

/**
 * 上传压缩包并应用更新（SSE 流式响应）。
 *
 * 接收原始文件体（Content-Type: application/zip 或 application/gzip），
 * 不使用 multipart/form-data，避免引入 multer 依赖。
 * 前端直接将 File 对象作为 fetch body 发送，上传进度由浏览器 XHR 跟踪；
 * 服务端接收完毕后通过 SSE 推送 extracting / starting / done / error 事件。
 */
router.post(
  '/upload-stream',
  requireUpdateMutationOrigin,
  // 使用 express.raw 接收二进制文件数据，支持 zip 和 gzip 格式
  // 限制 500MB 以容纳大型构建产物
  raw({
    type: [
      'application/zip',
      'application/gzip',
      'application/octet-stream',
      'application/x-zip-compressed',
    ],
    limit: '500mb',
  }),
  async (
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> => {
    // 先校验文件数据，失败时返回普通 JSON 错误（此时还未切换到 SSE）
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ success: false, message: '未收到有效的文件数据' });
      return;
    }

    // 从 Content-Type 或查询参数推断文件名
    const contentType = req.headers['content-type'] || '';
    let filename = 'uploaded-update.zip';
    if (contentType.includes('gzip') || contentType.includes('tar')) {
      filename = 'uploaded-update.tar.gz';
    }
    const queryName = req.query.filename as string | undefined;
    if (queryName) {
      filename = queryName;
    }

    // 切换为 SSE 流式响应（不显式设置 Connection 等 hop-by-hop 头部，避免代理冲突）
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    try {
      await applyUpdateFromFile(req.body, filename, (event) =>
        sendSSE(res, event),
      );
    } catch (err) {
      sendSSE(res, {
        stage: 'error',
        message: reportUpdateError('upload-stream', err, '上传更新失败'),
      });
    } finally {
      res.end();
    }
  },
);

/**
 * 上传压缩包并应用更新（无进度，兼容旧接口）。
 *
 * 接收原始文件体（Content-Type: application/zip 或 application/gzip），
 * 不使用 multipart/form-data，避免引入 multer 依赖。
 * 前端直接将 File 对象作为 fetch body 发送。
 */
router.post(
  '/upload',
  requireUpdateMutationOrigin,
  // 使用 express.raw 接收二进制文件数据，支持 zip 和 gzip 格式
  // 限制 500MB 以容纳大型构建产物
  raw({
    type: [
      'application/zip',
      'application/gzip',
      'application/octet-stream',
      'application/x-zip-compressed',
    ],
    limit: '500mb',
  }),
  async (
    req: AuthenticatedRequest,
    res: import('express').Response,
  ): Promise<void> => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ success: false, message: '未收到有效的文件数据' });
        return;
      }

      // 从 Content-Type 或查询参数推断文件名
      const contentType = req.headers['content-type'] || '';
      let filename = 'uploaded-update.zip';
      if (contentType.includes('gzip') || contentType.includes('tar')) {
        filename = 'uploaded-update.tar.gz';
      }

      // 从查询参数获取文件名（优先）
      const queryName = req.query.filename as string | undefined;
      if (queryName) {
        filename = queryName;
      }

      const result = await applyUpdateFromFile(req.body, filename);
      res.json(result);
    } catch (err) {
      res.status(500).json({
        success: false,
        message: reportUpdateError('upload', err, '上传更新失败'),
      });
    }
  },
);

export default router;
