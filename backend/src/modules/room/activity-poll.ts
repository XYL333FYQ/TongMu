import { randomUUID } from 'node:crypto';
import type { RoomActivity } from './room-policy';

export class ActivityPoll {
  readonly id = randomUUID();
  readonly votes = new Map<string, boolean>();
  readonly expiresAt: number;
  constructor(readonly activity: RoomActivity, readonly requestedBy: string, readonly username: string, now = Date.now()) {
    this.expiresAt = now + 60_000;
  }
  vote(identity: string, value: boolean, now = Date.now()): void {
    if (now >= this.expiresAt) throw new Error('投票已结束');
    this.votes.set(identity, value);
  }
  snapshot(now = Date.now()) {
    return { id: this.id, activity: this.activity, requestedBy: this.requestedBy,
      username: this.username, expiresAt: this.expiresAt, ended: now >= this.expiresAt,
      yes: [...this.votes.values()].filter(Boolean).length,
      no: [...this.votes.values()].filter(value => !value).length };
  }
}

export interface DelegateCandidate { socketId: string; permissionScore: number; }
/** Platform account roles deliberately do not influence temporary hosting. */
export function selectDelegate(candidates: DelegateCandidate[], random = Math.random): string | null {
  if (!candidates.length) return null;
  const rank = (candidate: DelegateCandidate) => candidate.permissionScore;
  const highest = Math.max(...candidates.map(rank));
  const eligible = candidates.filter(candidate => rank(candidate) === highest);
  return eligible[Math.min(eligible.length - 1, Math.floor(random() * eligible.length))].socketId;
}
