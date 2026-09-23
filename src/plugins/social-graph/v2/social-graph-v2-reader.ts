import { normalizeEventTopics } from '@/utils/common';
import type { GraphMutation } from './social-graph-v2-projection.service';
import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Contract, Encoded, Node } from '@aeternity/aepp-sdk';
import aci from '../aci/SocialContractV2.aci.json';
import build from '../aci/SocialContractV2.build.json';

export interface GraphIdentity {
  network: string;
  contract: Encoded.ContractAddress;
}
export type GraphDirection = 'followers' | 'following' | 'blocked' | 'export';
export interface GraphCursor extends GraphIdentity {
  version: 2;
  direction: GraphDirection;
  account: string;
  top: Encoded.KeyBlockHash;
  offset: string;
}

export function decimal(value: unknown): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error('Unsafe chain integer');
  }
  const text = String(value);
  if (!/^(0|[1-9]\d*)$/.test(text)) throw new Error('Invalid chain integer');
  return text;
}

export function encodeGraphCursor(cursor: GraphCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}
export function decodeGraphCursor(
  token: string,
  scope: GraphIdentity & {
    direction: GraphDirection;
    account: string;
  },
): GraphCursor {
  if (token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token))
    throw new BadRequestException('Invalid graph cursor');
  let c: GraphCursor;
  try {
    c = JSON.parse(Buffer.from(token, 'base64url').toString());
  } catch {
    throw new BadRequestException('Invalid graph cursor');
  }
  if (!c || typeof c !== 'object')
    throw new BadRequestException('Invalid graph cursor');
  if (
    c.version !== 2 ||
    c.network !== scope.network ||
    c.contract !== scope.contract ||
    c.direction !== scope.direction ||
    c.account !== scope.account ||
    !/^kh_[1-9A-HJ-NP-Za-km-z]+$/.test(c.top)
  )
    throw new BadRequestException('Graph cursor scope mismatch');
  try {
    decimal(c.offset);
  } catch {
    throw new BadRequestException('Invalid graph cursor offset');
  }
  return c;
}

/** Read-only V2 adapter. Every multi-call view uses one key-block state. */
export class SocialGraphV2Reader {
  private contract?: Promise<any>;
  constructor(
    private readonly node: Node,
    readonly identity: GraphIdentity,
  ) {}

  private async instance(): Promise<any> {
    if (!this.contract) {
      this.contract = (async () => {
        const status = await this.node.getStatus();
        if (status.networkId !== this.identity.network)
          throw new Error('Social graph network mismatch');
        const { bytecode } = await this.node.getContractCode(
          this.identity.contract,
        );
        if (
          createHash('sha256').update(bytecode).digest('hex') !==
          build.bytecodeSha256
        ) {
          throw new Error('Unreviewed social graph bytecode');
        }
        return Contract.initialize({
          onNode: this.node,
          address: this.identity.contract,
          aci,
        });
      })().catch((error) => {
        this.contract = undefined;
        throw error;
      });
    }
    return this.contract;
  }

  async verifyIdentity(): Promise<void> {
    await this.instance();
  }

  async assertCanonical(hash: string, height: string): Promise<void> {
    const n = Number(decimal(height));
    if (!Number.isSafeInteger(n)) throw new Error('Unsupported block height');
    const block = await this.node.getKeyBlockByHeight(n);
    if (block.hash !== hash) throw new Error('Snapshot is no longer canonical');
  }

  async decodeLogs(logs: unknown[]) {
    const c = await this.instance();
    if (!Array.isArray(logs)) throw new Error('Invalid contract logs');
    const result: {
      index: number;
      name: string;
      changes: GraphMutation[];
      followAccount?: string;
    }[] = [];
    for (let index = 0; index < logs.length; index++) {
      const log: any = logs[index];
      // Internal calls can include events from several contracts. Only the selected
      // deployment can change this namespace; unknown selected-contract events fail.
      if (log?.address !== this.identity.contract) continue;
      const decoded = c.$decodeEvents(normalizeEventTopics([log]));
      if (!Array.isArray(decoded) || decoded.length !== 1)
        throw new Error('Invalid decoded event');
      const { name, args } = decoded[0];
      const changes: GraphMutation[] = [];
      if (['Followed', 'Unfollowed', 'Blocked', 'Unblocked'].includes(name)) {
        if (
          !Array.isArray(args) ||
          args.length !== 2 ||
          args.some(
            (a) =>
              typeof a !== 'string' || !/^ak_[1-9A-HJ-NP-Za-km-z]+$/.test(a),
          ) ||
          args[0] === args[1]
        )
          throw new Error('Invalid graph event accounts');
        changes.push({
          from: args[0],
          to: args[1],
          kind: ['Followed', 'Unfollowed'].includes(name) ? 'follow' : 'block',
          present: ['Followed', 'Blocked'].includes(name),
        });
      }
      result.push({
        index,
        name,
        changes,
        ...(name === 'Followed' ? { followAccount: args[0] } : {}),
      });
    }
    return result;
  }

