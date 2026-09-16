import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export type NcmCredentialStatus = 'logged-in' | 'invalid';

/**
 * Server-private NCM credential metadata.
 *
 * The actual cookie header is stored only inside credentialEnvelope, encrypted
 * with SecretVault. No raw provider credential is represented by an entity
 * column or a public DTO.
 */
@Entity('ncm_credentials')
export class NcmCredential {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'integer', unique: true })
  userId!: number;

  @Column({ type: 'varchar', default: 'ncm' })
  provider!: 'ncm';

  @Column({ type: 'text' })
  credentialEnvelope!: string;

  /** Monotonic binding used to invalidate old QR sessions and media handles. */
  @Column({ type: 'integer', default: 1 })
  credentialVersion!: number;

  @Column({
    type: 'simple-enum',
    enum: ['logged-in', 'invalid'],
    default: 'logged-in',
  })
  status!: NcmCredentialStatus;

  @Column({ type: 'varchar', nullable: true })
  accountId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  displayName!: string | null;

  @Column({ type: 'varchar', nullable: true })
  avatarUrl!: string | null;

  @Column({ type: 'datetime', nullable: true })
  lastValidatedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
