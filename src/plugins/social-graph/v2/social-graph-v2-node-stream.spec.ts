import {
  FIRST_NODE_CURSOR,
  SocialGraphV2NodeStream,
} from './social-graph-v2-node-stream';

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

describe('V2 canonical node stream', () => {
  it('includes indirect contract calls, uses one-based indexes, and resumes without splitting transactions', async () => {
    const f = fixture(105),
      stream = new SocialGraphV2NodeStream(f.node);
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
      stream = new SocialGraphV2NodeStream(f.node);
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
      stream = new SocialGraphV2NodeStream(f.node);
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
      stream = new SocialGraphV2NodeStream(f.node);
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
      stream = new SocialGraphV2NodeStream(f.node);
    f.node.getTransactionInfoByHash.mockResolvedValue({
      gaInfo: { returnType: 'ok', innerObject: { txInfo: 'contract_call_tx' } },
    });
    await expect(
      stream.page(f.reader, f.start, f.end, FIRST_NODE_CURSOR),
    ).rejects.toThrow('Unsupported contract receipt');
  });
});
