import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { Room } from './Room';

/** Private durable receipt. Keep movieId after deletion to reject delayed retries. */
@Entity('movie_create_request')
@Unique('UQ_movie_create_request', ['roomId', 'actorId', 'keyHash'])
export class MovieCreateRequest {
  @PrimaryGeneratedColumn() id!: number;
  @Column() roomId!: string;
  @Column({ type: 'integer' }) actorId!: number;
  @Column() keyHash!: string;
  @Column({ type: 'text' }) fingerprintEnvelope!: string;
  @Column({ type: 'integer' }) movieId!: number;
  @ManyToOne(() => Room, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'roomId', referencedColumnName: 'roomId', foreignKeyConstraintName: 'FK_movie_create_request_room' })
  room!: Room;
}
