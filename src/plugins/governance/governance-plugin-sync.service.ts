import { AeSdkService } from '@/ae/ae-sdk.service';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { ACTIVE_NETWORK } from '@/configs/network';
import {
  fetchJson,
  sanitizeJsonForPostgres,
  serializeBigInts,
} from '@/utils/common';
import { ITransaction } from '@/utils/types';
import camelcaseKeysDeep from 'camelcase-keys-deep';
import { AE_AMOUNT_FORMATS, Encoded } from '@aeternity/aepp-sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePluginSyncService } from '../base-plugin-sync.service';
import { SyncDirection } from '../plugin.interface';
import {
  GOVERNANCE_CONTRACT,
  getContractAddress,
} from './config/governance.config';
import GovernancePollACI from './contract/aci/GovernancePollACI.json';
import GovernanceRegistryACI from './contract/aci/GovernanceRegistryACI.json';
import { GovernancePollRegistry } from './services/governance-poll-registry.service';

const GOVERNANCE_VOTE_FUNCTIONS = new Set<string>([
  GOVERNANCE_CONTRACT.FUNCTIONS.vote,
  GOVERNANCE_CONTRACT.FUNCTIONS.revoke_vote,
]);

@Injectable()
export class GovernancePluginSyncService extends BasePluginSyncService {
  protected readonly logger = new Logger(GovernancePluginSyncService.name);
  readonly pluginName = 'governance';

  /** Max pages to walk when backfilling votes for a newly discovered poll. */
  static readonly VOTE_BACKFILL_PAGE_SAFETY = 100;

  constructor(
    aeSdkService: AeSdkService,
    @InjectRepository(Tx)
    private readonly txRepository: Repository<Tx>,
    private readonly pollRegistry: GovernancePollRegistry,
    private readonly configService: ConfigService,
  ) {
    super(aeSdkService);
  }

  /**
   * Resolve the governance registry contract address. Falls back to the
   * per-network default (see `governance.config.ts`) if ConfigService does
   * not override it. Kept in a single method so every consumer here stays
   * in sync with `GovernancePlugin.filters()`.
   */
  private getRegistryAddress(): Encoded.ContractAddress | null {
    const config = this.configService.get<{
      contract: { contractAddress: string };
    }>('governance');
    const address =
      config?.contract?.contractAddress ?? getContractAddress() ?? null;
    return (address || null) as Encoded.ContractAddress | null;
  }

  /**
   * Resolve the middleware URL. We prefer `mdw.middlewareUrl` from
   * ConfigService so a test / staging env can point at a non-default MDW.
   * Falls back to `ACTIVE_NETWORK.middlewareUrl` to preserve behavior when
   * the config is not set.
   */
  private getMiddlewareUrl(): string {
    return (
      this.configService.get<string>('mdw.middlewareUrl') ??
      ACTIVE_NETWORK.middlewareUrl
    );
  }

  async processTransaction(
    tx: Tx,
    syncDirection: SyncDirection,
  ): Promise<void> {
    try {
      this.logger.debug('Processing governance transaction', {
        txHash: tx.hash,
        contractId: tx.contract_id,
        function: tx.function,
        syncDirection,
      });

      // One-time registration of a poll address. We do this AFTER
      // `base-plugin.ts` has saved `tx.data.governance.data.poll_address`
      // (decodeData -> save -> processTransaction), so the in-memory
      // `GovernancePollRegistry` never gets ahead of what the `txs` table
      // contains. That invariant matters because the cleanup SQL derives
      // the known-poll set from `tx.data` in the DB; if runtime registered
      // polls that never made it into `tx.data`, SQL could delete votes
      // the runtime would keep.
      //
      // To be extra safe against the narrow "save threw but the in-memory
      // `tx.data` was already mutated by base-plugin" race, we re-read the
      // row and register only if the poll address is actually persisted.
      if (tx.function === GOVERNANCE_CONTRACT.FUNCTIONS.add_poll) {
        await this.registerPollFromPersistedTx(tx);
      }
    } catch (error: any) {
      this.handleError(error, tx, 'processTransaction');
      throw error;
    }
  }

