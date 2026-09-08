import { Logger } from '@nestjs/common';
import { BasePlugin } from './base-plugin';
import { PluginFilter, TxPageCursor } from './plugin.interface';
import { Tx } from '@/mdw-sync/entities/tx.entity';

const BATCH_SIZE = 100; // default `batchSize` in updateTransactions
const PLUGIN_NAME = 'test-plugin';

const compare = (a: Tx, b: TxPageCursor | Tx): number =>
  a.block_height - b.block_height ||
  Number(BigInt(a.micro_time) - BigInt(b.micro_time)) ||
  a.hash.localeCompare(b.hash);

const makeTx = (height: number, microTime: string, hash: string): Tx =>
  ({ block_height: height, micro_time: microTime, hash }) as Tx;

const isStale = (tx: Tx, version: number): boolean =>
  !tx.logs?.[PLUGIN_NAME] || tx.logs[PLUGIN_NAME]?._version !== version;

/**
 * Applies the real staleness predicate, keyset cursor and ordering, so the
 * paging loop is what these tests exercise -- not a scripted return sequence.
 */
function makeUpdateQuery(rows: Tx[], version: number) {
  const cursors: (TxPageCursor | undefined)[] = [];

  const query = async (
    _repo: unknown,
    limit: number,
    cursor?: TxPageCursor,
  ): Promise<Tx[]> => {
    cursors.push(cursor);
    let out = [...rows].sort(compare).filter((r) => isStale(r, version));
    if (cursor) {
      out = out.filter((r) => compare(r, cursor) > 0);
    }
    return out.slice(0, limit);
  };

  return { query, cursors };
}

class TestPlugin extends BasePlugin {
  protected readonly logger = new Logger('TestPlugin');
  readonly name = PLUGIN_NAME;
  readonly version = 1;
  decoded: string[] = [];

  constructor(
    protected readonly txRepository: any,
    protected readonly pluginSyncStateRepository: any,
    private readonly query: any,
    /** Hashes for which decodeLogs yields nothing, so no stamp is written. */
    private readonly undecodable = new Set<string>(),
  ) {
    super();
  }

  startFromHeight(): number {
    return 0;
  }
  filters(): PluginFilter[] {
    return [];
  }
  getUpdateQueries(): any[] {
    return [this.query];
  }
  protected getSyncService(): any {
    return {
      decodeLogs: async (tx: Tx) => {
        if (this.undecodable.has(tx.hash)) {
          return null;
        }
        this.decoded.push(tx.hash);
        return { ok: true };
      },
      decodeData: async () => null,
    };
  }
}

/** Mirrors the real repository: `save` persists onto the same row objects. */
const txRepo = () => ({ save: jest.fn(async (tx: Tx) => tx) });

describe('BasePlugin.updateTransactions paging', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  it('visits every stale transaction once when a page ends inside a microblock', async () => {
    // One microblock (same block_height AND micro_time) straddles the page
    // boundary at 100 -- a (block_height, micro_time) cursor drops its tail.
    const rows: Tx[] = [];
    for (let i = 0; i < 98; i++) {
      rows.push(
        makeTx(i + 1, `${(i + 1) * 1000}`, `h_${String(i).padStart(4, '0')}`),
      );
    }
    for (let i = 0; i < 10; i++) {
      rows.push(makeTx(500, '5000', `h_mb_${String(i).padStart(2, '0')}`));
    }
    for (let i = 0; i < 40; i++) {
      rows.push(
        makeTx(
          600 + i,
          `${(600 + i) * 1000}`,
          `h_z_${String(i).padStart(4, '0')}`,
        ),
      );
    }

    const { query } = makeUpdateQuery(rows, 1);
    const plugin = new TestPlugin(txRepo(), {}, query);
    await plugin.updateTransactions();

    expect(plugin.decoded).toHaveLength(rows.length);
    expect(new Set(plugin.decoded).size).toBe(rows.length);
    expect(plugin.decoded.filter((h) => h.startsWith('h_mb_'))).toHaveLength(
      10,
    );
  });

  it('advances the cursor by the last row of the page', async () => {
    const rows = Array.from({ length: 150 }, (_, i) =>
      makeTx(i + 1, `${(i + 1) * 1000}`, `h_${String(i).padStart(4, '0')}`),
    );

    const { query, cursors } = makeUpdateQuery(rows, 1);
    const plugin = new TestPlugin(txRepo(), {}, query);
    await plugin.updateTransactions();

    expect(cursors[0]).toBeUndefined();
    expect(cursors[1]).toEqual({
      block_height: BATCH_SIZE,
      micro_time: `${BATCH_SIZE * 1000}`,
      hash: 'h_0099',
    });
    expect(cursors).toHaveLength(2);
  });

  it('retires stamped rows, so a second sweep reads nothing', async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      makeTx(i + 1, `${(i + 1) * 1000}`, `h_${String(i).padStart(4, '0')}`),
    );

    const { query } = makeUpdateQuery(rows, 1);
    const plugin = new TestPlugin(txRepo(), {}, query);
    await plugin.updateTransactions();
    expect(plugin.decoded).toHaveLength(20);

    plugin.decoded = [];
    await plugin.updateTransactions();
    expect(plugin.decoded).toHaveLength(0);
  });

  it('re-reads rows whose decode yields nothing on every sweep', async () => {
    // Why social-graph and aex9-transfer get no sweep: their decode returns
    // null for part of its own selected set, and null writes no stamp.
    const rows = Array.from({ length: 20 }, (_, i) =>
      makeTx(i + 1, `${(i + 1) * 1000}`, `h_${String(i).padStart(4, '0')}`),
    );
    const undecodable = new Set(['h_0003', 'h_0007']);

    const { query, cursors } = makeUpdateQuery(rows, 1);
    const plugin = new TestPlugin(txRepo(), {}, query, undecodable);
    await plugin.updateTransactions();
    expect(plugin.decoded).toHaveLength(18);

    cursors.length = 0;
    await plugin.updateTransactions();
    // Second sweep still selects exactly the two that never got stamped.
    expect(cursors).toHaveLength(1);
    const remaining = await query({}, BATCH_SIZE, undefined);
    expect(remaining.map((tx: Tx) => tx.hash)).toEqual(['h_0003', 'h_0007']);
  });
});
