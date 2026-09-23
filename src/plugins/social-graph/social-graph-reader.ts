import { SOCIAL_GRAPH_ABORT_STATUS } from './social-graph.errors';
import { normalizeEventTopics } from '@/utils/common';
import type { GraphMutation } from './social-graph-projection.service';
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Contract, Encoded, Node } from '@aeternity/aepp-sdk';
import aci from './aci/SocialContract.aci.json';
import build from './aci/SocialContract.build.json';

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

/** Read-only adapter. Multi-call views share one pinned state; snapshots use key blocks. */
export class SocialGraphReader {
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

  async migrationEvidence(
    policy: Awaited<ReturnType<SocialGraphReader['policy']>>,
  ) {
    const { SocialGraphLifecycle } = await import('./social-graph-lifecycle');
    return new SocialGraphLifecycle(this.node).verify(policy, {
      activationTx: process.env.SOCIAL_GRAPH_ACTIVATION_TX,
      freezeTx: process.env.SOCIAL_GRAPH_SOURCE_FREEZE_TX,
      legacySnapshotHash: process.env.SOCIAL_GRAPH_LEGACY_SNAPSHOT_HASH,
      legacyManifestHash: process.env.SOCIAL_GRAPH_LEGACY_MANIFEST_COMMITMENT,
    });
  }

  async verifyIdentity(): Promise<void> {
    await this.instance();
  }

  async assertCanonical(hash: string, height: string): Promise<void> {
    const n = Number(decimal(height));
    if (!Number.isSafeInteger(n)) throw new Error('Unsupported block height');
    if (hash.startsWith('mh_')) {
      const generation = await this.node.getGenerationByHeight(n);
      if (!generation.microBlocks.includes(hash as Encoded.MicroBlockHash))
        throw new Error('Snapshot is no longer canonical');
      return;
    }
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
    const block = await this.node.getTopHeader();
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

  async precheck(action: string, from: string, to: string) {
    if (
      !['follow', 'unfollow', 'block', 'unblock'].includes(action) ||
      [from, to].some((a) => !/^ak_[1-9A-HJ-NP-Za-km-z]+$/.test(a))
    )
      throw new BadRequestException('Invalid graph precheck');
    try {
      return await this.simulate(action, from, to);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException(
        'Graph simulation unavailable; retry with the wallet before signing',
      );
    }
  }

  private async simulate(action: string, from: string, to: string) {
    const c = await this.instance();
    const block = await this.node.getTopHeader();
    const policy = await c.get_policy({ top: block.hash, callStatic: true });
    // Do not use SDK $call here: it funds the caller during dry-run. A call request
    // retains the real caller balance and has no signer or broadcast path.
    const account = await this.node.getAccountByPubkeyAndHash(from, block.hash);
    if (account.kind === 'generalized')
      throw new ServiceUnavailableException(
        'Generalized-account precheck requires wallet authentication context',
      );
    const nonce = account.nonce + 1;
    if (!Number.isSafeInteger(nonce))
      throw new ServiceUnavailableException('Unsupported account nonce');
    const result = await this.node.protectedDryRunTxs({
      top: block.hash,
      accounts: [],
      txs: [
        {
          callReq: {
            contract: this.identity.contract,
            caller: from,
            calldata: c._calldata.encode(c._name, action, [to]),
            nonce,
            gas: 1500000,
            abiVersion: 3,
            context: { stateful: false },
          },
        },
      ],
    });
    const call =
      result.results?.length === 1 && result.results[0].result === 'ok'
        ? result.results[0].callObj
        : undefined;
    if (!call || !['ok', 'revert'].includes(call.returnType))
      throw new ServiceUnavailableException(
        'Graph simulation unavailable; retry with the wallet before signing',
      );
    const reason =
      call.returnType === 'revert'
        ? c._calldata.decodeFateString(call.returnValue)
        : null;
    const statuses = {
      ...SOCIAL_GRAPH_ABORT_STATUS,
      FROZEN: 409,
      IMPORTING: 409,
      LOW_BALANCE: 409,
    };
    if (reason && !Object.prototype.hasOwnProperty.call(statuses, reason))
      throw new ServiceUnavailableException(
        'Unrecognized graph simulation result',
      );
    return {
      ...this.identity,
      block_hash: block.hash,
      height: decimal(block.height),
      advisory: true,
      simulation: reason ? 'rejected' : 'passed',
      reason,
      suggested_http_status: reason ? statuses[reason] : null,
      config_version: decimal(policy.decodedResult[1]),
      gas_used: decimal(call.gasUsed),
    };
  }

  async countsAt(
    account: string,
    top: Encoded.KeyBlockHash | Encoded.MicroBlockHash,
  ) {
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

  async policy(state: 'key-block' | 'top' = 'key-block') {
    const c = await this.instance();
    // Interactive reads must include this generation's mined microblocks. Export
    // and projection checkpoints retain their canonical key-block boundary.
    const block =
      state === 'top'
        ? await this.node.getTopHeader()
        : await this.node.getCurrentKeyBlock();
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
      pending_config:
        policy.decodedResult[2] == null
          ? null
          : {
              config: serialize(policy.decodedResult[2][0]),
              activation_height: decimal(policy.decodedResult[2][1]),
            },
      owner: owner.decodedResult[0],
      pending_owner: owner.decodedResult[1] ?? null,
      successor: lifecycle.decodedResult[0]?.replace(/^ak_/, 'ct_') ?? null,
      freeze_height: decimal(lifecycle.decodedResult[1]),
      frozen: lifecycle.decodedResult[2],
      importing: lifecycle.decodedResult[3],
      import_source: source.decodedResult[0] ?? null,
      legacy_source: source.decodedResult[1]?.replace(/^ak_/, 'ct_') ?? null,
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
