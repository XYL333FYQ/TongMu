/**
 * Voice 生命周期与服务器中转边界。
 *
 * Voice identity 与 socket transport 明确分离：登录用户使用 user:{id}，
 * 游客使用 socket:{socketId}；socketId 只负责当前连接的音频路由。
 * 同一 identity 的新连接会替换旧连接，并带 generation 防止旧事件污染新连接。
 */
import type { Server as SocketIOServer, Socket } from "socket.io";
import type { UserRole } from "../../entities/User";
import type { SocketEventHandler } from "../socket";
import { roomPermissionService } from "../room/room-permission.service";
import { AppDataSource } from "../../data-source";
import { Room } from "../../entities/Room";

export const VOICE_SAMPLE_RATE = 48_000;
export const VOICE_CHANNELS = 1;
export const VOICE_FRAME_SAMPLES = 960;
export const VOICE_FRAME_DURATION_US = 20_000;
export const VOICE_MAX_PACKET_BYTES = 64 * 1024;
export const VOICE_MAX_CODEC_DESCRIPTION_BYTES = 4 * 1024;

const GHOST_SWEEP_INTERVAL_MS = 15_000;
const VOICE_KICK_COOLDOWN_MS = 60_000;
const MAX_AUDIO_PACKETS_PER_SECOND = 80;
const MAX_CODEC_CONFIGS_PER_SECOND = 4;
const MAX_ROOM_ID_LENGTH = 128;
const MAX_SOCKET_ID_LENGTH = 256;

export interface VoiceMemberInfo {
  identity: string;
  socketId: string;
  userId: number | null;
  username: string;
  role: UserRole;
  generation: number;
  muted: boolean;
}

interface VoiceMemberEntry {
  identity: string;
  socketId: string;
  userId: number | null;
  username: string;
  role: UserRole;
  generation: number;
  joinedAt: number;
}

interface SocketIndexEntry {
  roomId: string;
  identity: string;
  generation: number;
}

interface PacketRateState {
  startedAt: number;
  count: number;
}

const voiceMembers = new Map<string, Map<string, VoiceMemberEntry>>();
const socketIndex = new Map<string, SocketIndexEntry>();
const identityGenerations = new Map<string, number>();
const voiceMutedKeys = new Map<string, Set<string>>();
const voiceMutedLoaded = new Set<string>();
const voiceKickCooldown = new Map<string, number>();
const packetRates = new Map<string, PacketRateState>();
const joinLocks = new Map<string, Promise<void>>();

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function isRoomId(value: unknown): value is string {
  return isNonEmptyString(value, MAX_ROOM_ID_LENGTH);
}

function isSocketId(value: unknown): value is string {
  return isNonEmptyString(value, MAX_SOCKET_ID_LENGTH);
}

function isSocketInRoom(socket: Socket, roomId: string): boolean {
  return socket.rooms.has(roomId);
}

function getUserId(socket: Socket): number | null {
  const userId = socket.data?.userId;
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function getRole(socket: Socket): UserRole {
  const role = socket.data?.role;
  return role === "root" ||
    role === "admin" ||
    role === "user" ||
    role === "guest"
    ? role
    : "guest";
}

function getIdentity(socket: Socket): string {
  const userId = getUserId(socket);
  return userId === null ? `socket:${socket.id}` : `user:${userId}`;
}

function getDisplayName(socket: Socket, requestedName: unknown): string {
  const userId = getUserId(socket);
  const authenticatedName = socket.data?.username;
  if (userId !== null && isNonEmptyString(authenticatedName, 128)) {
    return authenticatedName.trim().slice(0, 128);
  }
  if (isNonEmptyString(requestedName, 128))
    return requestedName.trim().slice(0, 128) || "游客";
  return "游客";
}

function scopedIdentity(roomId: string, identity: string): string {
  return `${roomId}\u0000${identity}`;
}

function asArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer;
  }
  return null;
}

