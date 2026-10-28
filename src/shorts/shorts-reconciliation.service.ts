import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Encoding, isAddressValid } from '@aeternity/aepp-sdk';
import { DataSource } from 'typeorm';
import { ShortsDatabaseService } from './shorts-database.service';
import { ShortsChainService } from './shorts-chain.service';
import {
  ShortsIndexService,
  SHORTS_INDEX_VERSION,
} from './shorts-index.service';
import { receiptHash } from './shorts-receipts.service';
import { shortsRuntimeScope } from './shorts-runtime-scope';

const pageSize = 5;
function integer(value: unknown): bigint {
  const text = typeof value === 'bigint' ? value.toString() : value;
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(text))
    throw new ServiceUnavailableException('Invalid accounting observation');
  return BigInt(text);
}
function account(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isAddressValid(value, Encoding.AccountAddress)
  )
    throw new ServiceUnavailableException('Invalid accounting account');
  return value;
}

/** Read-only diagnostics. A matched page is not a completed audit of all accounts. */
@Injectable()
export class ShortsReconciliationService {
  private active = false;
  constructor(
    @Inject(ShortsDatabaseService) private readonly db: DataSource,
    private readonly chain: ShortsChainService,
    private readonly index: ShortsIndexService,
  ) {}

  async compare(input: {
    contract?: string;
    height?: string;
    blockHash?: string;
    after?: string;
  }) {
    const scope = shortsRuntimeScope(this.chain);
    const contractId = input.contract ?? scope.contract;
    if (this.chain.release.schemaVersion === 2)
      throw new ServiceUnavailableException(
        'Historical reconciliation for mutable configuration and prepaid predecessors is unavailable. Live contract balances remain available.',
      );
    const instance = this.index
      .contracts()
      .find((item) => item.$options.address === contractId);
    if (!instance)
      throw new BadRequestException('Unrecognized Shorts contract');
    if (
      input.height !== undefined &&
      (typeof input.height !== 'string' ||
        !/^[1-9][0-9]{0,9}$/.test(input.height))
    )
      throw new BadRequestException('Invalid reconciliation height');
    if (input.blockHash !== undefined) {
      receiptHash(input.blockHash, 'kh_');
      if (!input.height)
        throw new BadRequestException('A block hash requires its height');
    }
    if (
      input.after !== undefined &&
      (typeof input.after !== 'string' ||
        !isAddressValid(input.after, Encoding.AccountAddress) ||
        !input.height ||
        !input.blockHash)
    )
      throw new BadRequestException(
        'Account paging requires a valid account and the original block',
      );
    if (this.active)
      throw new ServiceUnavailableException(
        'Accounting reconciliation is busy',
      );
    this.active = true;
    const node = this.chain.sdk.api;
    const host = this.chain.release.node;
    const unchanged = () => {
      shortsRuntimeScope(this.chain);
      if (
        this.chain.sdk.api !== node ||
        this.chain.release.node !== host ||
        node.$host.replace(/\/$/, '') !== host ||
        !this.index.contracts().includes(instance) ||
        instance.$options.address !== contractId
      )
        throw new ServiceUnavailableException(
          'Accounting deployment identity changed',
        );
    };
    const verifyNetwork = async () => {
      unchanged();
      if ((await node.getStatus()).networkId !== scope.network)
        throw new ServiceUnavailableException(
          'Accounting node network mismatch',
        );
      unchanged();
    };
    try {
      unchanged();
      await this.index.assertNetwork();
      const initial = await this.chain.readNode(async () => {
        await verifyNetwork();
        const tip = await node.getCurrentKeyBlock();
        const height =
          input.height === undefined ? tip.height - 1 : Number(input.height);
        if (
          !Number.isSafeInteger(tip.height) ||
          !Number.isSafeInteger(height) ||
          height < 1 ||
          height > tip.height - 1
        )
          throw new BadRequestException(
            'Accounting requires a confirmed, closed generation',
          );
        const anchor = await node.getKeyBlockByHeight(height);
        const hash = receiptHash(anchor.hash, 'kh_') as `kh_${string}`;
        if (
          anchor.height !== height ||
          (input.blockHash && input.blockHash !== anchor.hash)
        )
          throw new ConflictException(
            'Accounting block changed; restart the check',
          );
        const read = async (method: string) =>
          (
            await instance.$call(method, [], {
              callStatic: true,
              top: hash,
            })
          ).decodedResult;
        const [config, liabilities] = await Promise.all([
          read('get_config'),
          read('get_liabilities'),
        ]);
        if (
          !Array.isArray(config) ||
          config.length !== 4 ||
          !Array.isArray(liabilities) ||
          liabilities.length !== 2
        )
          throw new ServiceUnavailableException(
            'Unsupported Shorts accounting artifact',
          );
        const treasury = account(config[1]),
          fee = integer(config[2]),
          bps = integer(config[3]);
        if (fee <= 0n || bps > 10000n)
          throw new ServiceUnavailableException(
            'Invalid accounting configuration',
          );
        return {
          height,
          hash,
          treasury,
          fee,
          treasuryPerLike: (fee * bps) / 10000n,
          liability: integer(liabilities[0]),
          balance: integer(liabilities[1]),
        };
      });
      unchanged();
      const creatorPerLike = initial.fee - initial.treasuryPerLike;
      const projected = await this.db.transaction(
        'REPEATABLE READ',
        async (manager) => {
          await manager.query('SET TRANSACTION READ ONLY');
          const health = await this.index.health(manager);
          if (health.stale || health.height < initial.height + 1)
            throw new ServiceUnavailableException(
              'Accounting history is incomplete or stale',
            );
          // A key block's state excludes microblocks in its own generation.
          // The index's event-count marker also detects missing projection rows.
          const [integrity] = await manager.query(
            `SELECT count(*)::text AS invalid FROM txs t
          WHERE t.block_height < $2 AND (t.contract_id=$1 OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(t.raw->'log','[]'::jsonb)) l WHERE l->>'address'=$1))
          AND ((t.data->'shorts'->>'_version') IS DISTINCT FROM $3::text
            OR (t.data->'shorts'->'data'->>'events') IS DISTINCT FROM (
              SELECT count(*)::text FROM shorts_chain_events e WHERE e.tx_hash=t.hash AND e.contract=ANY($4::text[]))
            OR EXISTS(SELECT 1 FROM shorts_chain_events e WHERE e.tx_hash=t.hash AND e.contract=$1
              AND (e.block_height<>t.block_height OR e.at<>t.micro_time)))`,
            [
              contractId,
              initial.height,
              SHORTS_INDEX_VERSION,
              this.index.contracts().map((item) => item.$options.address),
            ],
          );
          if (integer(integrity.invalid) !== 0n)
            throw new ServiceUnavailableException(
              'Accounting projection needs repair',
            );
          const [totals] = await manager.query(
            `SELECT
          count(*) FILTER(WHERE action='PaidLike')::text AS likes,
          COALESCE(sum(amount) FILTER(WHERE action='PaidLike'),0)::text AS creators,
          COALESCE(sum(amount) FILTER(WHERE action='Claimed'),0)::text AS claims,
          count(*) FILTER(WHERE (action='PaidLike' AND amount<>$3::numeric)
            OR (action='Claimed' AND actor<>beneficiary))::text AS invalid
          FROM shorts_chain_events WHERE contract=$1 AND block_height<$2`,
            [contractId, initial.height, creatorPerLike.toString()],
          );
          const accounts = await manager.query(
            `WITH movements AS (
          SELECT beneficiary AS address, amount AS earned, 0::numeric AS claimed
            FROM shorts_chain_events WHERE contract=$1 AND block_height<$2 AND action='PaidLike'
          UNION ALL SELECT $3::text, $4::numeric, 0::numeric
            FROM shorts_chain_events WHERE contract=$1 AND block_height<$2 AND action='PaidLike'
          UNION ALL SELECT actor, 0::numeric, amount
            FROM shorts_chain_events WHERE contract=$1 AND block_height<$2 AND action='Claimed'
          UNION ALL SELECT $3::text, 0::numeric, 0::numeric
        ) SELECT address, sum(earned)::text AS earned, sum(claimed)::text AS claimed
          FROM movements WHERE ($5::text IS NULL OR address COLLATE "C" > $5 COLLATE "C")
          GROUP BY address ORDER BY address COLLATE "C" LIMIT $6`,
            [
              contractId,
              initial.height,
              initial.treasury,
              initial.treasuryPerLike.toString(),
              input.after ?? null,
              pageSize + 1,
            ],
          );
          return { totals, accounts };
        },
      );
      const rows = projected.accounts.slice(0, pageSize);
      const accounts = await this.chain.readNode(async () => {
        const compared = [];
        // Keep dry-run concurrency and returned account state bounded.
        for (const row of rows) {
          const address = account(row.address);
          const earned = integer(row.earned),
            claimed = integer(row.claimed),
            available = earned - claimed;
          const value = (
            await instance.$call('get_account', [address], {
              callStatic: true,
              top: initial.hash,
            })
          ).decodedResult;
          const observed = {
            earned: integer(value?.earned),
            claimed: integer(value?.claimed),
            available: integer(value?.available),
          };
          compared.push({
            address,
            indexed: {
              earned: earned.toString(),
              claimed: claimed.toString(),
              available: available.toString(),
            },
            onChain: Object.fromEntries(
              Object.entries(observed).map(([key, amount]) => [
                key,
                amount.toString(),
              ]),
            ),
            matches:
              observed.earned === earned &&
              observed.claimed === claimed &&
              observed.available === available,
          });
        }
        const current = await node.getKeyBlockByHeight(initial.height),
          tip = await node.getCurrentKeyBlock();
        if (
          current.hash !== initial.hash ||
          current.height !== initial.height ||
          !Number.isSafeInteger(tip.height) ||
          tip.height < initial.height + 1
        )
          throw new ConflictException(
            'Accounting block changed; restart the check',
          );
        return compared;
      });
      unchanged();
      const likes = integer(projected.totals.likes),
        creators = integer(projected.totals.creators),
        claims = integer(projected.totals.claims);
      const treasury = likes * initial.treasuryPerLike,
        expected = creators + treasury - claims;
      return {
        scope: 'contract_summary_and_account_page',
        network: scope.network,
        contract: contractId,
        block: {
          height: initial.height,
          hash: initial.hash,
          throughGeneration: initial.height - 1,
        },
        unit: 'aetto',
        summary: {
          paidLikes: likes.toString(),
          creatorCredits: creators.toString(),
          treasuryCredits: treasury.toString(),
          claimed: claims.toString(),
          expectedLiability: expected.toString(),
          onChainLiability: initial.liability.toString(),
          contractBalance: initial.balance.toString(),
          liabilityDifference: (initial.liability - expected).toString(),
          unallocatedBalance: (initial.balance - initial.liability).toString(),
          invalidEvents: String(projected.totals.invalid),
          liabilitiesMatch:
            expected >= 0n &&
            initial.liability === expected &&
            integer(projected.totals.invalid) === 0n,
          solvent: initial.balance >= initial.liability,
        },
        accounts: {
          after: input.after ?? null,
          checked: accounts.length,
          pageSize,
          items: accounts,
          next:
            projected.accounts.length > pageSize
              ? accounts[accounts.length - 1].address
              : null,
        },
      };
    } finally {
      // Recheck even when SQL/decoding fails, so a changed network can never
      // become an accounting result or a misleading permanent mismatch.
      try {
        await this.chain.readNode(verifyNetwork);
      } finally {
        this.active = false;
      }
    }
  }
}
