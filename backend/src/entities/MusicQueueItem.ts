import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Room } from './Room';

/**
 * Persistent, provider-neutral item in a room's music queue.
 *
 * The generated queueItemId is the stable identity.  It must not be derived
 * from songId, title, or array position because the same track may be queued
 * more than once.
 */
@Entity('music_queue_items')
export class MusicQueueItem {
  @PrimaryGeneratedColumn()
  queueItemId!: number;

  @Column({ type: 'varchar', length: 128 })
  roomId!: string;

  /** Opaque provider reference, never a raw stream URL or credential. */
  @Column({ type: 'varchar', length: 512 })
  sourceRef!: string;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'varchar', length: 200, default: '' })
  artist!: string;

  @Column({ type: 'varchar', length: 200, default: '' })
  album!: string;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  artworkUrl!: string | null;

  @Column({ type: 'integer', default: 0 })
  durationMs!: number;

  /** Server-normalized zero-based order. */
  @Column({ type: 'integer' })
  orderIndex!: number;

  @Column({ type: 'integer', nullable: true })
  createdByUserId!: number | null;

  /** Bounded provider-neutral metadata; secrets are rejected before storage. */
  @Column({ type: 'text', default: '{}' })
  metadataJson!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @ManyToOne(() => Room, (room) => room.musicQueueItems, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'roomId', referencedColumnName: 'roomId' })
  room!: Room;
}
