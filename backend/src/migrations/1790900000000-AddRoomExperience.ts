import { TableColumn, type MigrationInterface, type QueryRunner } from 'typeorm';

export class AddRoomExperience1790900000000 implements MigrationInterface {
  name = 'AddRoomExperience1790900000000';
  async up(runner: QueryRunner): Promise<void> {
    if (!(await runner.hasColumn('room', 'activity'))) {
      await runner.addColumn('room', new TableColumn({ name: 'activity', type: 'varchar', default: "'watch'" }));
      await runner.query(`UPDATE "room" SET "activity" = CASE WHEN "mode" = 'screen-share' THEN 'screen' ELSE 'watch' END`);
    }
    if (!(await runner.hasColumn('room', 'policyJson'))) {
      await runner.addColumn('room', new TableColumn({ name: 'policyJson', type: 'text', default: "'{}'" }));
    }
    if (!(await runner.hasColumn('room', 'emptySince'))) {
      await runner.addColumn('room', new TableColumn({ name: 'emptySince', type: 'datetime', isNullable: true }));
      // A migration cannot carry a live socket across a process restart.
      await runner.query(`UPDATE "room" SET "emptySince" = CURRENT_TIMESTAMP WHERE "status" = 'active'`);
    }
    if (!(await runner.hasColumn('music_room_states', 'positionSec'))) {
      await runner.addColumn('music_room_states', new TableColumn({ name: 'positionSec', type: 'float', default: 0 }));
    }
  }
  async down(): Promise<void> {
    throw new Error('Restore the pre-upgrade backup to preserve room rules and positions.');
  }
}