  /**
   * Re-read the add_poll tx from the DB and register its poll address with
   * `GovernancePollRegistry` if (and only if) the governance data is
   * actually persisted. Also kicks off a one-time vote backfill the first
   * time this session sees the poll, so early votes dropped by the ingest
   * filter during backward / parallel sync are recovered.
   */
  private async registerPollFromPersistedTx(tx: Tx): Promise<void> {
    const persisted = await this.txRepository.findOne({
      where: { hash: tx.hash },
      select: ['hash', 'data'],
    });
    const persistedPollAddress: string | undefined = (persisted?.data as any)?.[
      this.pluginName
    ]?.data?.poll_address;

    if (!persistedPollAddress) {
      // Either the save failed, or decodeData returned null and nothing
      // was persisted. Either way, do not register — a subsequent
      // auto-update pass will retry once the data is on disk.
      this.logger.debug(
        `Skipping poll registration for tx ${tx.hash}: no persisted governance poll address yet`,
      );
      return;
    }

    const newlyRegistered = this.pollRegistry.register(persistedPollAddress);

    // Only backfill on the first successful registration in this session.
    // Polls seeded from the DB at startup return false here (they already
    // have all historical votes in `txs`), and repeat re-processings of the
    // same add_poll (auto-update / reorg) don't re-scan MDW.
    if (newlyRegistered) {
      await this.backfillPollVotes(persistedPollAddress, tx.hash);
    }
  }

  async decodeLogs(tx: Tx): Promise<any | null> {
    if (!tx?.raw?.log) {
      return null;
    }

    if (
      (
        [
          GOVERNANCE_CONTRACT.FUNCTIONS.add_poll,
          GOVERNANCE_CONTRACT.FUNCTIONS.delegate,
          GOVERNANCE_CONTRACT.FUNCTIONS.revoke_delegation,
        ] as readonly string[]
      ).includes(tx.function)
    ) {
      const registryAddress = this.getRegistryAddress();
      if (!registryAddress) {
        this.logger.warn(
          `Skipping log decode for tx ${tx.hash}: no governance registry contract configured`,
        );
        return null;
      }

      try {
        const contract = await this.getContract(
          registryAddress,
          GovernanceRegistryACI,
        );
        const decodedLogs = contract.$decodeEvents(tx.raw.log, {
          omitUnknown: true,
        });

        return serializeBigInts(decodedLogs);
      } catch (error: any) {
        const isUnknownEventError =
          error?.name === 'MissingEventDefinitionError' ||
          error?.message?.includes("Can't find definition");

        if (isUnknownEventError) {
          this.logger.warn(
            `Failed to decode logs for transaction ${tx.hash} due to unknown event definition (contract: ${tx.contract_id}, function: ${tx.function})`,
          );
        } else {
          this.logger.error(
            `Failed to decode logs for transaction ${tx.hash}`,
            error.stack,
          );
        }
        return null;
      }
    }

    if (
      (
        [
          GOVERNANCE_CONTRACT.FUNCTIONS.vote,
          GOVERNANCE_CONTRACT.FUNCTIONS.revoke_vote,
        ] as readonly string[]
      ).includes(tx.function)
    ) {
      try {
        const contract = await this.getContract(
          tx.contract_id as Encoded.ContractAddress,
          GovernancePollACI,
        );
        const decodedLogs = contract.$decodeEvents(tx.raw.log, {
          omitUnknown: true,
        });

        return serializeBigInts(decodedLogs);
      } catch (error: any) {
        const isUnknownEventError =
          error?.name === 'MissingEventDefinitionError' ||
          error?.message?.includes("Can't find definition");

        if (isUnknownEventError) {
          this.logger.warn(
            `Failed to decode logs for transaction ${tx.hash} due to unknown event definition (contract: ${tx.contract_id}, function: ${tx.function})`,
          );
        } else {
          this.logger.error(
            `Failed to decode logs for transaction ${tx.hash}`,
            error.stack,
          );
        }
        return null;
      }
    }

    return null;
  }

