import { ACTIVE_NETWORK, TX_FUNCTIONS } from '@/configs';
import { PULL_ACCOUNTS_ENABLED } from '@/configs/constants';
import { Transaction } from '@/transactions/entities/transaction.entity';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import BigNumber from 'bignumber.js';
import {
  Brackets,
  EntityManager,
  In,
  IsNull,
  LessThan,
  Not,
  Repository,
} from 'typeorm';
import { Account } from '../entities/account.entity';
import { fetchJson } from '@/utils/common';
import { mapWithConcurrency } from '@/utils/concurrency.util';

const SEARCH_DEFAULT_LIMIT = 8;
const SEARCH_MIN_LIMIT = 1;
const SEARCH_MAX_LIMIT = 20;
// Minimum trimmed query length before we touch the DB. A leading-wildcard
// ILIKE ('%q%') is non-sargable (sequential scan), so we refuse 1-char terms
// that would scan the whole table for no useful typeahead value.
const SEARCH_MIN_QUERY_LENGTH = 2;
const CHAIN_NAMES_MAX_ADDRESSES = 25;
// Bounded concurrency + a tight per-call timeout for verifying candidate
// chain names against middleware, so one slow/hanging name lookup can't
// stall (or blow past fetchJson's much longer default timeout for) the
// whole account's chain-name resolution.
//
// refreshChainNamesPeriodically (below) already runs 10 accounts concurrently
// via its own batching, and calls getChainNameForAccount -- which uses this
// constant -- for each. That nests per-account concurrency inside the
// per-batch concurrency, so the real worst-case fan-out is
// (outer batch size) x CHAIN_NAME_VERIFY_CONCURRENCY, not just this value on
// its own. Kept low (2, not the 8 a single account's verification alone
// would justify) so that product stays a reasonable ceiling (20) on
// concurrent outbound middleware requests; raise either number only with the
// other in mind.
const CHAIN_NAME_VERIFY_CONCURRENCY = 2;
const CHAIN_NAME_VERIFY_TIMEOUT_MS = 5_000;

