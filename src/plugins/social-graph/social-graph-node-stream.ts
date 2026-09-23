import { Node } from '@aeternity/aepp-sdk';
import { SocialGraphReader, decimal } from './social-graph-reader';
import { CatchupPage } from './social-graph-catchup.service';

export class GraphReorgError extends Error {}
interface Cursor {
  micro: number;
  transaction: number;
}
export const FIRST_NODE_CURSOR = JSON.stringify({ micro: 0, transaction: 1 });

/** Enumerates a canonical generation or a pinned microblock prefix through node indexes.
 * Internal calls are included, without relying on a middleware destination filter. */
export class SocialGraphNodeStream {
  constructor(private readonly node: Node) {}

  async anchor(height: string) {
    const n = Number(decimal(height));
    if (!Number.isSafeInteger(n)) throw new Error('Unsupported block height');
    const block = await this.node.getKeyBlockByHeight(n);
    return { hash: block.hash, height: decimal(block.height) };
  }

  async page(
    reader: SocialGraphReader,
    start: { hash: string; height: string },
    end: { hash: string; height: string },
    token: string,
  ): Promise<CatchupPage> {
    const microEnd = end.hash.startsWith('mh_');
    if (BigInt(end.height) !== BigInt(start.height) + (microEnd ? 0n : 1n))
      throw new Error(
        'Node stream requires one generation or microblock prefix',
      );
    const cursor: Cursor = JSON.parse(token);
    if (
      !Number.isSafeInteger(cursor.micro) ||
      cursor.micro < 0 ||
      !Number.isSafeInteger(cursor.transaction) ||
      cursor.transaction < 1
    )
      throw new Error('Invalid node cursor');
    const generation = await this.node.getGenerationByHeight(
      Number(start.height),
    );
    const keyHash = generation.keyBlock.hash;
    const startMicro = start.hash.startsWith('mh_')
      ? generation.microBlocks.indexOf(start.hash as any)
      : -1;
    if (
      (start.hash.startsWith('mh_') && startMicro < 0) ||
      (!start.hash.startsWith('mh_') && keyHash !== start.hash)
    )
      throw new GraphReorgError('Generation anchor changed');
    let micros = generation.microBlocks;
    if (micros.length > 10000) throw new Error('Invalid generation bounds');
    if (microEnd) {
      const endMicro = micros.indexOf(end.hash as any);
      if (endMicro <= startMicro)
        throw new GraphReorgError('Microblock endpoint changed');
      micros = micros.slice(0, endMicro + 1);
    } else {
      const closing = await this.node.getKeyBlockByHeight(Number(end.height));
      if (closing.hash !== end.hash || closing.prevKeyHash !== keyHash)
        throw new GraphReorgError('Generation anchor changed');
      if (closing.prevHash !== (micros.at(-1) ?? keyHash))
        throw new GraphReorgError(
          'Generation is not closed at the expected block',
        );
    }
    // A completed microblock watermark already includes every transaction in it.
    if (token === FIRST_NODE_CURSOR) cursor.micro = startMicro + 1;
    if (cursor.micro < startMicro + 1 || cursor.micro > micros.length)
      throw new Error('Invalid generation bounds');
    const transactions: CatchupPage['transactions'] = [];
    let budget = 100;
    while (cursor.micro < micros.length && budget > 0) {
      const hash = micros[cursor.micro];
      const [header, { count }] = await Promise.all([
        this.node.getMicroBlockHeaderByHash(hash),
        this.node.getMicroBlockTransactionsCountByHash(hash),
      ]);
      if (
        header.prevKeyHash !== keyHash ||
        header.prevHash !==
          (cursor.micro === 0 ? keyHash : micros[cursor.micro - 1]) ||
        decimal(header.height) !== start.height
      )
        throw new GraphReorgError('Invalid micro block ancestry');
      if (
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count >= 2 ** 32 ||
        cursor.transaction > count + 1
      )
        throw new Error('Invalid transaction count');
      budget--;
      while (cursor.transaction <= count && budget > 0) {
        const size = Math.min(8, budget, count - cursor.transaction + 1);
        const batch = await Promise.all(
          Array.from({ length: size }, async (_, offset) => {
            const index = cursor.transaction + offset;
            const tx = await this.node.getMicroBlockTransactionByHashAndIndex(
              hash,
              index,
            );
            if (
              tx.blockHash !== hash ||
              decimal(tx.blockHeight) !== start.height
            )
              throw new GraphReorgError('Transaction block changed');
            const events = await this.transactionEvents(reader, tx);
            return {
              hash: tx.hash,
              height: start.height,
              position: (
                (BigInt(start.height) << 64n) +
                (BigInt(cursor.micro) << 32n) +
                BigInt(index)
              ).toString(),
              events,
            };
          }),
        );
        transactions.push(...batch);
        cursor.transaction += size;
        budget -= size;
      }
      if (cursor.transaction > count) {
        cursor.micro++;
        cursor.transaction = 1;
      }
    }
    if (microEnd) {
      const current = await this.node.getGenerationByHeight(Number(end.height));
      if (
        current.keyBlock.hash !== keyHash ||
        current.microBlocks[micros.length - 1] !== end.hash
      )
        throw new GraphReorgError('Generation changed during read');
    } else if (
      (await this.node.getKeyBlockByHeight(Number(end.height))).hash !==
      end.hash
    ) {
      throw new GraphReorgError('Generation changed during read');
    }
    return {
      expectedCursor: token,
      nextCursor:
        cursor.micro === micros.length ? null : JSON.stringify(cursor),
      transactions,
    };
  }
  private async transactionEvents(
    reader: SocialGraphReader,
    signed: any,
  ): Promise<CatchupPage['transactions'][number]['events']> {
    let inner = signed.tx;
    let depth = 0;
    // Sponsored spends have no contract receipt; asking for one returns 400.
    while (inner?.type === 'PayingForTx') {
      if (++depth > 32 || !inner.tx)
        throw new Error('Unsupported sponsored wrapper');
      inner = inner.tx.tx ?? inner.tx;
    }
    if (
      ![
        'ContractCallTx',
        'ContractCreateTx',
        'GAMetaTx',
        'GAAttachTx',
      ].includes(inner?.type)
    )
      return [];
    let info: any = await this.node.getTransactionInfoByHash(signed.hash);
    depth = 0;
    while (info.gaInfo) {
      if (++depth > 32) throw new Error('Unsupported nested receipt');
      if (info.gaInfo.returnType !== 'ok') return [];
      info = info.gaInfo.innerObject;
      if (!info) throw new Error('Missing inner receipt');
    }
    if (info.callInfo?.returnType === 'ok')
      return reader.decodeLogs(info.callInfo.log);
    if (info.callInfo && ['error', 'revert'].includes(info.callInfo.returnType))
      return [];
    if (info.txInfo && !/contract|ga_attach/.test(info.txInfo)) return [];
    throw new Error('Unsupported contract receipt');
  }
}
