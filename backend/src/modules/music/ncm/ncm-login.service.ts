import { randomUUID } from 'node:crypto';
import { ncmCredentialService, NcmCredentialService } from './ncm-credential.service';
import { ncmApiClient } from './ncm-client';
import {
  NcmProviderError,
  type NcmClient,
  type NcmQrSessionDto,
  type NcmQrStatus,
  type NcmProfileFacts,
} from './types';

const DEFAULT_QR_SESSION_TTL_MS = 3 * 60 * 1000;
const MAX_QR_SESSIONS = 1024;

interface QrSession {
  sessionId: string;
  userId: number;
  qrKey: string;
  qrUrl: string;
  qrImageDataUrl: string;
  status: NcmQrStatus;
  expiresAt: number;
  generation: number;
  profile?: NcmProfileFacts;
}

function qrTtlMs(): number {
  const value = Number(process.env.NCM_QR_SESSION_TTL_MS);
  return Number.isSafeInteger(value) && value >= 30_000 && value <= 15 * 60 * 1000
    ? value
    : DEFAULT_QR_SESSION_TTL_MS;
}

function publicSession(session: QrSession): NcmQrSessionDto {
  const includeQr = session.status === 'qr-created' || session.status === 'waiting' || session.status === 'scanned';
  return {
    sessionId: session.sessionId,
    status: session.status,
    ...(includeQr ? { qrUrl: session.qrUrl, qrImageDataUrl: session.qrImageDataUrl } : {}),
    expiresAt: session.expiresAt,
    loggedIn: session.status === 'logged-in',
    ...(session.profile ? {
      accountId: session.profile.accountId,
      displayName: session.profile.displayName,
      avatarUrl: session.profile.avatarUrl,
    } : {}),
  };
}

/** User-bound, bounded QR login state machine. Raw cookies never enter QrSession. */
export class NcmLoginService {
  private readonly sessions = new Map<string, QrSession>();
  private readonly activeByUser = new Map<number, string>();
  private readonly locks = new Map<number, Promise<unknown>>();

  constructor(
    private readonly client: NcmClient = ncmApiClient,
    private readonly credentials: NcmCredentialService = ncmCredentialService,
  ) {}

  private async withUserLock<T>(userId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(userId, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(userId) === current) this.locks.delete(userId);
    }
  }

  private cleanup(now = Date.now()): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now &&
          session.status !== 'logged-in' && session.status !== 'failed' && session.status !== 'expired') {
        session.status = 'expired';
        if (this.activeByUser.get(session.userId) === id) this.activeByUser.delete(session.userId);
      }
    }
    if (this.sessions.size <= MAX_QR_SESSIONS) return;
    const candidates = [...this.sessions.values()]
      .sort((left, right) => left.expiresAt - right.expiresAt);
    for (const session of candidates) {
      if (this.sessions.size <= MAX_QR_SESSIONS) break;
      this.sessions.delete(session.sessionId);
      if (this.activeByUser.get(session.userId) === session.sessionId) this.activeByUser.delete(session.userId);
    }
  }

  async createQr(userId: number): Promise<NcmQrSessionDto> {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new NcmProviderError('MUSIC_ROOM_FORBIDDEN', '游客不能保存网易云登录凭据', 403);
    }
    return this.withUserLock(userId, async () => {
      this.cleanup();
      const previousId = this.activeByUser.get(userId);
      if (previousId) {
        const previous = this.sessions.get(previousId);
        if (previous) previous.status = 'failed';
        this.activeByUser.delete(userId);
      }
      const created = await this.client.createQr();
      const session: QrSession = {
        sessionId: randomUUID(),
        userId,
        qrKey: created.qrKey,
        qrUrl: created.qrUrl,
        qrImageDataUrl: created.qrImageDataUrl,
        status: 'qr-created',
        expiresAt: Math.min(created.expiresAt, Date.now() + qrTtlMs()),
        generation: await this.credentials.getCurrentGeneration(userId),
      };
      this.sessions.set(session.sessionId, session);
      this.activeByUser.set(userId, session.sessionId);
      this.cleanup();
      return publicSession(session);
    });
  }

  async pollQr(userId: number, sessionId: string): Promise<NcmQrSessionDto> {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new NcmProviderError('MUSIC_ROOM_FORBIDDEN', '游客不能轮询网易云登录', 403);
    }
    return this.withUserLock(userId, async () => {
      this.cleanup();
      const session = this.sessions.get(sessionId);
      if (!session || session.userId !== userId) {
        throw new NcmProviderError('NCM_QR_SESSION_NOT_FOUND', '二维码会话不存在', 404);
      }
      if (session.status === 'logged-in' || session.status === 'failed') return publicSession(session);
      if (session.expiresAt <= Date.now()) {
        session.status = 'expired';
        if (this.activeByUser.get(userId) === sessionId) this.activeByUser.delete(userId);
        return publicSession(session);
      }

      const result = await this.client.checkQr(session.qrKey);
      if (result.status === 'waiting') session.status = 'waiting';
      else if (result.status === 'scanned') session.status = 'scanned';
      else if (result.status === 'expired') {
        session.status = 'expired';
        if (this.activeByUser.get(userId) === sessionId) this.activeByUser.delete(userId);
      } else {
        session.status = 'authorized';
        session.profile = result.profile;
        if (!result.cookieHeader) {
          session.status = 'failed';
          throw new NcmProviderError('NCM_CREDENTIAL_INVALID', '网易云登录未返回有效凭据', 502);
        }
        try {
          await this.credentials.saveCredentialIfCurrent(
            userId,
            session.generation,
            { cookieHeader: result.cookieHeader },
            result.profile,
          );
          session.status = 'logged-in';
        } catch {
          session.status = 'failed';
          throw new NcmProviderError('NCM_QR_SESSION_REPLACED', '二维码登录已被新的凭据操作替换', 409);
        }
      }
      return publicSession(session);
    });
  }

  invalidateUser(userId: number): void {
    const sessionId = this.activeByUser.get(userId);
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (session) session.status = 'failed';
    this.activeByUser.delete(userId);
  }

  async logout(userId: number): Promise<void> {
    if (!Number.isSafeInteger(userId) || userId <= 0) return;
    await this.withUserLock(userId, async () => {
      this.invalidateUser(userId);
      const credential = await this.credentials.getPrivateCredential(userId);
      try {
        if (credential) await this.client.logout(credential);
      } catch {
        // Local revocation is authoritative even when the upstream logout call
        // is unavailable; the encrypted credential is still removed below.
      } finally {
        await this.credentials.clearCredential(userId);
      }
    });
  }
}

export const ncmLoginService = new NcmLoginService();
