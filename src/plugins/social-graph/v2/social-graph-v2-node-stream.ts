import { Node } from '@aeternity/aepp-sdk';
import { SocialGraphV2Reader, decimal } from './social-graph-v2-reader';
import { CatchupPage } from './social-graph-v2-catchup.service';

export class GraphReorgError extends Error {}
interface Cursor {
  micro: number;
  transaction: number;
}
export const FIRST_NODE_CURSOR = JSON.stringify({ micro: 0, transaction: 1 });

/** Enumerates the whole closed generation through node transaction indexes.
 * Internal calls are included, without relying on a middleware destination filter. */
export class SocialGraphV2NodeStream {
  constructor(private readonly node: Node) {}

  async anchor(height: string) {
    const n = Number(decimal(height));
    if (!Number.isSafeInteger(n)) throw new Error('Unsupported block height');
    const block = await this.node.getKeyBlockByHeight(n);
    return { hash: block.hash, height: decimal(block.height) };
  }

  async page(
    reader: SocialGraphV2Reader,
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
    let budget = 20;
    while (cursor.micro < micros.length && budget > 0) {
      const hash = micros[cursor.micro];
      const header = await this.node.getMicroBlockHeaderByHash(hash);
      if (
        header.prevKeyHash !== start.hash ||
        header.prevHash !==
          (cursor.micro === 0 ? start.hash : micros[cursor.micro - 1]) ||
        decimal(header.height) !== start.height
      )
        throw new GraphReorgError('Invalid micro block ancestry');
      const { count } =
        await this.node.getMicroBlockTransactionsCountByHash(hash);
      if (
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count >= 2 ** 32 ||
        cursor.transaction > count + 1
      )
        throw new Error('Invalid transaction count');
      // Empty micro blocks also consume budget, bounding work even without events.
      budget--;
      while (cursor.transaction <= count && budget > 0) {
        const tx = await this.node.getMicroBlockTransactionByHashAndIndex(
          hash,
          cursor.transaction,
        );
        if (tx.blockHash !== hash || decimal(tx.blockHeight) !== start.height)
          throw new GraphReorgError('Transaction block changed');
        let events: CatchupPage['transactions'][number]['events'] = [];
        if (
          [
            'ContractCallTx',
            'ContractCreateTx',
            'GAMetaTx',
            'PayingForTx',
          ].includes(tx.tx.type)
        ) {
          let info: any = await this.node.getTransactionInfoByHash(tx.hash);
          let depth = 0;
          while (info.gaInfo) {
            if (++depth > 32) throw new Error('Unsupported nested receipt');
            if (info.gaInfo.returnType !== 'ok') {
              info = {};
              break;
            }
            info = info.gaInfo.innerObject;
            if (!info) throw new Error('Missing inner receipt');
          }
          if (info.callInfo?.returnType === 'ok')
            events = await reader.decodeLogs(info.callInfo.log);
          // A success wrapper with an unrecognised receipt must not hide graph writes.
          if (!info.callInfo && !info.txInfo && depth === 0)
            throw new Error('Unsupported contract receipt');
        }
        transactions.push({
          hash: tx.hash,
          height: start.height,
          position: (
            (BigInt(start.height) << 64n) +
            (BigInt(cursor.micro) << 32n) +
            BigInt(cursor.transaction)
          ).toString(),
          events,
        });
        cursor.transaction++;
        budget--;
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
}
