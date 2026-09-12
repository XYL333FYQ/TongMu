import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/** Transitional migration: preserves resolver input and diagnostics without replacing synchronize yet. */
export class AddMediaCoreMetadata1789160000000 implements MigrationInterface {
  name = 'AddMediaCoreMetadata1789160000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('movie'))) return;
    if (!(await queryRunner.hasColumn('movie', 'sourceInput'))) {
      await queryRunner.addColumn('movie', new TableColumn({ name: 'sourceInput', type: 'varchar', isNullable: true }));
    }
    if (!(await queryRunner.hasColumn('movie', 'mediaDescriptor'))) {
      await queryRunner.addColumn('movie', new TableColumn({ name: 'mediaDescriptor', type: 'text', isNullable: true }));
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('movie'))) return;
    if (await queryRunner.hasColumn('movie', 'mediaDescriptor')) await queryRunner.dropColumn('movie', 'mediaDescriptor');
    if (await queryRunner.hasColumn('movie', 'sourceInput')) await queryRunner.dropColumn('movie', 'sourceInput');
  }
}
