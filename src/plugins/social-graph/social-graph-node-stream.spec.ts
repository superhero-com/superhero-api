import {
  FIRST_NODE_CURSOR,
  SocialGraphNodeStream,
} from './social-graph-node-stream';

function fixture(count = 1) {
  const node: any = {
    getGenerationByHeight: jest.fn().mockResolvedValue({
      keyBlock: { hash: 'kh_start' },
      microBlocks: ['mh_one'],
    }),
    getKeyBlockByHeight: jest.fn().mockResolvedValue({
      hash: 'kh_end',
      height: 101,
      prevKeyHash: 'kh_start',
      prevHash: 'mh_one',
    }),
    getMicroBlockHeaderByHash: jest.fn().mockResolvedValue({
      hash: 'mh_one',
      height: 100,
      prevKeyHash: 'kh_start',
      prevHash: 'kh_start',
    }),
    getMicroBlockTransactionsCountByHash: jest
      .fn()
      .mockResolvedValue({ count }),
    getMicroBlockTransactionByHashAndIndex: jest
      .fn()
      .mockImplementation(async (_hash, index) => ({
        hash: `th_${index}`,
        blockHash: 'mh_one',
        blockHeight: 100,
        tx: { type: 'ContractCallTx', contractId: 'ct_wrapper' },
      })),
    getTransactionInfoByHash: jest.fn().mockResolvedValue({
      callInfo: { returnType: 'ok', log: [{ address: 'ct_selected' }] },
    }),
  };
  const reader: any = {
    decodeLogs: jest.fn().mockResolvedValue([
      {
        index: 0,
        changes: [{ from: 'ak_a', to: 'ak_b', kind: 'follow', present: true }],
      },
    ]),
  };
  return {
    node,
    reader,
    start: { hash: 'kh_start', height: '100' },
    end: { hash: 'kh_end', height: '101' },
  };
}

