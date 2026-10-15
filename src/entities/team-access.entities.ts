import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import { TABLES } from '../constants/db';
import { COLUMN_ACCESS, ColumnAccess, PO_TEAM, PoTeam, USER_TEAM, UserTeam } from '../constants/po-overview-columns';
import { User } from './auth.entities';
import { MasterFacility } from './master-facility.entity';

/**
 * team_column_access: what a team may do with a column group of the PO Overview (none / view / edit), one row per
 * team + group. Seeded by the migration with DEFAULT_TEAM_ACCESS; changed later from the Admin page, never in code.
 */
@Entity({ name: TABLES.TEAM_COLUMN_ACCESS })
@Index('uq_team_column_access', ['team', 'columnGroup'], { unique: true })
export class TeamColumnAccess {
  @PrimaryGeneratedColumn({ name: 'id', type: 'int' })
  id: number;

  @Column({ name: 'team', type: 'enum', enum: Object.values(USER_TEAM) })
  team: UserTeam;

  /** The team that owns the columns (constants/po-overview-columns.ts PO_TEAM_COLUMNS). */
  @Column({ name: 'column_group', type: 'enum', enum: Object.values(PO_TEAM) })
  columnGroup: PoTeam;

  @Column({ name: 'access', type: 'enum', enum: Object.values(COLUMN_ACCESS), default: COLUMN_ACCESS.NONE })
  access: ColumnAccess;

  @Column({ name: 'updated_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' })
  updatedAt: Date;
}

/**
 * user_facilities: the facilities a person works for (warehouse / logistics: their shipments open filtered to these and
 * only these can be edited; option c, user 2026-10-14). By the facility link, so a code's case is exact.
 */
@Entity({ name: TABLES.USER_FACILITIES })
export class UserFacility {
  @PrimaryColumn({ name: 'user_id', type: 'int' })
  userId: number;

  @PrimaryColumn({ name: 'facility_id', type: 'int' })
  facilityId: number;

  @Column({ name: 'created_at', type: 'datetime', precision: 6, default: () => 'CURRENT_TIMESTAMP(6)' })
  createdAt: Date;

  /** fk_user_facilities_user: rows go when the user is deleted (users are switched off, not deleted, in practice). */
  @ManyToOne(() => User, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_user_facilities_user' })
  user: User;

  /** fk_user_facilities_facility: a facility given to someone cannot be deleted. */
  @ManyToOne(() => MasterFacility, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'facility_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_user_facilities_facility' })
  facility: MasterFacility;
}
