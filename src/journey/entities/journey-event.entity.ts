import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One anonymous journey step. Deliberately narrow: a random per-browser id,
 * the step name, the route PATTERN (never the real URL) and two timestamps.
 * No IP, user agent, wallet, handle or session column exists, and one must
 * not be added.
 */
@Entity({ name: 'journey_events' })
@Index('IDX_JOURNEY_EVENTS_OCCURRED_AT', ['occurred_at'])
@Index('IDX_JOURNEY_EVENTS_EVENT_OCCURRED_AT', ['event', 'occurred_at'])
@Index('IDX_JOURNEY_EVENTS_ANON_OCCURRED_AT', ['anon_id', 'occurred_at'])
export class JourneyEvent {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'uuid' })
  anon_id: string;

  @Column({ type: 'varchar', length: 48 })
  event: string;

  @Column({ type: 'varchar', length: 96, default: '(other)' })
  page: string;

  @Column({ type: 'timestamptz' })
  occurred_at: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  received_at: Date;
}