  async decodeData(tx: Tx): Promise<any | null> {
    const pluginLogs = tx.logs?.[this.pluginName];
    if (!pluginLogs?.data?.length) {
      return null;
    }

    if (tx.function == GOVERNANCE_CONTRACT.FUNCTIONS.add_poll) {
      const decodedLogs = pluginLogs.data[0];

      const pollAddress = decodedLogs.args[0];

      // NOTE: registration is deliberately deferred to `processTransaction`,
      // which runs AFTER `tx.data` has been persisted. This keeps the
      // runtime `GovernancePollRegistry` in lockstep with the SQL cleanup
      // script (which derives its known-poll set from the same `tx.data`).

      // The poll deployment (ContractCreateTx) was skipped by the ingest
      // filter — we only know a contract is a poll AFTER its add_poll call
      // arrives, but chain ordering puts the CreateTx first. On cache miss
      // we authoritatively fetch the CreateTx from the middleware and
      // persist it before continuing with decode.
      let createTx = await this.txRepository.findOne({
        where: {
          type: 'ContractCreateTx',
          contract_id: pollAddress as Encoded.ContractAddress,
        },
      });

      if (!createTx) {
        createTx = await this.backfillPollCreateTx(
          pollAddress as Encoded.ContractAddress,
          tx.hash,
        );
      }

      if (!createTx) {
        this.logger.warn(
          `ContractCreateTx not found for poll address ${pollAddress} in transaction ${tx.hash}`,
        );
        return null;
      }

      const contractCreateTxArgs = createTx.raw?.args;
      if (!contractCreateTxArgs || !Array.isArray(contractCreateTxArgs)) {
        this.logger.warn(
          `Invalid contract create tx args for poll address ${pollAddress} in transaction ${tx.hash}`,
        );
        return null;
      }

      const metadataArgs = contractCreateTxArgs[0]?.value;
      const voteOptionsArgs = contractCreateTxArgs[1]?.value;
      const closeHeightArgs = contractCreateTxArgs[2]?.value;

      if (!metadataArgs || !Array.isArray(metadataArgs)) {
        this.logger.warn(
          `Invalid metadata args for poll address ${pollAddress} in transaction ${tx.hash}`,
        );
        return null;
      }

      return {
        metadata: {
          title: metadataArgs[0],
          description: metadataArgs[1],
          link: metadataArgs[2],
          _spec_ref: metadataArgs[3],
        },
        vote_options: voteOptionsArgs,
        author: createTx.caller_id,
        poll_address: pollAddress,
        poll_seq_id: decodedLogs.args[1],
        close_at_height: closeHeightArgs?.[0],
        close_height: closeHeightArgs?.[1],
        create_height: createTx.block_height,
      };
    }

    if (tx.function == GOVERNANCE_CONTRACT.FUNCTIONS.vote) {
      const decodedLogs = pluginLogs.data[0];
      let balance = '0';
      const voter = decodedLogs.args[1];
      try {
        balance = await this.aeSdkService.sdk.getBalance(voter, {
          height: tx.block_height,
          format: AE_AMOUNT_FORMATS.AE,
        });
      } catch (error) {}
      return {
        poll_address: decodedLogs.contract.address,
        poll: decodedLogs.args[0],
        voter: decodedLogs.args[1],
        voter_balance: balance,
        option: Number(decodedLogs.args[2]),
      };
    }

    if (tx.function == GOVERNANCE_CONTRACT.FUNCTIONS.revoke_vote) {
      const decodedLogs = pluginLogs.data[0];
      return {
        poll_address: decodedLogs.contract.address,
        poll: decodedLogs.args[0],
        voter: decodedLogs.args[1],
      };
    }

    if (tx.function == GOVERNANCE_CONTRACT.FUNCTIONS.delegate) {
      const decodedLogs = pluginLogs.data[0];
      return {
        delegator: decodedLogs.args[0],
        delegatee: decodedLogs.args[1],
      };
    }

    if (tx.function == GOVERNANCE_CONTRACT.FUNCTIONS.revoke_delegation) {
      const decodedLogs = pluginLogs.data[0];
      return {
        delegator: decodedLogs.args[0],
      };
    }

    return null;
  }