describe('Social graph canonical node stream', () => {
  it('ingests an open microblock, resumes at the next microblock, and closes without replay', async () => {
    const f = fixture(),
      stream = new SocialGraphNodeStream(f.node);
    const first = await stream.page(
      f.reader,
      f.start,
      { hash: 'mh_one', height: '100' },
      FIRST_NODE_CURSOR,
    );
    expect(first.transactions.map((tx) => tx.hash)).toEqual(['th_1']);
    expect(first.nextCursor).toBeNull();
    expect(f.node.getKeyBlockByHeight).not.toHaveBeenCalled();
    f.node.getGenerationByHeight.mockResolvedValue({
      keyBlock: { hash: 'kh_start' },
      microBlocks: ['mh_one', 'mh_two'],
    });
    f.node.getMicroBlockHeaderByHash.mockResolvedValue({
      height: 100,
      prevHash: 'mh_one',
      prevKeyHash: 'kh_start',
    });
    f.node.getMicroBlockTransactionByHashAndIndex.mockResolvedValue({
      hash: 'th_unfollow',
      blockHash: 'mh_two',
      blockHeight: 100,
      tx: { type: 'ContractCallTx' },
    });
    const second = await stream.page(
      f.reader,
      { hash: 'mh_one', height: '100' },
      { hash: 'mh_two', height: '100' },
      FIRST_NODE_CURSOR,
    );
    expect(second.transactions.map((tx) => tx.hash)).toEqual(['th_unfollow']);
    expect(BigInt(second.transactions[0].position)).toBeGreaterThan(
      BigInt(first.transactions[0].position),
    );
    f.node.getKeyBlockByHeight.mockResolvedValue({
      hash: 'kh_end',
      prevKeyHash: 'kh_start',
      prevHash: 'mh_two',
    });
    const closed = await stream.page(
      f.reader,
      { hash: 'mh_two', height: '100' },
      f.end,
      FIRST_NODE_CURSOR,
    );
    expect(closed.transactions).toEqual([]);
    expect(closed.nextCursor).toBeNull();
  });
  it('resumes a large open microblock within the bounded page budget', async () => {
    const f = fixture(105),
      stream = new SocialGraphNodeStream(f.node);
    const end = { hash: 'mh_one', height: '100' };
    const first = await stream.page(f.reader, f.start, end, FIRST_NODE_CURSOR);
    const second = await stream.page(f.reader, f.start, end, first.nextCursor!);
    expect(first.transactions).toHaveLength(99);
    expect(second.transactions).toHaveLength(6);
    expect(
      new Set(
        [...first.transactions, ...second.transactions].map((tx) => tx.hash),
      ).size,
    ).toBe(105);
  });
  it('rejects orphaned microblock watermarks and forks during an open-prefix read', async () => {
    const f = fixture(),
      stream = new SocialGraphNodeStream(f.node);
    await expect(
      stream.page(
        f.reader,
        { hash: 'mh_orphan', height: '100' },
        f.end,
        FIRST_NODE_CURSOR,
      ),
    ).rejects.toThrow('anchor changed');
    await expect(
      stream.page(
        f.reader,
        f.start,
        { hash: 'mh_orphan', height: '100' },
        FIRST_NODE_CURSOR,
      ),
    ).rejects.toThrow('endpoint changed');
    f.node.getGenerationByHeight
      .mockResolvedValueOnce({
        keyBlock: { hash: 'kh_start' },
        microBlocks: ['mh_one'],
      })
      .mockResolvedValueOnce({
        keyBlock: { hash: 'kh_start' },
        microBlocks: ['mh_fork'],
      });
    await expect(
      stream.page(
        f.reader,
        f.start,
        { hash: 'mh_one', height: '100' },
        FIRST_NODE_CURSOR,
      ),
    ).rejects.toThrow('changed during');
  });
  it('includes indirect contract calls, uses one-based indexes, and resumes without splitting transactions', async () => {
    const f = fixture(105),
      stream = new SocialGraphNodeStream(f.node);
    const first = await stream.page(
      f.reader,
      f.start,
      f.end,
      FIRST_NODE_CURSOR,
    );
    expect(first.transactions).toHaveLength(99);
    expect(
      f.node.getMicroBlockTransactionByHashAndIndex,
    ).toHaveBeenNthCalledWith(1, 'mh_one', 1);
    expect(first.transactions[0].events).toHaveLength(1);
    const last = await stream.page(f.reader, f.start, f.end, first.nextCursor!);
    expect(last.transactions).toHaveLength(6);
    expect(last.transactions[0].hash).toBe('th_100');
    expect(last.nextCursor).toBeNull();
    expect(BigInt(last.transactions[0].position)).toBeGreaterThan(
      BigInt(first.transactions.at(-1)!.position),
    );
  });
  it('rejects incomplete ancestry and a changed closing anchor', async () => {
    const f = fixture(),
      stream = new SocialGraphNodeStream(f.node);
    f.node.getMicroBlockHeaderByHash.mockResolvedValueOnce({
      prevHash: 'mh_missing',
      prevKeyHash: 'kh_start',
      height: 100,
    });
    await expect(
      stream.page(f.reader, f.start, f.end, FIRST_NODE_CURSOR),
    ).rejects.toThrow('ancestry');
    f.node.getKeyBlockByHeight
      .mockResolvedValueOnce({
        hash: 'kh_end',
        prevKeyHash: 'kh_start',
        prevHash: 'mh_one',
      })
      .mockResolvedValueOnce({ hash: 'kh_reorg' });
    await expect(
      stream.page(f.reader, f.start, f.end, FIRST_NODE_CURSOR),
    ).rejects.toThrow('changed during');
  });
  it('suppresses reverted wrapper effects and decodes successful GA inner receipts', async () => {
    const f = fixture(),
      stream = new SocialGraphNodeStream(f.node);
    f.node.getTransactionInfoByHash.mockResolvedValueOnce({
      gaInfo: { returnType: 'error' },
    });
    expect(
      (await stream.page(f.reader, f.start, f.end, FIRST_NODE_CURSOR))
        .transactions[0].events,
    ).toEqual([]);
    f.node.getTransactionInfoByHash.mockResolvedValueOnce({
      gaInfo: {
        returnType: 'ok',
        innerObject: { callInfo: { returnType: 'ok', log: [] } },
      },
    });
    await stream.page(f.reader, f.start, f.end, FIRST_NODE_CURSOR);
    expect(f.reader.decodeLogs).toHaveBeenCalledTimes(1);
    f.node.getTransactionInfoByHash.mockResolvedValueOnce({});
    await expect(
      stream.page(f.reader, f.start, f.end, FIRST_NODE_CURSOR),
    ).rejects.toThrow('Unsupported contract receipt');
  });
  it('skips sponsored spends but includes sponsored calls and GA attachment initialization', async () => {
    const f = fixture(),
      stream = new SocialGraphNodeStream(f.node);
    f.node.getMicroBlockTransactionByHashAndIndex.mockResolvedValueOnce({
      hash: 'th_spend',
      blockHash: 'mh_one',
      blockHeight: 100,
      tx: { type: 'PayingForTx', tx: { tx: { type: 'SpendTx' } } },
    });
    expect(
      (await stream.page(f.reader, f.start, f.end, FIRST_NODE_CURSOR))
        .transactions[0].events,
    ).toEqual([]);
    expect(f.node.getTransactionInfoByHash).not.toHaveBeenCalled();
    for (const tx of [
      { type: 'PayingForTx', tx: { tx: { type: 'ContractCallTx' } } },
      { type: 'GAAttachTx' },
    ]) {
      f.node.getMicroBlockTransactionByHashAndIndex.mockResolvedValueOnce({
        hash: 'th_effect',
        blockHash: 'mh_one',
        blockHeight: 100,
        tx,
      });
      expect(
        (await stream.page(f.reader, f.start, f.end, FIRST_NODE_CURSOR))
          .transactions[0].events,
      ).toHaveLength(1);
    }
  });
  it('rejects incomplete GA contract receipts instead of losing their effects', async () => {
    const f = fixture(),
      stream = new SocialGraphNodeStream(f.node);
    f.node.getTransactionInfoByHash.mockResolvedValue({
      gaInfo: { returnType: 'ok', innerObject: { txInfo: 'contract_call_tx' } },
    });
    await expect(
      stream.page(f.reader, f.start, f.end, FIRST_NODE_CURSOR),
    ).rejects.toThrow('Unsupported contract receipt');
  });
});
