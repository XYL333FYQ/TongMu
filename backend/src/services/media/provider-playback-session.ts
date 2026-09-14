import type { MediaServerSessionBinding } from './providers/media-server-types';
import type { MediaProvider, ProviderContext, ProviderPlaybackSessionLifecycle } from './providers/types';

interface SessionEntry {
  key: string;
  groupKey: string;
  provider: ProviderPlaybackSessionLifecycle;
  session: MediaServerSessionBinding;
  started: boolean;
  stopped: boolean;
  cleaning: boolean;
}

function sessionKey(session: MediaServerSessionBinding): string {
  return [
    session.providerId,
    session.mountId,
    session.itemId,
    session.mediaSourceId,
    session.playSessionId,
    session.actorUserId ?? '',
    session.roomId ?? '',
    session.movieId ?? '',
    session.sourceGeneration ?? '',
  ].join('|');
}

function sessionGroupKey(session: {
  providerId: string;
  mountId: number;
  itemId?: string;
  mediaSourceId?: string;
  playSessionId?: string;
  actorUserId?: string;
  roomId?: string;
  movieId?: number;
}): string {
  return [
    session.providerId,
    session.actorUserId ?? '',
    session.roomId ?? '',
    session.movieId ?? '',
  ].join('|');
}

function boundedContext(context: ProviderContext, allowCallerAbort: boolean): {
  context: ProviderContext;
  cleanup: () => void;
  timeoutMs: number;
} {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(context.deadline - Date.now(), 5_000));
  const abort = () => controller.abort();
  if (allowCallerAbort) {
    if (context.signal.aborted) controller.abort();
    else context.signal.addEventListener('abort', abort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    context: {
      ...context,
      signal: controller.signal,
      deadline: Date.now() + timeoutMs,
    },
    timeoutMs,
    cleanup: () => {
      clearTimeout(timer);
      if (allowCallerAbort) context.signal.removeEventListener('abort', abort);
    },
  };
}

async function runBounded<T>(
  context: ProviderContext,
  operation: (bounded: ProviderContext) => Promise<T>,
  allowCallerAbort: boolean,
): Promise<T> {
  const state = boundedContext(context, allowCallerAbort);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('provider session operation timed out')), state.timeoutMs);
    });
    return await Promise.race([operation(state.context), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    state.cleanup();
  }
}

function lifecycleFor(provider: MediaProvider): ProviderPlaybackSessionLifecycle {
  if (!provider.playbackSession) throw new Error('媒体 Provider 未提供播放会话生命周期');
  return provider.playbackSession;
}

/**
 * Coordinates server-side provider side effects without selecting a client
 * playback engine. It is intentionally in-memory: the sealed handle remains
 * the authority, while this map only makes duplicate cleanup and generation
 * replacement safe within one server process.
 */
export class ProviderPlaybackSessionCoordinator {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly cleaned = new Set<string>();
  private readonly latestByGroup = new Map<string, string>();

  async start(provider: MediaProvider, context: ProviderContext, session: MediaServerSessionBinding): Promise<void> {
    const lifecycle = lifecycleFor(provider);
    if (session.providerId !== provider.id) throw new Error('媒体会话 Provider 不匹配');
    const key = sessionKey(session);
    const groupKey = sessionGroupKey(session);
    const existing = this.entries.get(key);
    if (existing?.started) return;

    const previousKey = this.latestByGroup.get(groupKey);
    if (previousKey && previousKey !== key) {
      const previous = this.entries.get(previousKey);
      if (previous) void this.cleanupEntry(context, previous);
    }
    const entry: SessionEntry = existing ?? {
      key,
      groupKey,
      provider: lifecycle,
      session,
      started: false,
      stopped: false,
      cleaning: false,
    };
    this.entries.set(key, entry);
    this.latestByGroup.set(groupKey, key);
    try {
      await runBounded(context, (bounded) => lifecycle.start(bounded, session), true);
      entry.started = true;
    } catch (error) {
      void this.cleanupEntry(context, entry);
      throw error;
    }
  }

  async progress(provider: MediaProvider, context: ProviderContext, session: MediaServerSessionBinding, position: number, paused: boolean): Promise<void> {
    const entry = this.entries.get(sessionKey(session));
    if (!entry || entry.provider !== lifecycleFor(provider) || !entry.started) return;
    if (this.latestByGroup.get(entry.groupKey) !== entry.key) return;
    await runBounded(context, (bounded) => entry.provider.progress(bounded, session, position, paused), true);
  }

  async stop(provider: MediaProvider, context: ProviderContext, session: MediaServerSessionBinding, position: number): Promise<void> {
    const entry = this.entries.get(sessionKey(session));
    if (!entry || entry.provider !== lifecycleFor(provider) || entry.stopped) return;
    if (this.latestByGroup.get(entry.groupKey) !== entry.key) return;
    entry.stopped = true;
    await runBounded(context, (bounded) => entry.provider.stop(bounded, session, position), true);
  }

  async cleanup(provider: MediaProvider, context: ProviderContext, session: MediaServerSessionBinding): Promise<void> {
    if (session.providerId !== provider.id) return;
    const key = sessionKey(session);
    if (this.cleaned.has(key)) return;
    const entry = this.entries.get(key) ?? {
      key,
      groupKey: sessionGroupKey(session),
      provider: lifecycleFor(provider),
      session,
      started: false,
      stopped: false,
      cleaning: false,
    };
    await this.cleanupEntry(context, entry);
  }

  async invalidateGroup(provider: MediaProvider, context: ProviderContext, group: Pick<MediaServerSessionBinding, 'mountId' | 'actorUserId' | 'roomId' | 'movieId'>): Promise<void> {
    const groupKey = sessionGroupKey({ providerId: provider.id, itemId: '', mediaSourceId: '', playSessionId: '', ...group });
    await Promise.all([...this.entries.values()]
      .filter((entry) => entry.groupKey === groupKey)
      .map((entry) => this.cleanupEntry(context, entry)));
  }

  private async cleanupEntry(context: ProviderContext, entry: SessionEntry): Promise<void> {
    if (entry.cleaning || this.cleaned.has(entry.key)) return;
    entry.cleaning = true;
    this.cleaned.add(entry.key);
    try {
      // Cleanup must still run after an aborted playback request. Its own
      // short deadline prevents provider failure from blocking the next item.
      await runBounded(context, (bounded) => entry.provider.cleanup(bounded, entry.session), false);
    } catch {
      // Cleanup is best effort and idempotent. The original playback or the
      // next source must never fail because a provider cleanup endpoint failed.
    } finally {
      this.entries.delete(entry.key);
      if (this.latestByGroup.get(entry.groupKey) === entry.key) this.latestByGroup.delete(entry.groupKey);
    }
  }
}

export const providerPlaybackSessionCoordinator = new ProviderPlaybackSessionCoordinator();
