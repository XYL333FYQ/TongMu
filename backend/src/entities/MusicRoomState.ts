import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { Room } from './Room';

export type MusicPlayMode = 'sequential' | 'repeat-one' | 'repeat-all' | 'shuffle';

/** Durable music selection/mode settings. Position and playing are ephemeral. */
@Entity('music_room_states')
export class MusicRoomState {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  roomId!: string;

  @Column({
    type: 'simple-enum',
    enum: ['sequential', 'repeat-one', 'repeat-all', 'shuffle'],
    default: 'sequential',
  })
  playMode!: MusicPlayMode;

  @Column({ type: 'integer', nullable: true })
  currentQueueItemId!: number | null;

  /** Persisted shuffle plan; it is regenerated only when the queue/mode needs it. */
  @Column({ type: 'varchar', length: 128, default: '' })
  shuffleSeed!: string;

  @Column({ type: 'text', default: '[]' })
  shuffleOrderJson!: string;

  @Column({ type: 'text', default: '[]' })
  shuffleHistoryJson!: string;

  @Column({ type: 'integer', default: 0 })
  shuffleCursor!: number;

  /** Persisted ordering metadata keeps reconnects safe across process restarts. */
  @Column({ type: 'integer', default: 0 })
  version!: number;

  @Column({ type: 'integer', default: 0 })
  musicGeneration!: number;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToOne(() => Room, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'roomId', referencedColumnName: 'roomId' })
  room!: Room;
}