type AggregatedAccountRow = {
  address: string;
  total_tx_count: number;
  total_buy_tx_count: number;
  total_sell_tx_count: number;
  total_created_tokens: number;
  total_volume: string;
};

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,

    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
  ) {
    //
  }

  onModuleInit() {
    if (PULL_ACCOUNTS_ENABLED) {
      this.saveAllActiveAccounts();
    }
  }

  /**
   * Ensures a minimal account row exists (used when indexing activity).
   */
  async ensureAccountExists(
    address: string,
    manager?: EntityManager,
  ): Promise<Account | null> {
    const accountRepository = manager
      ? manager.getRepository(Account)
      : this.accountRepository;

    await accountRepository.upsert(
      { address },
      {
        conflictPaths: ['address'],
        skipUpdateIfNoValuesChanged: true,
      },
    );

    return accountRepository.findOne({ where: { address } });
  }

  /**
   * Creates or refreshes an account row from indexed BCL transactions.
   * The accounts list/search only queries this table; without a row, active
   * traders are invisible even when transactions exist.
   */
  async ensureAccountFromTransactions(
    address: string,
    manager?: EntityManager,
  ): Promise<Account | null> {
    const accountRepository = manager
      ? manager.getRepository(Account)
      : this.accountRepository;
    const transactionRepository = manager
      ? manager.getRepository(Transaction)
      : this.transactionRepository;

    const existing = await accountRepository.findOne({
      where: { address },
    });

    const aggregated = await this.aggregateAccountRow(
      address,
      transactionRepository,
    );
    if (!aggregated) {
      return existing;
    }

    await accountRepository.upsert(aggregated, {
      conflictPaths: ['address'],
    });

    return accountRepository.findOne({ where: { address } });
  }

  private async aggregateAccountRow(
    address: string,
    transactionRepository: Repository<Transaction>,
  ): Promise<Account | null> {
    const rows: AggregatedAccountRow[] = await transactionRepository.query(
      `SELECT
          address,
          COUNT(*)::int                                    AS total_tx_count,
          COUNT(*) FILTER (WHERE tx_type = $2)::int        AS total_buy_tx_count,
          COUNT(*) FILTER (WHERE tx_type = $3)::int        AS total_sell_tx_count,
          COUNT(*) FILTER (WHERE tx_type = $4)::int        AS total_created_tokens,
          COALESCE(SUM(CAST(NULLIF(amount->>'ae','NaN') AS DECIMAL)), 0) AS total_volume
        FROM transactions
        WHERE address = $1
        GROUP BY address`,
      [
        address,
        TX_FUNCTIONS.buy,
        TX_FUNCTIONS.sell,
        TX_FUNCTIONS.create_community,
      ],
    );

    if (!rows.length) {
      return null;
    }

    const row = rows[0];
    return {
      address: row.address,
      total_tx_count: row.total_tx_count,
      total_buy_tx_count: row.total_buy_tx_count,
      total_sell_tx_count: row.total_sell_tx_count,
      total_created_tokens: row.total_created_tokens,
      total_volume: new BigNumber(row.total_volume),
    } as Account;
  }

  /**
   * Typeahead search over accounts by address or chain name, for account
   * autocomplete. Returns `[]` for a missing/blank term without touching the
   * database. Accounts that have a chain name are ranked first, then by
   * total_volume desc, so an autocomplete list surfaces "known" identities
   * before anonymous addresses.
   */
  async searchByNameOrAddress(
    q: string | undefined,
    limit: number = SEARCH_DEFAULT_LIMIT,
  ): Promise<Array<{ address: string; chain_name: string | null }>> {
    const trimmed = q?.trim();
    if (!trimmed || trimmed.length < SEARCH_MIN_QUERY_LENGTH) {
      return [];
    }

    const clampedLimit = Math.min(
      Math.max(limit, SEARCH_MIN_LIMIT),
      SEARCH_MAX_LIMIT,
    );
    const term = `%${trimmed}%`;

    const accounts = await this.accountRepository
      .createQueryBuilder('account')
      .select(['account.address', 'account.chain_name', 'account.total_volume'])
      .where(
        new Brackets((qb) => {
          qb.where('account.address ILIKE :term', { term }).orWhere(
            'account.chain_name ILIKE :term',
            { term },
          );
        }),
      )
      .orderBy('(account.chain_name IS NOT NULL)', 'DESC')
      .addOrderBy('account.total_volume', 'DESC')
      .limit(clampedLimit)
      .getMany();

    return accounts.map((account) => ({
      address: account.address,
      chain_name: account.chain_name ?? null,
    }));
  }

  /**
   * Batch chain-name resolver, for e.g. a comparison page that needs to
   * display chain names for a fixed set of addresses. Every requested
   * (valid) address is present in the result map — `null` when the account
   * is unknown or has no chain name — so callers never need to special-case
   * a missing key.
   */
  async getChainNamesForAddresses(
    addresses: string[],
  ): Promise<Record<string, string | null>> {
    const capped = addresses.slice(0, CHAIN_NAMES_MAX_ADDRESSES);
    const result: Record<string, string | null> = {};
    if (!capped.length) {
      return result;
    }

    const accounts = await this.accountRepository.find({
      where: { address: In(capped) },
      select: ['address', 'chain_name'],
    });

    const chainNameByAddress = new Map(
      accounts.map((account) => [account.address, account.chain_name ?? null]),
    );

    for (const address of capped) {
      result[address] = chainNameByAddress.get(address) ?? null;
    }
    return result;
  }

  private static readonly ACCOUNT_BATCH_SIZE = 500;

  isPullingAccounts = false;
  async saveAllActiveAccounts() {
    if (this.isPullingAccounts) {
      return;
    }
    this.isPullingAccounts = true;
    try {
      const aggregated: AggregatedAccountRow[] =
        await this.transactionRepository.query(
          `SELECT
          address,
          COUNT(*)::int                                    AS total_tx_count,
          COUNT(*) FILTER (WHERE tx_type = $1)::int        AS total_buy_tx_count,
          COUNT(*) FILTER (WHERE tx_type = $2)::int        AS total_sell_tx_count,
          COUNT(*) FILTER (WHERE tx_type = $3)::int        AS total_created_tokens,
          COALESCE(SUM(CAST(NULLIF(amount->>'ae','NaN') AS DECIMAL)), 0) AS total_volume
        FROM transactions
        GROUP BY address`,
          [TX_FUNCTIONS.buy, TX_FUNCTIONS.sell, TX_FUNCTIONS.create_community],
        );

      for (
        let i = 0;
        i < aggregated.length;
        i += AccountService.ACCOUNT_BATCH_SIZE
      ) {
        const batch = aggregated
          .slice(i, i + AccountService.ACCOUNT_BATCH_SIZE)
          .map((row) => ({
            address: row.address,
            total_tx_count: row.total_tx_count,
            total_buy_tx_count: row.total_buy_tx_count,
            total_sell_tx_count: row.total_sell_tx_count,
            total_created_tokens: row.total_created_tokens,
            total_volume: new BigNumber(row.total_volume),
          }));

        await this.accountRepository.upsert(batch, {
          conflictPaths: ['address'],
          skipUpdateIfNoValuesChanged: true,
        });
      }
    } catch (error) {
      this.logger.error('Error pulling and saving accounts', error);
    }
    this.isPullingAccounts = false;
  }

  /**
   * Fetches the chain name for an account from middleware
   * Returns the newest chain name that currently points to the account
   * @returns string if chain name found, null if no chain name exists, undefined if fetch failed
   */
  async getChainNameForAccount(
    accountAddress: string,
  ): Promise<string | null | undefined> {
    try {
      const middlewareUrl = ACTIVE_NETWORK.middlewareUrl;
      const pointeesUrl = `${middlewareUrl}/v3/accounts/${encodeURIComponent(accountAddress)}/names/pointees`;

      const response = await fetchJson<{
        data: Array<{
          active: boolean;
          name: string;
          block_height?: number;
          block_time?: number;
          tx: {
            pointers: Array<{
              id: string;
              key: string;
              encoded_key: string;
            }>;
          };
        }>;
      }>(pointeesUrl);

      if (!response?.data || !Array.isArray(response.data)) {
        return null;
      }

      // Group names by name string and get the latest entry for each name
      // The API returns historical records, so we need to use only the most recent pointer update
      const latestByName = new Map<string, (typeof response.data)[0]>();

      for (const name of response.data) {
        if (
          !name.active ||
          !name.tx?.pointers ||
          !Array.isArray(name.tx.pointers)
        ) {
          continue;
        }

        const existing = latestByName.get(name.name);
        const nameBlockHeight = name.block_height ?? 0;

        // Keep only the latest entry for each name (highest block_height)
        if (!existing || nameBlockHeight > (existing.block_height ?? 0)) {
          latestByName.set(name.name, name);
        }
      }

      // Verify current pointer state for each name by querying the name directly
      // The /names/pointees endpoint returns historical records, so we need to check current state.
      // Bounded concurrency + a per-call timeout instead of one sequential
      // fetchJson per candidate name, so an account with several candidate
      // names (or one slow/hanging lookup) doesn't serialize the whole check.
      type VerifiedName = { name: string; blockHeight: number; time: number };

      const verificationResults = await mapWithConcurrency(
        [...latestByName.values()],
        CHAIN_NAME_VERIFY_CONCURRENCY,
        async (name): Promise<VerifiedName | null> => {
          try {
            // Query the name directly to get its current pointer state
            const nameUrl = `${middlewareUrl}/v3/names/${encodeURIComponent(name.name)}`;
            const nameResponse = await fetchJson<{
              active: boolean;
              pointers: Array<{ id: string }>;
            }>(nameUrl, {
              signal: AbortSignal.timeout(CHAIN_NAME_VERIFY_TIMEOUT_MS),
            });

            // If response doesn't have pointers array, the name doesn't exist (e.g., 404)
            // Skip it - don't fall back to historical data as it would be stale
            if (
              !nameResponse?.pointers ||
              !Array.isArray(nameResponse.pointers)
            ) {
              return null;
            }

            // Check if the name is active AND the CURRENT pointer points to this account address
            // An inactive name shouldn't be considered as "currently pointing" to the account
            const isActive = nameResponse.active === true;
            const hasMatchingPointer = nameResponse.pointers.some(
              (pointer: any) => pointer && pointer.id === accountAddress,
            );

            if (isActive && hasMatchingPointer) {
              return {
                name: name.name,
                blockHeight: name.block_height ?? 0,
                time: name.block_time ?? 0,
              };
            }
            return null;
          } catch (e) {
            // Only fall back to historical data on true network errors (caught exceptions,
            // including our own timeout abort). This handles cases like network timeouts,
            // connection failures, etc. HTTP errors (like 404) are not caught here - they
            // return parsed JSON without pointers.
            const hasMatchingPointer = name.tx.pointers.some(
              (pointer) => pointer && pointer.id === accountAddress,
            );
            if (hasMatchingPointer && name.active) {
              return {
                name: name.name,
                blockHeight: name.block_height ?? 0,
                time: name.block_time ?? 0,
              };
            }
            return null;
          }
        },
      );

      const verifiedNames = verificationResults.filter(
        (result): result is VerifiedName => result !== null,
      );

      if (verifiedNames.length === 0) {
        return null;
      }

      // Sort by block_height (descending), then by time (descending) as fallback
      // The newest pointer will have the highest block_height
      verifiedNames.sort((a, b) => {
        if (a.blockHeight !== b.blockHeight) {
          return b.blockHeight - a.blockHeight; // Higher block_height = newer
        }
        return b.time - a.time; // Higher time = newer
      });

      // Return the name with the newest pointer
      return verifiedNames[0].name;
    } catch (error) {
      // Return undefined to indicate fetch failure (not "no chain name")
      // This allows the caller to preserve existing chain_name instead of overwriting with null
      this.logger.warn(
        `Failed to fetch chain name for ${accountAddress}`,
        error,
      );
      return undefined;
    }
  }

  /**
   * Periodically refresh chain names for accounts that have them
   * Runs every hour to keep chain names up to date
   */
  private isRefreshingChainNames = false;

  @Cron(CronExpression.EVERY_HOUR)
  async refreshChainNamesPeriodically(): Promise<void> {
    if (this.isRefreshingChainNames) {
      return;
    }

    this.isRefreshingChainNames = true;
    try {
      // Find accounts with chain names that haven't been updated in the last 23 hours
      // This ensures we refresh them before they become stale (24h threshold)
      const staleThreshold = new Date(Date.now() - 23 * 60 * 60 * 1000);

      const accountsToRefresh = await this.accountRepository.find({
        where: [
          {
            chain_name: Not(IsNull()),
            chain_name_updated_at: LessThan(staleThreshold),
          },
          { chain_name: Not(IsNull()), chain_name_updated_at: IsNull() },
        ],
        take: 100, // Process in batches to avoid overwhelming middleware
      });

      this.logger.log(
        `Refreshing chain names for ${accountsToRefresh.length} accounts`,
      );

      // Refresh chain names in parallel (but limit concurrency)
      const batchSize = 10;
      for (let i = 0; i < accountsToRefresh.length; i += batchSize) {
        const batch = accountsToRefresh.slice(i, i + batchSize);
        await Promise.allSettled(
          batch.map(async (account) => {
            try {
              const chainName = await this.getChainNameForAccount(
                account.address,
              );

              // Only update if fetch succeeded (not undefined)
              // undefined means fetch failed - preserve existing chain_name to avoid data loss
              if (chainName !== undefined) {
                const updateData: Partial<Account> = {
                  chain_name: chainName,
                  chain_name_updated_at: new Date(),
                };
                await this.accountRepository.update(
                  account.address,
                  updateData,
                );
              }
              // If chainName is undefined, skip update to preserve existing chain_name
            } catch (error) {
              this.logger.warn(
                `Failed to refresh chain name for ${account.address}`,
                error,
              );
            }
          }),
        );
      }

      this.logger.log(`Finished refreshing chain names`);
    } catch (error) {
      this.logger.error('Error refreshing chain names', error);
    } finally {
      this.isRefreshingChainNames = false;
    }
  }
}