  /**
   * Fetch the poll contract's ContractCreateTx from the middleware and
   * persist it. Called on-demand by `decodeData(add_poll)` when the deploy
   * transaction is not yet present locally — this happens because the plugin
   * filter intentionally rejects unknown ContractCreateTx rows at ingest to
   * satisfy the "save only required transactions" goal, and the deploy
   * precedes its `add_poll` registration in chain order.
   *
   * Best-effort: returns `null` on any failure (network, missing contract,
   * malformed response). Callers already handle a null result by logging
   * and skipping metadata decode for this add_poll.
   */
  private async backfillPollCreateTx(
    pollAddress: Encoded.ContractAddress,
    addPollTxHash: string,
  ): Promise<Tx | null> {
    const middlewareUrl = this.getMiddlewareUrl();
    try {
      const contractInfo = await fetchJson(
        `${middlewareUrl}/v3/contracts/${pollAddress}`,
      );
      const createTxHash: string | undefined = contractInfo?.source_tx_hash;
      if (!createTxHash) {
        this.logger.warn(
          `Cannot backfill CreateTx for poll ${pollAddress} (add_poll ${addPollTxHash}): middleware response missing source_tx_hash`,
        );
        return null;
      }

      const rawTx = await fetchJson(
        `${middlewareUrl}/v3/transactions/${createTxHash}`,
      );
      if (!rawTx) {
        this.logger.warn(
          `Cannot backfill CreateTx ${createTxHash} for poll ${pollAddress}: middleware returned empty response`,
        );
        return null;
      }

      const mdwTx = camelcaseKeysDeep(rawTx) as ITransaction;

      if (mdwTx?.tx?.type !== 'ContractCreateTx') {
        this.logger.warn(
          `Backfill aborted: tx ${createTxHash} for poll ${pollAddress} is ${mdwTx?.tx?.type}, not ContractCreateTx`,
        );
        return null;
      }

      const sanitizedRaw = mdwTx.tx ? sanitizeJsonForPostgres(mdwTx.tx) : null;
      const sanitizedSignatures = mdwTx.signatures
        ? sanitizeJsonForPostgres(mdwTx.signatures)
        : [];

      const createTxEntity: Partial<Tx> = {
        hash: mdwTx.hash,
        block_height: mdwTx.blockHeight,
        block_hash: mdwTx.blockHash?.toString() || '',
        micro_index: mdwTx.microIndex?.toString() || '0',
        micro_time: mdwTx.microTime?.toString() || '0',
        signatures: sanitizedSignatures,
        encoded_tx: mdwTx.encodedTx || '',
        type: mdwTx.tx?.type || '',
        contract_id: pollAddress,
        function: mdwTx.tx?.function,
        caller_id: mdwTx.tx?.callerId,
        sender_id: mdwTx.tx?.senderId,
        recipient_id: mdwTx.tx?.recipientId,
        payload: '',
        raw: sanitizedRaw,
        version: 1,
        created_at: new Date(mdwTx.microTime),
      };

      await this.txRepository.upsert(createTxEntity, ['hash']);

      this.logger.log(
        `Backfilled ContractCreateTx ${createTxHash} for poll ${pollAddress} (triggered by add_poll ${addPollTxHash})`,
      );

      return this.txRepository.findOne({
        where: { hash: mdwTx.hash },
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to backfill CreateTx for poll ${pollAddress} (add_poll ${addPollTxHash}): ${error?.message ?? error}`,
        error?.stack,
      );
      return null;
    }
  }

  /**
   * Fetch every vote / revoke_vote transaction for `pollAddress` from the
   * middleware and persist any rows not already in `txs`.
   *
   * Why this exists:
   *   The ingest filter can only accept `vote` / `revoke_vote` on a KNOWN
   *   poll. A poll becomes "known" when its `add_poll` is decoded. But the
   *   indexer processes MDW pages newest-to-oldest (backward sync) and
   *   parallelizes in bulk mode, so a page containing votes can be
   *   filtered BEFORE another page / the same page has registered the poll.
   *   Without this backfill, those early votes would be permanently
   *   dropped. Live indexing is not affected in practice (votes come after
   *   add_poll on-chain), but backward / bulk sync regularly exercises this
   *   race.
   *
   * Safety:
   *   * Idempotent: `upsert(['hash'])` — running twice is a no-op.
   *   * Auto-update compatible: saved rows have no governance plugin data
   *     yet, so the plugin's `getUpdateQueries` (version check) will pick
   *     them up on the next auto-update pass and decode logs/data normally.
   *   * Budgeted: we walk at most VOTE_BACKFILL_PAGE_SAFETY pages to avoid
   *     pathological loops if a poll has an unexpectedly huge vote history.
   *   * Best-effort: any error is logged and swallowed. The poll is still
   *     registered, and future votes for it will be accepted at ingest.
   */
  private async backfillPollVotes(
    pollAddress: string,
    addPollTxHash: string,
  ): Promise<void> {
    const middlewareUrl = this.getMiddlewareUrl();
    let nextPath: string | null =
      `/v3/transactions?type=contract_call&contract=${pollAddress}&direction=forward&limit=100`;

    let savedCount = 0;
    let skippedCount = 0;
    let safety = 0;

    try {
      while (
        nextPath &&
        safety < GovernancePluginSyncService.VOTE_BACKFILL_PAGE_SAFETY
      ) {
        safety += 1;
        const response = await fetchJson<any>(`${middlewareUrl}${nextPath}`);
        const page: any[] = response?.data ?? [];

        for (const raw of page) {
          const fn: string | undefined = raw?.tx?.function;
          if (!fn || !GOVERNANCE_VOTE_FUNCTIONS.has(fn)) {
            continue;
          }

          const hash: string | undefined = raw?.hash;
          if (!hash) {
            continue;
          }

          const existing = await this.txRepository.findOne({
            where: { hash },
            select: ['hash'],
          });
          if (existing) {
            skippedCount += 1;
            continue;
          }

          const mdwTx = camelcaseKeysDeep(raw) as ITransaction;
          const entity = this.buildVoteTxEntity(mdwTx, pollAddress);
          if (!entity) {
            continue;
          }

          await this.txRepository.upsert(entity, ['hash']);
          savedCount += 1;
        }

        const nextLink: string | null =
          typeof response?.next === 'string' ? response.next : null;
        nextPath = nextLink;
      }

      if (
        safety >= GovernancePluginSyncService.VOTE_BACKFILL_PAGE_SAFETY &&
        nextPath
      ) {
        this.logger.warn(
          `Vote backfill for poll ${pollAddress} hit the page safety limit (${GovernancePluginSyncService.VOTE_BACKFILL_PAGE_SAFETY}); remaining pages were not scanned.`,
        );
      }

      if (savedCount > 0 || skippedCount > 0) {
        this.logger.log(
          `Vote backfill complete for poll ${pollAddress} (triggered by add_poll ${addPollTxHash}): saved ${savedCount}, already-present ${skippedCount}.`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Failed to backfill votes for poll ${pollAddress} (add_poll ${addPollTxHash}): ${error?.message ?? error}`,
        error?.stack,
      );
    }
  }

  /**
   * Convert a middleware contract_call tx to a `Partial<Tx>` row shaped
   * exactly like `BlockSyncService.convertToMdwTx` would produce, so the
   * saved row is indistinguishable from one the main indexer would create.
   * Returns `null` if the payload is unusable (missing hash or wrong type).
   */
  private buildVoteTxEntity(
    mdwTx: ITransaction,
    pollAddress: string,
  ): Partial<Tx> | null {
    if (!mdwTx?.hash) {
      return null;
    }
    if (mdwTx.tx?.type !== 'ContractCallTx') {
      return null;
    }

    const sanitizedRaw = mdwTx.tx ? sanitizeJsonForPostgres(mdwTx.tx) : null;
    const sanitizedSignatures = mdwTx.signatures
      ? sanitizeJsonForPostgres(mdwTx.signatures)
      : [];

    return {
      hash: mdwTx.hash,
      block_height: mdwTx.blockHeight,
      block_hash: mdwTx.blockHash?.toString() || '',
      micro_index: mdwTx.microIndex?.toString() || '0',
      micro_time: mdwTx.microTime?.toString() || '0',
      signatures: sanitizedSignatures,
      encoded_tx: mdwTx.encodedTx || '',
      type: mdwTx.tx.type,
      contract_id: (mdwTx.tx.contractId ??
        pollAddress) as Encoded.ContractAddress,
      function: mdwTx.tx.function,
      caller_id: mdwTx.tx.callerId,
      sender_id: mdwTx.tx.senderId,
      recipient_id: mdwTx.tx.recipientId,
      payload: '',
      raw: sanitizedRaw,
      version: 1,
      created_at: mdwTx.microTime ? new Date(mdwTx.microTime) : new Date(),
    };
  }
}