  async relationship(from: string, to: string) {
    if ([from, to].some((a) => !/^ak_[1-9A-HJ-NP-Za-km-z]+$/.test(a)))
      throw new BadRequestException('Invalid graph account');
    const c = await this.instance();
    const block = await this.node.getCurrentKeyBlock();
    const options = { top: block.hash, callStatic: true };
    const [relation, lifecycle] = await Promise.all([
      c.get_relationship(from, to, options),
      c.get_lifecycle(options),
    ]);
    return {
      ...this.identity,
      from,
      to,
      block_hash: block.hash,
      height: decimal(block.height),
      ...relation.decodedResult,
      frozen: lifecycle.decodedResult[2],
      importing: lifecycle.decodedResult[3],
      advisory: true,
    };
  }

  async countsAt(account: string, top: Encoded.KeyBlockHash) {
    if (!/^ak_[1-9A-HJ-NP-Za-km-z]+$/.test(account))
      throw new BadRequestException('Invalid graph account');
    const c = await this.instance();
    const options = { top, callStatic: true };
    const values = await Promise.all([
      c.get_followers_count(account, options),
      c.get_following_count(account, options),
      c.get_blocked_count(account, options),
    ]);
    return {
      followers: decimal(values[0].decodedResult),
      following: decimal(values[1].decodedResult),
      blocked: decimal(values[2].decodedResult),
    };
  }

  async policy() {
    const c = await this.instance();
    const block = await this.node.getCurrentKeyBlock();
    const options = { top: block.hash, callStatic: true };
    const [policy, owner, lifecycle, source] = await Promise.all([
      c.get_policy(options),
      c.get_owner(options),
      c.get_lifecycle(options),
      c.get_import_source(options),
    ]);
    // Preserve arbitrary-size Sophia integers as decimal strings, including pending policy.
    const serialize = (value: unknown) =>
      JSON.parse(
        JSON.stringify(value ?? null, (_, item) =>
          typeof item === 'bigint' ? item.toString() : item,
        ),
      );
    return {
      ...this.identity,
      version: 2,
      block_hash: block.hash,
      height: decimal(block.height),
      config: serialize(policy.decodedResult[0]),
      config_version: decimal(policy.decodedResult[1]),
      pending_config: serialize(policy.decodedResult[2]),
      owner: owner.decodedResult[0],
      pending_owner: owner.decodedResult[1] ?? null,
      successor: lifecycle.decodedResult[0] ?? null,
      freeze_height: decimal(lifecycle.decodedResult[1]),
      frozen: lifecycle.decodedResult[2],
      importing: lifecycle.decodedResult[3],
      import_source: source.decodedResult[0] ?? null,
      legacy_source: source.decodedResult[1] ?? null,
      source_sha256: build.sourceSha256,
    };
  }

  async page(
    direction: GraphDirection,
    account: string,
    limit: number,
    token?: string,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException('Invalid page limit');
    if (direction !== 'export' && !/^ak_[1-9A-HJ-NP-Za-km-z]+$/.test(account))
      throw new BadRequestException('Invalid graph account');
    const c = await this.instance();
    const scope = {
      ...this.identity,
      direction,
      account: direction === 'export' ? '' : account,
    };
    const cursor = token
      ? decodeGraphCursor(token, scope)
      : {
          ...scope,
          version: 2 as const,
          top: (await this.node.getCurrentKeyBlock())
            .hash as Encoded.KeyBlockHash,
          offset: '0',
        };
    const options = { top: cursor.top, callStatic: true };
    const method =
      direction === 'export' ? 'export_page' : `get_${direction}_page`;
    const args =
      direction === 'export'
        ? [BigInt(cursor.offset), limit]
        : [account, BigInt(cursor.offset), limit];
    const page = (await c[method](...args, options)).decodedResult;
    const next = decimal(page.next_cursor),
      end = decimal(page.end_cursor);
    if (
      BigInt(next) < BigInt(cursor.offset) ||
      BigInt(next) > BigInt(end) ||
      BigInt(next) - BigInt(cursor.offset) > BigInt(limit) ||
      (next !== end && next === cursor.offset) ||
      !Array.isArray(page.items) ||
      page.items.length > limit
    ) {
      throw new Error('Invalid contract page progress');
    }
    return {
      ...this.identity,
      block_hash: cursor.top,
      items: JSON.parse(
        JSON.stringify(page.items, (_, v) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
      ),
      next_cursor:
        next === end ? null : encodeGraphCursor({ ...cursor, offset: next }),
      end_cursor: end,
    };
  }
}