function isBoundedRate(socketId: string, limit: number): boolean {
  const now = Date.now();
  const current = packetRates.get(socketId);
  if (!current || now - current.startedAt >= 1000) {
    packetRates.set(socketId, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function toInfo(entry: VoiceMemberEntry, muted: boolean): VoiceMemberInfo {
  return {
    identity: entry.identity,
    socketId: entry.socketId,
    userId: entry.userId,
    username: entry.username,
    role: entry.role,
    generation: entry.generation,
    muted,
  };
}

async function loadVoiceMuted(roomId: string): Promise<void> {
  if (voiceMutedLoaded.has(roomId)) return;
  voiceMutedLoaded.add(roomId);
  try {
    const room = await AppDataSource.getRepository(Room).findOneBy({ roomId });
    const parsed = JSON.parse(room?.voiceMuted || "[]");
    const set = voiceMutedKeys.get(roomId) ?? new Set<string>();
    if (Array.isArray(parsed)) {
      for (const userId of parsed) {
        if (Number.isInteger(userId) && userId > 0) set.add(`user:${userId}`);
      }
    }
    voiceMutedKeys.set(roomId, set);
  } catch {
    // A read failure must not crash voice. The in-memory set remains bounded.
    voiceMutedKeys.set(roomId, voiceMutedKeys.get(roomId) ?? new Set<string>());
  }
}

async function persistVoiceMuted(roomId: string): Promise<boolean> {
  const set = voiceMutedKeys.get(roomId) ?? new Set<string>();
  try {
    const repo = AppDataSource.getRepository(Room);
    const room = await repo.findOneBy({ roomId });
    if (!room) return false;
    const userIds = [...set]
      .filter((key) => key.startsWith("user:"))
      .map((key) => Number(key.slice(5)))
      .filter((id) => Number.isInteger(id) && id > 0);
    room.voiceMuted = JSON.stringify(userIds);
    await repo.save(room);
    return true;
  } catch (error) {
    console.error("[voice] persist voiceMuted error:", error);
    return false;
  }
}

function removeMember(
  io: SocketIOServer,
  roomId: string,
  identity: string,
): VoiceMemberEntry | null {
  const members = voiceMembers.get(roomId);
  const entry = members?.get(identity);
  if (!entry) return null;

  members?.delete(identity);
  const indexed = socketIndex.get(entry.socketId);
  if (
    indexed?.roomId === roomId &&
    indexed.identity === identity &&
    indexed.generation === entry.generation
  ) {
    socketIndex.delete(entry.socketId);
  }
  const muted = voiceMutedKeys.get(roomId)?.has(identity) ?? false;
  if (members?.size === 0) {
    voiceMembers.delete(roomId);
    voiceMutedKeys.delete(roomId);
    voiceMutedLoaded.delete(roomId);
  }
  io.to(roomId).emit("voice-user-left", toInfo(entry, muted));
  return entry;
}

function removeBySocketId(
  io: SocketIOServer,
  socket: Socket,
  roomId?: string,
): void {
  const indexed = socketIndex.get(socket.id);
  if (!indexed) return;
  if (roomId && indexed.roomId !== roomId) return;
  const current = voiceMembers.get(indexed.roomId)?.get(indexed.identity);
  if (
    current?.socketId !== socket.id ||
    current.generation !== indexed.generation
  ) {
    return;
  }
  removeMember(io, indexed.roomId, indexed.identity);
  socketIndex.delete(socket.id);
  packetRates.delete(socket.id);
  packetRates.delete(`${socket.id}:codec`);
}

function sweepGhosts(io: SocketIOServer): void {
  let inspected = 0;
  const now = Date.now();
  for (const [roomId, members] of voiceMembers) {
    for (const [identity, entry] of members) {
      if (inspected >= 1000) break;
      inspected += 1;
      if (!io.sockets.sockets.has(entry.socketId))
        removeMember(io, roomId, identity);
    }
  }
  for (const [key, until] of voiceKickCooldown) {
    if (now >= until) voiceKickCooldown.delete(key);
  }
}

async function withJoinLock(
  key: string,
  action: () => Promise<void>,
): Promise<void> {
  const previous = joinLocks.get(key) ?? Promise.resolve();
  const current = previous.then(action, action);
  joinLocks.set(key, current);
  try {
    await current;
  } finally {
    if (joinLocks.get(key) === current) joinLocks.delete(key);
  }
}

export class VoiceChatHandler implements SocketEventHandler {
  readonly name = "voice-chat";
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  register(socket: Socket, io: SocketIOServer): void {
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(
        () => sweepGhosts(io),
        GHOST_SWEEP_INTERVAL_MS,
      );
      this.sweepTimer.unref?.();
    }

    socket.on(
      "voice-join",
      (payload: unknown, callback?: (response: unknown) => void) => {
        const value = payload as { roomId?: unknown; username?: unknown };
        const roomId = isRoomId(value?.roomId) ? value.roomId : null;
        if (!roomId || !isSocketInRoom(socket, roomId)) {
          callback?.({ success: false, message: "不在该房间中" });
          return;
        }
        const identity = getIdentity(socket);
        void withJoinLock(scopedIdentity(roomId, identity), async () => {
          await loadVoiceMuted(roomId);
          const muted = voiceMutedKeys.get(roomId) ?? new Set<string>();
          const cooldown = voiceKickCooldown.get(
            scopedIdentity(roomId, identity),
          );
          if (cooldown && cooldown > Date.now()) {
            callback?.({
              success: false,
              message: `您已被移出语音，${Math.ceil((cooldown - Date.now()) / 1000)} 秒后可重新加入`,
            });
            return;
          }

          let members = voiceMembers.get(roomId);
          if (!members) {
            members = new Map();
            voiceMembers.set(roomId, members);
          }
          const existing = members.get(identity);
          if (existing?.socketId === socket.id) {
            callback?.({
              success: true,
              members: [...members.values()]
                .filter((member) => member.socketId !== socket.id)
                .map((member) => toInfo(member, muted.has(member.identity))),
              selfMuted: muted.has(identity),
            });
            return;
          }
          if (existing) {
            removeMember(io, roomId, identity);
            members =
              voiceMembers.get(roomId) ?? new Map<string, VoiceMemberEntry>();
            voiceMembers.set(roomId, members);
          }

          const generationKey = scopedIdentity(roomId, identity);
          const generation = (identityGenerations.get(generationKey) ?? 0) + 1;
          identityGenerations.set(generationKey, generation);
          const entry: VoiceMemberEntry = {
            identity,
            socketId: socket.id,
            userId: getUserId(socket),
            username: getDisplayName(socket, value?.username),
            role: getRole(socket),
            generation,
            joinedAt: Date.now(),
          };
          members.set(identity, entry);
          socketIndex.set(socket.id, { roomId, identity, generation });
          socket
            .to(roomId)
            .emit("voice-user-joined", toInfo(entry, muted.has(identity)));
          callback?.({
            success: true,
            members: [...members.values()]
              .filter((member) => member.socketId !== socket.id)
              .map((member) => toInfo(member, muted.has(member.identity))),
            selfMuted: muted.has(identity),
          });
        }).catch(() => callback?.({ success: false, message: "加入语音失败" }));
      },
    );

    socket.on(
      "voice-leave",
      (payload: unknown, callback?: (response: unknown) => void) => {
        const roomId = (payload as { roomId?: unknown })?.roomId;
        if (isRoomId(roomId)) removeBySocketId(io, socket, roomId);
        callback?.({ success: true });
      },
    );

    socket.on("voice-audio-data", (payload: unknown) => {
      try {
        const value = payload as {
          roomId?: unknown;
          data?: unknown;
          sampleRate?: unknown;
          channels?: unknown;
          codec?: unknown;
          timestamp?: unknown;
          mediaTs?: unknown;
          encoded?: unknown;
          frameSamples?: unknown;
        };
        if (
          !isRoomId(value?.roomId) ||
          !isBoundedRate(socket.id, MAX_AUDIO_PACKETS_PER_SECOND)
        )
          return;
        const index = socketIndex.get(socket.id);
        const entry = voiceMembers
          .get(value.roomId)
          ?.get(index?.identity ?? "");
        const data = asArrayBuffer(value.data);
        if (
          !index ||
          index.roomId !== value.roomId ||
          !entry ||
          entry.socketId !== socket.id ||
          entry.generation !== index.generation ||
          !data ||
          data.byteLength === 0 ||
          data.byteLength > VOICE_MAX_PACKET_BYTES ||
          (value.encoded !== true && value.encoded !== false) ||
          (value.sampleRate !== undefined &&
            value.sampleRate !== VOICE_SAMPLE_RATE) ||
          (value.channels !== undefined && value.channels !== VOICE_CHANNELS) ||
          (value.codec !== undefined && value.codec !== "opus") ||
          (value.frameSamples !== undefined &&
            value.frameSamples !== VOICE_FRAME_SAMPLES) ||
          !Number.isFinite(value.timestamp)
        )
          return;
        if (voiceMutedKeys.get(value.roomId)?.has(index.identity)) return;
        if (
          value.encoded === true &&
          value.mediaTs !== undefined &&
          !Number.isFinite(value.mediaTs)
        )
          return;

        socket.to(value.roomId).emit("voice-audio-data", {
          from: socket.id,
          identity: entry.identity,
          generation: entry.generation,
          data,
          sampleRate: VOICE_SAMPLE_RATE,
          channels: VOICE_CHANNELS,
          codec: value.encoded ? "opus" : "pcm-s16",
          timestamp: value.timestamp,
          mediaTs: value.mediaTs,
          encoded: value.encoded,
          frameSamples: value.encoded ? VOICE_FRAME_SAMPLES : undefined,
        });
      } catch {
        // malformed voice input is an isolated drop, never a handler exception
      }
    });

    socket.on("voice-codec-config", (payload: unknown) => {
      try {
        const value = payload as {
          roomId?: unknown;
          codec?: unknown;
          sampleRate?: unknown;
          channels?: unknown;
          description?: unknown;
        };
        if (
          !isRoomId(value?.roomId) ||
          !isBoundedRate(`${socket.id}:codec`, MAX_CODEC_CONFIGS_PER_SECOND)
        )
          return;
        const index = socketIndex.get(socket.id);
        const entry = voiceMembers
          .get(value.roomId)
          ?.get(index?.identity ?? "");
        const description = asArrayBuffer(value.description);
        if (
          !index ||
          index.roomId !== value.roomId ||
          !entry ||
          entry.socketId !== socket.id ||
          entry.generation !== index.generation ||
          value.codec !== "opus" ||
          value.sampleRate !== VOICE_SAMPLE_RATE ||
          value.channels !== VOICE_CHANNELS ||
          !description ||
          description.byteLength > VOICE_MAX_CODEC_DESCRIPTION_BYTES ||
          description.byteLength === 0 ||
          voiceMutedKeys.get(value.roomId)?.has(index.identity)
        )
          return;
        socket.to(value.roomId).emit("voice-codec-config", {
          from: socket.id,
          identity: entry.identity,
          generation: entry.generation,
          codec: "opus",
          sampleRate: VOICE_SAMPLE_RATE,
          channels: VOICE_CHANNELS,
          description,
        });
      } catch {
        // malformed config is an isolated drop
      }
    });

    socket.on(
      "voice-mute",
      (payload: unknown, callback?: (response: unknown) => void) => {
        void this.moderateVoiceMember(socket, io, payload, true, callback);
      },
    );
    socket.on(
      "voice-unmute",
      (payload: unknown, callback?: (response: unknown) => void) => {
        void this.moderateVoiceMember(socket, io, payload, false, callback);
      },
    );
    socket.on(
      "voice-kick",
      (payload: unknown, callback?: (response: unknown) => void) => {
        void this.kickVoiceMember(socket, io, payload, callback);
      },
    );

    socket.on("disconnect", () => {
      removeBySocketId(io, socket);
      packetRates.delete(socket.id);
      packetRates.delete(`${socket.id}:codec`);
    });
  }

  private async moderateVoiceMember(
    actor: Socket,
    io: SocketIOServer,
    payload: unknown,
    muted: boolean,
    callback?: (response: unknown) => void,
  ): Promise<void> {
    try {
      const value = payload as { roomId?: unknown; socketId?: unknown };
      if (
        !isRoomId(value?.roomId) ||
        !isSocketId(value?.socketId) ||
        value.socketId === actor.id
      ) {
        callback?.({ success: false, message: "目标无效" });
        return;
      }
      if (
        !(await roomPermissionService.isRoomHostOrModerator(
          actor,
          value.roomId,
        ))
      ) {
        callback?.({ success: false, message: "无权限：仅房主或房管可操作" });
        return;
      }
      const targetIndex = socketIndex.get(value.socketId);
      const target =
        targetIndex && targetIndex.roomId === value.roomId
          ? voiceMembers.get(value.roomId)?.get(targetIndex.identity)
          : undefined;
      if (
        !target ||
        target.socketId !== value.socketId ||
        target.generation !== targetIndex?.generation
      ) {
        callback?.({ success: false, message: "目标不在语音中" });
        return;
      }
      if (!(await roomPermissionService.isRoomHost(actor, value.roomId))) {
        const denial = await roomPermissionService.canModeratorActOn(
          value.roomId,
          target.userId ?? undefined,
          target.role,
        );
        if (denial) {
          callback?.({ success: false, message: denial });
          return;
        }
      }
      await loadVoiceMuted(value.roomId);
      const set = voiceMutedKeys.get(value.roomId) ?? new Set<string>();
      const wasMuted = set.has(target.identity);
      if (muted) set.add(target.identity);
      else set.delete(target.identity);
      voiceMutedKeys.set(value.roomId, set);
      if (target.userId !== null && !(await persistVoiceMuted(value.roomId))) {
        if (wasMuted) set.add(target.identity);
        else set.delete(target.identity);
        callback?.({ success: false, message: "语音禁言状态保存失败" });
        return;
      }
      io.to(value.roomId).emit("voice-muted-changed", {
        identity: target.identity,
        socketId: target.socketId,
        userId: target.userId,
        username: target.username,
        generation: target.generation,
        muted,
      });
      callback?.({ success: true });
    } catch {
      callback?.({ success: false, message: "操作失败" });
    }
  }

  private async kickVoiceMember(
    actor: Socket,
    io: SocketIOServer,
    payload: unknown,
    callback?: (response: unknown) => void,
  ): Promise<void> {
    try {
      const value = payload as { roomId?: unknown; socketId?: unknown };
      if (
        !isRoomId(value?.roomId) ||
        !isSocketId(value?.socketId) ||
        value.socketId === actor.id
      ) {
        callback?.({ success: false, message: "目标无效" });
        return;
      }
      if (
        !(await roomPermissionService.isRoomHostOrModerator(
          actor,
          value.roomId,
        ))
      ) {
        callback?.({ success: false, message: "无权限：仅房主或房管可操作" });
        return;
      }
      const targetIndex = socketIndex.get(value.socketId);
      const target =
        targetIndex && targetIndex.roomId === value.roomId
          ? voiceMembers.get(value.roomId)?.get(targetIndex.identity)
          : undefined;
      if (
        !target ||
        target.socketId !== value.socketId ||
        target.generation !== targetIndex?.generation
      ) {
        callback?.({ success: false, message: "目标不在语音中" });
        return;
      }
      if (!(await roomPermissionService.isRoomHost(actor, value.roomId))) {
        const denial = await roomPermissionService.canModeratorActOn(
          value.roomId,
          target.userId ?? undefined,
          target.role,
        );
        if (denial) {
          callback?.({ success: false, message: denial });
          return;
        }
      }
      io.to(target.socketId).emit("voice-kicked", {
        roomId: value.roomId,
        identity: target.identity,
        generation: target.generation,
      });
      removeMember(io, value.roomId, target.identity);
      voiceKickCooldown.set(
        scopedIdentity(value.roomId, target.identity),
        Date.now() + VOICE_KICK_COOLDOWN_MS,
      );
      callback?.({ success: true });
    } catch {
      callback?.({ success: false, message: "操作失败" });
    }
  }

  /** Test-only lifecycle hook; production timer is intentionally single-node. */
  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}

export function __resetVoiceStateForTests(): void {
  voiceMembers.clear();
  socketIndex.clear();
  identityGenerations.clear();
  voiceMutedKeys.clear();
  voiceMutedLoaded.clear();
  voiceKickCooldown.clear();
  packetRates.clear();
  joinLocks.clear();
}

export function __sweepVoiceGhostsForTests(io: SocketIOServer): void {
  sweepGhosts(io);
}
