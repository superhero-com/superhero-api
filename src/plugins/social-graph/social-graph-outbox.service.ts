import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { SOCIAL_GRAPH_FOLLOWED_EVENT } from './events';
import { ProjectionScope } from './social-graph-projection.service';

@Injectable()
export class SocialGraphOutboxService {
  private readonly logger = new Logger(SocialGraphOutboxService.name);
  constructor(
    private readonly db: DataSource,
    private readonly events: EventEmitter2,
  ) {}

  /** Caller holds the namespace worker lock and has checked canonical watermark.
   * Delivery is at-least-once; channel dedup keys deliberately omit rebuild generation. */
  async dispatch(scope: ProjectionScope) {
    const key = [scope.network, scope.contract, scope.generation];
    const rows = await this.db.query(
      `SELECT o.*,EXISTS(SELECT 1 FROM social_graph_projection_edges e
      WHERE e.network=o.network AND e.contract=o.contract AND e.generation=o.generation
      AND e.from_address=o.follower AND e.to_address=o.followed AND e.kind='follow') AS still_following
      FROM social_graph_projection_outbox o JOIN social_graph_projection_scopes s USING(network,contract,generation)
      WHERE o.network=$1 AND o.contract=$2 AND o.generation=$3 AND o.delivered=false AND o.next_attempt_at<=now() AND s.state='ready' AND s.sync_end_height IS NULL
      ORDER BY o.next_attempt_at,o.height,o.tx_hash,o.event_index LIMIT 10`,
      key,
    );
    for (const row of rows) {
      try {
        if (row.still_following) {
          const results = await this.events.emitAsync(
            SOCIAL_GRAPH_FOLLOWED_EVENT,
            {
              followerAddress: row.follower,
              followedAddress: row.followed,
              txHash: row.tx_hash,
              graphScope: {
                network: scope.network,
                contract: scope.contract,
                eventIndex: row.event_index,
              },
            },
          );
          // No subscriber, disabled notifications or any non-acknowledgement is retryable.
          if (!results.length || !results.every((result) => result === true))
            throw new Error('Notification delivery not acknowledged');
        }
        await this.db.query(
          `UPDATE social_graph_projection_outbox SET delivered=true
          WHERE network=$1 AND contract=$2 AND generation=$3 AND tx_hash=$4 AND event_index=$5`,
          [...key, row.tx_hash, row.event_index],
        );
      } catch (error) {
        await this.db.query(
          `UPDATE social_graph_projection_outbox SET attempts=attempts+1,
          next_attempt_at=now()+make_interval(secs=>LEAST(300,power(2,LEAST(attempts,8)))::double precision)
          WHERE network=$1 AND contract=$2 AND generation=$3 AND tx_hash=$4 AND event_index=$5`,
          [...key, row.tx_hash, row.event_index],
        );
        this.logger.warn(
          `Social graph follow notification remains pending: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return rows.length;
  }
}
