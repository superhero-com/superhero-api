import { Node } from '@aeternity/aepp-sdk';
import { SocialGraphReader, decimal } from './social-graph-reader';
import { CatchupPage } from './social-graph-catchup.service';

export class GraphReorgError extends Error {}
interface Cursor {
  micro: number;
  transaction: number;
}
export const FIRST_NODE_CURSOR = JSON.stringify({ micro: 0, transaction: 1 });

/** Enumerates the whole closed generation through node transaction indexes.
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
    if (BigInt(end.height) !== BigInt(start.height) + 1n)
      throw new Error('Node stream requires one closed generation');
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
    const closing = await this.node.getKeyBlockByHeight(Number(end.height));
    if (
      generation.keyBlock.hash !== start.hash ||
      closing.hash !== end.hash ||
      closing.prevKeyHash !== start.hash
    )
      throw new GraphReorgError('Generation anchor changed');
    const micros = generation.microBlocks;
    if (micros.length > 10000 || cursor.micro > micros.length)
      throw new Error('Invalid generation bounds');
    if (closing.prevHash !== (micros.at(-1) ?? start.hash))
      throw new GraphReorgError(
        'Generation is not closed at the expected block',
      );
    const transactions: CatchupPage['transactions'] = [];
    let budget = 100;
    while (cursor.micro < micros.length && budget > 0) {
      const hash = micros[cursor.micro];
      const [header, { count }] = await Promise.all([
        this.node.getMicroBlockHeaderByHash(hash),
        this.node.getMicroBlockTransactionsCountByHash(hash),
      ]);
      if (
        header.prevKeyHash !== start.hash ||
        header.prevHash !==
          (cursor.micro === 0 ? start.hash : micros[cursor.micro - 1]) ||
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
    if (
      (await this.node.getKeyBlockByHeight(Number(end.height))).hash !==
      end.hash
    )
      throw new GraphReorgError('Generation changed during read');
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
