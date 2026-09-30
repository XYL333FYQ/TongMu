import crypto from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { secretVault, type SecretVault } from '../../services/secret-vault';

export class MovieCreateRequestError extends Error {
  constructor(readonly status: 400 | 409, message: string) { super(message); }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]),
  );
  return value;
}

// sql.js has one connection. Serialize concurrent movie transactions, including
// retries using different service instances; uniqueness also survives restart.
const queues = new WeakMap<DataSource, Promise<unknown>>();
export class MovieCreateIdempotency {
  constructor(private readonly db: DataSource, private readonly vault: SecretVault = secretVault) {}

  execute<T extends { id: number }>(
    roomId: string, actorId: number, key: string, payload: unknown,
    create: (manager: EntityManager) => Promise<T>,
    replay: (manager: EntityManager, movieId: number) => Promise<T | undefined | null>,
  ): Promise<T> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) return Promise.reject(
      new MovieCreateRequestError(400, '添加请求编号无效，请重新发起添加'),
    );
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
    const previous = queues.get(this.db) || Promise.resolve();
    const pending = previous.catch(() => undefined).then(() => this.db.transaction(async manager => {
      const [receipt] = await manager.query(
        'SELECT "fingerprintEnvelope", "movieId" FROM "movie_create_request" WHERE "roomId"=? AND "actorId"=? AND "keyHash"=?',
        [roomId, actorId, keyHash],
      );
      if (receipt) {
        if (this.vault.decrypt(receipt.fingerprintEnvelope) !== fingerprint) throw new MovieCreateRequestError(
          409, '该添加请求已用于不同内容，请重新发起添加',
        );
        const movie = await replay(manager, receipt.movieId);
        if (!movie) throw new MovieCreateRequestError(409, '该请求添加的影片已被删除，请重新发起添加');
        return movie;
      }
      const movie = await create(manager);
      await manager.query(
        'INSERT INTO "movie_create_request" ("roomId", "actorId", "keyHash", "fingerprintEnvelope", "movieId") VALUES (?, ?, ?, ?, ?)',
        [roomId, actorId, keyHash, this.vault.encrypt(fingerprint), movie.id],
      );
      return movie;
    }));
    queues.set(this.db, pending);
    void pending.finally(() => { if (queues.get(this.db) === pending) queues.delete(this.db); }).catch(() => undefined);
    return pending;
  }
}
