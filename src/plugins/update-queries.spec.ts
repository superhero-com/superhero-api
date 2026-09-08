import { Logger } from '@nestjs/common';
import { BclPlugin } from './bcl/bcl.plugin';
import { GovernancePlugin } from './governance/governance.plugin';
import { TxPageCursor } from './plugin.interface';

/**
 * Records the SQL fragments a getUpdateQueries() builder emits, so the tests can
 * assert on the shape of the generated query rather than on a live database.
 */
function recordingRepo() {
  const fragments: string[] = [];
  const params: Record<string, any> = {};
  const orderBys: string[] = [];
  const qb: any = {
    where: (sql: string, p?: any) => {
      fragments.push(sql);
      Object.assign(params, p || {});
      return qb;
    },
    andWhere: (sql: string, p?: any) => {
      fragments.push(sql);
      Object.assign(params, p || {});
      return qb;
    },
    orderBy: (col: string) => {
      orderBys.push(col);
      return qb;
    },
    addOrderBy: (col: string) => {
      orderBys.push(col);
      return qb;
    },
    take: () => qb,
    getMany: async () => [],
  };
  return {
    repo: { createQueryBuilder: () => qb } as any,
    fragments,
    params,
    orderBys,
  };
}

const CURSOR: TxPageCursor = {
  block_height: 1102282,
  micro_time: '1700000000000',
  hash: 'th_abc',
};

describe('plugin getUpdateQueries pagination', () => {
  const plugins: [string, any][] = [
    ['bcl', new BclPlugin({} as any, {} as any, {} as any, {} as any)],
    [
      'governance',
      new GovernancePlugin(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      ),
    ],
  ];

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  describe.each(plugins)('%s', (name, plugin) => {
    it('pages with a row constructor, never an OR chain', async () => {
      const { repo, fragments, params } = recordingRepo();
      const [query] = plugin.getUpdateQueries(1);
      await query(repo, 100, CURSOR);

      const cursorSql = fragments.find((f) => f.includes('cursorHeight'));
      expect(cursorSql).toBeDefined();

      // An OR chain cannot become an index lower bound: the scan then restarts
      // at the start of the index and discards every row before the cursor.
      expect(cursorSql).not.toMatch(/\bOR\b/);
      expect(cursorSql).toContain(
        '(tx.block_height, tx.micro_time, tx.hash) > (',
      );
      expect(params.cursorHash).toBe('th_abc');
    });

    it('includes hash in the sort key so a page cannot end mid-microblock', async () => {
      const { repo, orderBys } = recordingRepo();
      const [query] = plugin.getUpdateQueries(1);
      await query(repo, 100, CURSOR);

      expect(orderBys).toEqual(['tx.block_height', 'tx.micro_time', 'tx.hash']);
    });
  });

  it('bcl selects on logs, the only field it writes', async () => {
    const { repo, fragments } = recordingRepo();
    const plugin = new BclPlugin({} as any, {} as any, {} as any, {} as any);
    const [query] = plugin.getUpdateQueries(1);
    await query(repo, 100, undefined);

    const versionSql = fragments.find((f) => f.includes('_version'));
    expect(versionSql).toBeDefined();
    // BclPluginSyncService overrides decodeLogs only, so nothing ever writes
    // data->'bcl'; selecting on it re-reads every BCL tx on every restart.
    expect(versionSql).toContain("tx.logs->>'bcl'");
    expect(versionSql).not.toContain("tx.data->>'bcl'");
  });

  it('governance selects on data, which it does write', async () => {
    const { repo, fragments } = recordingRepo();
    const plugin = new GovernancePlugin(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const [query] = plugin.getUpdateQueries(1);
    await query(repo, 100, undefined);

    const versionSql = fragments.find((f) => f.includes('_version'));
    expect(versionSql).toContain("tx.data->>'governance'");
  });
});
