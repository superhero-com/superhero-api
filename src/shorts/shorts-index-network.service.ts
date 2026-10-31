import {
  Inject,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Encoding, isAddressValid } from '@aeternity/aepp-sdk';
import { DataSource } from 'typeorm';
import { ShortsChainService } from './shorts-chain.service';
import { ShortsDatabaseService } from './shorts-database.service';
import { shortsRuntimeScope } from './shorts-runtime-scope';

/** Persist chain-index ownership; unlike content tables, the shared index has no network column. */
@Injectable()
export class ShortsIndexNetworkService implements OnModuleInit {
  private ready = false;
  private pending?: Promise<void>;

  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    private readonly chain: ShortsChainService,
  ) {}

  onModuleInit() {
    return this.ensure();
  }

  async ensure() {
    const scope = shortsRuntimeScope(this.chain);
    if (this.ready) return;
    if (!this.pending) {
      this.pending = this.bind(scope.network)
        .then(() => {
          shortsRuntimeScope(this.chain);
          this.ready = true;
        })
        .finally(() => {
          this.pending = undefined;
        });
    }
    await this.pending;
    shortsRuntimeScope(this.chain);
  }

  private async bind(network: string) {
    const validate = (binding: { network: string }) => {
      if (binding.network !== network)
        throw new ServiceUnavailableException(
          'Shorts index belongs to another network; use a separate database',
        );
    };
    // Read-only API processes may reuse ownership established by the indexer.
    const [existing] = await this.db.query(
      'SELECT network FROM shorts_index_network WHERE singleton',
    );
    if (existing) return validate(existing);
    await this.db.transaction(async (manager) => {
      // Serializes competing startup instances, including different networks.
      // A failed first attempt rolls back without leaving a binding.
      await manager.query('LOCK TABLE shorts_index_network IN EXCLUSIVE MODE');
      const [binding] = await manager.query(
        'SELECT network FROM shorts_index_network WHERE singleton',
      );
      if (binding) {
        validate(binding);
        return;
      }
      // First adoption only: freeze shared history while verifying its endpoints.
      // No scan of all transactions and no write to existing projections.
      await manager.query('LOCK TABLE key_blocks, txs IN SHARE MODE');
      const node = this.chain.sdk.api;
      const host = this.chain.release.node;
      const unchanged = () => {
        shortsRuntimeScope(this.chain);
        if (
          this.chain.sdk.api !== node ||
          this.chain.release.node !== host ||
          node.$host.replace(/\/$/, '') !== host
        )
          throw new ServiceUnavailableException(
            'Shorts index node identity changed',
          );
      };
      unchanged();
      const anchors = await manager.query(`
        (SELECT height,hash FROM key_blocks WHERE height>0 ORDER BY height ASC LIMIT 1)
        UNION
        (SELECT height,hash FROM key_blocks WHERE height>0 ORDER BY height DESC LIMIT 1)`);
      const [history] = await manager.query(`SELECT
        EXISTS(SELECT 1 FROM txs) OR EXISTS(SELECT 1 FROM shorts_chain_events)
        OR EXISTS(SELECT 1 FROM shorts_index_backfill)
        OR EXISTS(SELECT 1 FROM key_blocks WHERE height<>0) AS present`);
      if (history.present && !anchors.length)
        throw new ServiceUnavailableException(
          'Shorts index history has no verifiable block; restore or rebuild its dedicated database',
        );
      await this.chain.readNode(async () => {
        if ((await node.getStatus()).networkId !== network)
          throw new ServiceUnavailableException(
            'Shorts index node network mismatch',
          );
        for (const anchor of anchors) {
          if (
            !Number.isSafeInteger(anchor.height) ||
            anchor.height < 1 ||
            !isAddressValid(anchor.hash, Encoding.KeyBlockHash)
          )
            throw new ServiceUnavailableException('Invalid stored index block');
          const block = await node.getKeyBlockByHeight(anchor.height);
          if (block.height !== anchor.height || block.hash !== anchor.hash)
            throw new ServiceUnavailableException(
              'Stored index history disagrees with the configured network',
            );
        }
        if ((await node.getStatus()).networkId !== network)
          throw new ServiceUnavailableException(
            'Shorts index node network changed',
          );
        unchanged();
      }, AbortSignal.timeout(10000));
      const anchor = anchors.sort((a, b) => a.height - b.height)[0];
      await manager.query(
        `INSERT INTO shorts_index_network(network,anchor_height,anchor_hash) VALUES($1,$2,$3)`,
        [network, anchor?.height ?? null, anchor?.hash ?? null],
      );
      unchanged();
    });
  }
}
