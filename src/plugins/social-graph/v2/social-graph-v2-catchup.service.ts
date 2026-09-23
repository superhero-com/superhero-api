import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { decimal } from './social-graph-v2-reader';
import {
  GraphMutation,
  ProjectionScope,
  SocialGraphV2ProjectionService,
} from './social-graph-v2-projection.service';

export interface OrderedGraphTransaction {
  hash: string;
  height: string;
  /** Ordered chain position (height, micro block, transaction), never page-relative. */
  position: string;
  events: { index: number; changes: GraphMutation[]; followAccount?: string }[];
}
export interface CatchupPage {
  expectedCursor: string;
  nextCursor: string | null;
  transactions: OrderedGraphTransaction[];
}

/** Transport must verify canonical anchors and complete middleware coverage before
 * invoking this service. Every page and its checkpoint commit atomically. */
@Injectable()
export class SocialGraphV2CatchupService {
  constructor(
    private readonly db: DataSource,
    private readonly projection: SocialGraphV2ProjectionService,
  ) {}

  async begin(
    scope: ProjectionScope,
    end: { hash: string; height: string },
    firstCursor: string,
  ) {
    decimal(end.height);
    if (!firstCursor || firstCursor.length > 8192)
      throw new Error('Invalid sync cursor');
    await this.db.transaction(async (m) => {
      const key = [scope.network, scope.contract, scope.generation];
      const s = (
        await m.query(
          'SELECT * FROM social_graph_v2_scopes WHERE network=$1 AND contract=$2 AND generation=$3 FOR UPDATE',
          key,
        )
      )[0];
      if (
        !s ||
        !['ready', 'catching-up'].includes(s.state) ||
        s.sync_end_height != null
      )
        throw new Error('No available catch-up checkpoint');
      const start = s.synced_height ?? s.snapshot_height;
      if (start == null || BigInt(end.height) <= BigInt(start))
        throw new Error('Invalid sync window');
      // Initial catch-up is unavailable. Once bootstrapped, each page applies complete
      // transactions atomically, so live readers can safely observe an ordered prefix.
      await m.query(
        `UPDATE social_graph_v2_scopes SET state=CASE WHEN synced_height IS NULL THEN 'catching-up' ELSE 'ready' END,sync_end_hash=$4,sync_end_height=$5,
        sync_cursor=$6,sync_last_position=NULL,sync_last_height=NULL WHERE network=$1 AND contract=$2 AND generation=$3`,
        [...key, end.hash, end.height, firstCursor],
      );
    });
  }

  async applyPage(scope: ProjectionScope, page: CatchupPage): Promise<boolean> {
    if (
      page.transactions.length > 100 ||
      !page.expectedCursor ||
      (page.nextCursor !== null &&
        (!page.nextCursor ||
          page.nextCursor.length > 8192 ||
          page.nextCursor === page.expectedCursor))
    )
      throw new Error('Invalid sync page');
    return this.db.transaction(async (m) => {
      const key = [scope.network, scope.contract, scope.generation];
      const s = (
        await m.query(
          'SELECT * FROM social_graph_v2_scopes WHERE network=$1 AND contract=$2 AND generation=$3 FOR UPDATE',
          key,
        )
      )[0];
      if (
        !s ||
        !['ready', 'catching-up'].includes(s.state) ||
        s.sync_end_height == null ||
        s.sync_cursor !== page.expectedCursor
      )
        throw new Error('Sync checkpoint changed');
      const start = BigInt(s.synced_height ?? s.snapshot_height);
      const end = BigInt(s.sync_end_height);
      let last =
        s.sync_last_position == null ? null : BigInt(s.sync_last_position);
      let previousHeight: bigint | null =
        s.sync_last_height == null ? null : BigInt(s.sync_last_height);
      for (const tx of page.transactions) {
        const position = BigInt(decimal(tx.position)),
          height = BigInt(decimal(tx.height));
        if (
          (last !== null && position <= last) ||
          height < start ||
          height >= end ||
          (previousHeight !== null && height < previousHeight) ||
          tx.events.length > 10000 ||
          !tx.hash
        )
          throw new Error('Unordered or out-of-window transaction');
        last = position;
        previousHeight = height;
        let eventIndex = -1;
        for (const event of tx.events) {
          if (
            !Number.isSafeInteger(event.index) ||
            event.index <= eventIndex ||
            event.changes.length > 1
          )
            throw new Error('Invalid event order');
          eventIndex = event.index;
          const inserted = await m.query(
            `INSERT INTO social_graph_v2_events(network,contract,generation,tx_hash,event_index,height)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING tx_hash`,
            [...key, tx.hash, event.index, tx.height],
          );
          if (!inserted.length)
            throw new Error('Transaction replay at a new sync position');
          for (const change of event.changes) {
            const insertedEdge = await this.projection.mutate(m, scope, change);
            if (
              insertedEdge &&
              change.kind === 'follow' &&
              change.present &&
              s.notify_from_height != null &&
              height >= BigInt(s.notify_from_height)
            ) {
              await m.query(
                `INSERT INTO social_graph_v2_outbox(network,contract,generation,tx_hash,event_index,height,follower,followed)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
                [
                  ...key,
                  tx.hash,
                  event.index,
                  tx.height,
                  change.from,
                  change.to,
                ],
              );
            }
          }
          if (event.followAccount) {
            await m.query(
              `INSERT INTO social_graph_v2_rates(network,contract,generation,address,last_follow_height)
              VALUES($1,$2,$3,$4,$5) ON CONFLICT(network,contract,generation,address)
              DO UPDATE SET last_follow_height=EXCLUDED.last_follow_height`,
              [...key, event.followAccount, tx.height],
            );
          }
        }
      }
      if (page.nextCursor === null) {
        await m.query(
          `UPDATE social_graph_v2_scopes SET state='ready',synced_hash=sync_end_hash,synced_height=sync_end_height,
          sync_end_hash=NULL,sync_end_height=NULL,sync_cursor=NULL,sync_last_position=NULL,sync_last_height=NULL
          WHERE network=$1 AND contract=$2 AND generation=$3`,
          key,
        );
      } else {
        await m.query(
          `UPDATE social_graph_v2_scopes SET sync_cursor=$4,sync_last_position=$5,sync_last_height=$6
          WHERE network=$1 AND contract=$2 AND generation=$3`,
          [
            ...key,
            page.nextCursor,
            last?.toString() ?? null,
            previousHeight?.toString() ?? null,
          ],
        );
      }
      return page.nextCursor === null;
    });
  }
}
