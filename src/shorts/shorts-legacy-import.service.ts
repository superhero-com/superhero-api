import { Injectable } from '@nestjs/common';
import {
  AccountMemory,
  buildContractId,
  AeSdk,
  Contract,
  decode,
  encode,
  Encoding,
} from '@aeternity/aepp-sdk';
import { createHash } from 'node:crypto';
import {
  shortsArtifact,
  shortsConfigJson,
  shortsRelease,
  ShortsRelease,
} from './shorts-release';
import { ShortsNodeAccessService } from './shorts-node-access.service';
import { readShortsJson } from './shorts-upstream';
import { receiptHash } from './shorts-receipts.service';

export interface LegacyImportConfig {
  releaseFile: string;
  artifactFile: string;
  sources: {
    contract: string;
    kind: 'platform' | 'prepaid';
    creationTx: string;
    artifactFile: string;
  }[];
}
export interface LegacySnapshot {
  version: 1;
  network: string;
  destination: string;
  source: string;
  sourceCodeHash: string;
  cutoff: { height: number; hash: string };
  videos: {
    id: string;
    creator: string;
    cid: string;
    size: string;
    withdrawn: boolean;
    likes: string[];
  }[];
  sourceCounts: {
    contract: string;
    id: string;
    scalarLikes: string;
    eventLikes: number;
  }[];
  transactions: string[];
  commitment: string;
}
const json = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const canonical = (value: any): any => {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
};
const same = (a: unknown, b: unknown) =>
  json(canonical(a)) === json(canonical(b));

/** Explicit owner operation. Legacy commitments attest an exhaustively checked cutoff,
 * not a freeze or proof of the older contract. Never runs in the serving API. */
@Injectable()
export class ShortsLegacyImportService {
  progress: (message: string) => void = () => undefined;
  private release: ShortsRelease;
  private sdk: AeSdk;
  private destination: Contract<any>;
  private sources: {
    contract: Contract<any>;
    kind: 'platform' | 'prepaid';
    creationHeight: number;
  }[];
  constructor(private readonly access: ShortsNodeAccessService) {}

  async initialize(config: LegacyImportConfig, keyFile?: string) {
    this.release = shortsRelease(
      await shortsConfigJson(config.releaseFile),
      true,
    );
    const r = this.release;
    if (r.network !== 'ae_uat' || r.schemaVersion !== 2 || !r.previousContract)
      throw new Error(
        'Legacy import requires an explicit V2 testnet destination',
      );
    const identities = [
      { contract: r.previousContract, ...r.previousArtifact },
      ...(r.rewardContracts ?? []),
    ];
    if (
      !Array.isArray(config.sources) ||
      config.sources.length !== identities.length ||
      config.sources[0]?.contract !== r.previousContract ||
      new Set(config.sources.map((s) => s.contract)).size !==
        config.sources.length
    )
      throw new Error(
        'Every pinned predecessor must be inventoried exactly once',
      );
    const account = keyFile
      ? new AccountMemory((await shortsConfigJson(keyFile, true)).secretKey)
      : undefined;
    this.sdk = new AeSdk({
      nodes: [
        {
          name: r.network,
          instance: this.access.createNode(r.node, !!account),
        },
      ],
      accounts: account ? [account] : [],
      interval: 1500,
    });
    if (
      (await this.retryRead(() => this.sdk.api.getStatus())).networkId !==
      r.network
    )
      throw new Error('Migration node network mismatch');
    const artifact = shortsArtifact(
      await shortsConfigJson(config.artifactFile),
      r,
    );
    this.destination = await Contract.initialize({
      ...this.sdk.getContext(),
      aci: artifact.aci,
      address: r.contract,
    });
    if (
      digest((await this.sdk.api.getContractCode(r.contract)).bytecode) !==
      r.bytecodeHash
    )
      throw new Error('Migration destination code mismatch');
    if (BigInt(await this.read(this.destination, 'schema_version')) !== 2n)
      throw new Error('Migration schema mismatch');
    if (
      account &&
      (await this.read(this.destination, 'get_owner'))[0] !== account.address
    )
      throw new Error('Migration signing account is not the owner');
    this.sources = [];
    for (const source of config.sources) {
      const identity = identities.find((i) => i.contract === source.contract);
      if (!identity || !['platform', 'prepaid'].includes(source.kind))
        throw new Error('Unpinned migration source');
      const old = shortsArtifact(
        await shortsConfigJson(source.artifactFile),
        identity,
      );
      if (
        digest(
          (await this.sdk.api.getContractCode(source.contract)).bytecode,
        ) !== identity.bytecodeHash
      )
        throw new Error('Migration source code mismatch');
      const contract = await Contract.initialize({
        ...this.sdk.getContext(),
        aci: old.aci,
        address: source.contract as `ct_${string}`,
      });
      receiptHash(source.creationTx);
      const creation = await this.retryRead(() =>
        this.sdk.api.getTransactionByHash(source.creationTx as `th_${string}`),
      );
      const call = creation.tx as any;
      const info = await this.retryRead(() =>
        this.sdk.api.getTransactionInfoByHash(
          source.creationTx as `th_${string}`,
        ),
      );
      const generation = await this.retryRead(() =>
        this.sdk.api.getGenerationByHeight(creation.blockHeight),
      );
      if (
        creation.hash !== source.creationTx ||
        call.type !== 'ContractCreateTx' ||
        buildContractId(call.ownerId, call.nonce) !== source.contract ||
        digest(call.code) !== identity.bytecodeHash ||
        creation.blockHeight < 0 ||
        !generation.microBlocks.includes(
          creation.blockHash as `mh_${string}`,
        ) ||
        info.callInfo?.returnType !== 'ok' ||
        info.callInfo.contractId !== source.contract
      )
        throw new Error('Unverified legacy creation transaction');
      this.sources.push({
        contract,
        kind: source.kind,
        creationHeight: creation.blockHeight,
      });
    }
    // This legacy adapter supports a platform contract and its terminal prepaid predecessor.
    // A different predecessor topology requires its own verified inventory adapter.
    if (
      this.sources.length !== 2 ||
      this.sources[0].kind !== 'platform' ||
      this.sources[1].kind !== 'prepaid' ||
      (await this.read(this.sources[0].contract, 'get_previous')) !==
        this.sources[1].contract.$options.address
    )
      throw new Error('Unsupported legacy predecessor topology');
  }
  private async retryRead<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  private read(
    contract: Contract<any>,
    method: string,
    args: unknown[] = [],
    top?: string,
  ): Promise<any> {
    return this.retryRead(() =>
      this.access.read(
        async () =>
          (
            await contract.$call(method, args, {
              callStatic: true,
              ...(top ? { top: top as `kh_${string}` } : {}),
            })
          ).decodedResult,
      ),
    );
  }
  private async mdw(path: string) {
    const base = new URL(this.release.middleware);
    const url = new URL(
      path.startsWith('/v3/') ? this.release.middleware + path : path,
    );
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/v3/') ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('Migration middleware cursor escaped its origin');
    return this.retryRead(async () => {
      const signal = AbortSignal.timeout(60000);
      const response = await fetch(url, { signal, redirect: 'error' });
      if (!response.ok) {
        void response.body?.cancel();
        throw new Error('Migration middleware unavailable');
      }
      return readShortsJson(response, 5242880, signal);
    });
  }
  async canonical(cutoff: LegacySnapshot['cutoff']) {
    receiptHash(cutoff.hash, 'kh_');
    const [node, status, mdw, tip] = await Promise.all([
      this.retryRead(() => this.sdk.api.getKeyBlockByHeight(cutoff.height)),
      this.retryRead(() => this.sdk.api.getStatus()),
      this.mdw(`/v3/key-blocks/${cutoff.height}`),
      this.retryRead(() => this.sdk.api.getCurrentKeyBlock()),
    ]);
    if (
      status.networkId !== this.release.network ||
      node.hash !== cutoff.hash ||
      mdw.hash !== cutoff.hash ||
      node.height !== cutoff.height ||
      tip.height - cutoff.height < 3
    )
      throw new Error('Migration cutoff is not canonical and confirmed');
  }
  async snapshot(cutoff?: LegacySnapshot['cutoff']): Promise<LegacySnapshot> {
    if (!cutoff) {
      const [tip, mdw] = await Promise.all([
        this.retryRead(() => this.sdk.api.getCurrentKeyBlock()),
        this.mdw('/v3/status'),
      ]);
      const height = Math.min(tip.height, mdw.mdw_height) - 3;
      if (!Number.isSafeInteger(height) || height < 1)
        throw new Error('Migration history is unavailable');
      const block = await this.retryRead(() =>
        this.sdk.api.getKeyBlockByHeight(height),
      );
      cutoff = { height, hash: block.hash };
    }
    await this.canonical(cutoff);
    this.progress(`Fixed cutoff ${cutoff.height} ${cutoff.hash}`);
    const videos = new Map<string, LegacySnapshot['videos'][number]>();
    const sourceCounts: LegacySnapshot['sourceCounts'] = [];
    const transactions = new Set<string>();
    for (const source of this.sources) {
      const address = source.contract.$options.address;
      if (source.creationHeight >= cutoff.height)
        throw new Error('Cutoff predates source creation');
      const scope = `gen:${source.creationHeight}-${cutoff.height - 1}`;
      let cursor: string | null =
        `/v3/contracts/logs?contract_id=${address}&direction=forward&limit=25&scope=${scope}`;
      const seenPages = new Set<string>();
      const seenLogs = new Set<string>();
      const published = new Set<string>();
      const withdrawn = new Set<string>();
      const likes = new Map<string, Set<string>>();
      const calls = new Map<string, any>();
      while (cursor) {
        if (seenPages.has(cursor) || seenPages.size >= 1000)
          throw new Error('Migration inventory exceeded its page bound');
        seenPages.add(cursor);
        const url = new URL(
          cursor.startsWith('/v3/') ? this.release.middleware + cursor : cursor,
        );
        if (
          url.pathname !==
            new URL(this.release.middleware).pathname.replace(/\/$/, '') +
              '/v3/contracts/logs' ||
          ['contract_id', 'scope', 'direction', 'limit'].some(
            (key) => url.searchParams.getAll(key).length !== 1,
          ) ||
          url.searchParams.get('contract_id') !== address ||
          url.searchParams.get('scope') !== scope ||
          url.searchParams.get('direction') !== 'forward' ||
          url.searchParams.get('limit') !== '25'
        )
          throw new Error('Migration cursor changed its fixed range');
        this.progress(`Reading ${address} page ${seenPages.size}`);
        const page = await this.mdw(cursor);
        if (
          !Array.isArray(page.data) ||
          page.data.length > 25 ||
          (page.next !== null && typeof page.next !== 'string')
        )
          throw new Error('Invalid migration event page');
        for (const row of page.data) {
          receiptHash(row.call_tx_hash);
          if (
            row.contract_id !== address ||
            !Number.isSafeInteger(row.height) ||
            row.height < source.creationHeight ||
            row.height >= cutoff.height ||
            !Number.isSafeInteger(row.log_idx) ||
            row.log_idx < 0
          )
            throw new Error('Migration log outside cutoff');
          const key = `${row.call_tx_hash}:${row.log_idx}`;
          if (seenLogs.has(key)) throw new Error('Duplicate migration event');
          seenLogs.add(key);
          let call = calls.get(row.call_tx_hash);
          if (!call) {
            const [tx, info] = await Promise.all([
              this.retryRead(() =>
                this.sdk.api.getTransactionByHash(row.call_tx_hash),
              ),
              this.retryRead(() =>
                this.sdk.api.getTransactionInfoByHash(row.call_tx_hash),
              ),
            ]);
            const generation = await this.sdk.api.getGenerationByHeight(
              tx.blockHeight,
            );
            if (
              tx.hash !== row.call_tx_hash ||
              tx.blockHeight < 0 ||
              tx.blockHeight >= cutoff.height ||
              !generation.microBlocks.includes(
                tx.blockHash as `mh_${string}`,
              ) ||
              info.callInfo?.returnType !== 'ok' ||
              info.callInfo.height !== tx.blockHeight ||
              !Array.isArray(info.callInfo.log)
            )
              throw new Error(
                'Migration transaction is not a canonical successful call',
              );
            call = { tx, logs: info.callInfo.log };
            calls.set(row.call_tx_hash, call);
            transactions.add(row.call_tx_hash);
          }
          const log = call.logs[row.log_idx];
          if (
            call.tx.blockHeight !== row.height ||
            call.tx.blockHash !== row.block_hash ||
            log?.address !== address
          )
            throw new Error('Migration middleware and node log disagree');
          const [event] = source.contract.$decodeEvents([log]);
          const args = event.args;
          if (
            event.name ===
            (source.kind === 'prepaid' ? 'Activated' : 'Published')
          )
            published.add(String(args[source.kind === 'prepaid' ? 2 : 1]));
          if (event.name === 'Withdrawn') withdrawn.add(String(args[0]));
          if (event.name === 'PaidLike') {
            const id = String(args[2]);
            if (!likes.has(id)) likes.set(id, new Set());
            if (likes.get(id).has(String(args[0])))
              throw new Error('Duplicate paid membership on a legacy contract');
            likes.get(id).add(String(args[0]));
          }
        }
        cursor = page.next;
      }
      for (const id of [...likes.keys(), ...withdrawn])
        if (!published.has(id))
          throw new Error('Incomplete legacy publication inventory');
      for (const id of [...published].sort()) {
        this.progress(`Checking ${address} video ${id}`);
        const value = await this.read(
          source.contract,
          'get_short',
          [id],
          cutoff.hash,
        );
        if (
          !value ||
          typeof value.withdrawn !== 'boolean' ||
          value.withdrawn !== withdrawn.has(id)
        )
          throw new Error('Legacy metadata or tombstone mismatch');
        const members = [...(likes.get(id) ?? [])].sort();
        for (const actor of members)
          if (
            !(await this.read(
              source.contract,
              'has_liked',
              [actor, id],
              cutoff.hash,
            ))
          )
            throw new Error('Legacy membership disagrees with events');
        const old = videos.get(id);
        const video = {
          id,
          creator: value.creator,
          cid: value.cid,
          size: String(value.size),
          withdrawn: value.withdrawn,
          likes: members,
        };
        if (
          old &&
          !same(
            [old.creator, old.cid, old.size],
            [video.creator, video.cid, video.size],
          )
        )
          throw new Error('Conflicting legacy video identity');
        videos.set(
          id,
          old
            ? {
                ...old,
                withdrawn: old.withdrawn || video.withdrawn,
                likes: [...new Set([...old.likes, ...members])].sort(),
              }
            : video,
        );
        sourceCounts.push({
          contract: address,
          id,
          scalarLikes: String(value.likes),
          eventLikes: members.length,
        });
      }
    }
    for (const count of sourceCounts) {
      const total = videos.get(count.id).likes.length;
      if (
        BigInt(count.scalarLikes) < BigInt(count.eventLikes) ||
        BigInt(count.scalarLikes) > BigInt(total) ||
        (count.contract === this.sources[1].contract.$options.address &&
          BigInt(count.scalarLikes) !== BigInt(count.eventLikes))
      )
        throw new Error(
          'Legacy scalar count cannot be explained by the complete membership inventory',
        );
    }
    const snapshot: LegacySnapshot = {
      version: 1,
      network: this.release.network,
      destination: this.release.contract,
      source: this.release.previousContract,
      sourceCodeHash: this.release.previousArtifact.bytecodeHash,
      cutoff,
      videos: [...videos.values()].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      ),
      sourceCounts,
      transactions: [...transactions].sort(),
      commitment: '',
    };
    const { commitment } = await this.commitment(snapshot);
    snapshot.commitment = commitment;
    await this.canonical(cutoff);
    return snapshot;
  }
  private manifest(snapshot: LegacySnapshot) {
    return {
      network: snapshot.network,
      source: encode(
        decode(snapshot.source as `ct_${string}`),
        Encoding.AccountAddress,
      ),
      source_code_hash: Buffer.from(snapshot.sourceCodeHash, 'hex'),
      cutoff_hash: decode(snapshot.cutoff.hash as `kh_${string}`),
      cutoff_height: snapshot.cutoff.height,
      totals: {
        videos: snapshot.videos.length,
        likes: snapshot.videos.reduce((n, v) => n + v.likes.length, 0),
        comments: 0,
        authors: 0,
      },
    };
  }
  private items(snapshot: LegacySnapshot): any[] {
    return [
      ...snapshot.videos.map((v, k) => ({
        Video: [
          k,
          {
            id: v.id,
            creator: v.creator,
            cid: v.cid,
            size: v.size,
            withdrawn: v.withdrawn,
          },
          {
            likes: v.likes.length,
            comments: 0,
            next_comment: 0,
            comment_version: 0,
          },
        ],
      })),
      ...snapshot.videos.flatMap((v, k) =>
        v.likes.map((a) => ({ Like: [k, a] })),
      ),
    ];
  }
  async commitment(snapshot: LegacySnapshot) {
    if (
      snapshot.version !== 1 ||
      snapshot.network !== this.release.network ||
      snapshot.destination !== this.release.contract ||
      snapshot.source !== this.release.previousContract ||
      snapshot.sourceCodeHash !== this.release.previousArtifact.bytecodeHash ||
      !Array.isArray(snapshot.videos) ||
      snapshot.videos.length > 10000
    )
      throw new Error('Snapshot deployment mismatch');
    const manifest = this.manifest(snapshot),
      items = this.items(snapshot);
    let hash = await this.read(this.destination, 'legacy_seed', [manifest]);
    const hashes = [Buffer.from(hash).toString('hex')];
    for (let i = 0; i < items.length; i += 25) {
      hash = await this.read(this.destination, 'hash_migration_batch', [
        hash,
        items.slice(i, i + 25),
      ]);
      hashes.push(Buffer.from(hash).toString('hex'));
    }
    return {
      manifest,
      items,
      hashes,
      commitment: Buffer.from(hash).toString('hex'),
    };
  }
  async verify(snapshot: LegacySnapshot) {
    const fresh = await this.snapshot(snapshot.cutoff);
    if (!same(fresh, snapshot))
      throw new Error(
        'Saved snapshot does not match complete canonical inventory',
      );
    return fresh;
  }
  async import(snapshot: LegacySnapshot, activate = false) {
    await this.verify(snapshot);
    const { manifest, items, hashes, commitment } =
      await this.commitment(snapshot);
    const write = (name: string, args: unknown[] = []) =>
      this.destination.$call(name, args, { callStatic: false });
    let status = await this.read(this.destination, 'migration_status');
    if (
      activate &&
      !status.importing &&
      status.import_started &&
      !status.abandoned &&
      !status.frozen
    ) {
      await this.verifyBaseline(snapshot);
      return {
        contract: this.release.contract,
        importing: false,
        totals: status.totals,
        commitment,
      };
    }
    if (status.abandoned || status.frozen || !status.importing)
      throw new Error('Destination is not available for import');
    if (!status.import_started)
      await write('begin_legacy_import', [
        manifest,
        Buffer.from(commitment, 'hex'),
      ]);
    const [native, legacy] = await this.read(
      this.destination,
      'get_import_source',
    );
    if (native || !same(legacy, manifest))
      throw new Error('Destination imported another source');
    const [cursor, total, hash, expected] = await this.read(
      this.destination,
      'get_import_progress',
    );
    if (
      BigInt(total) !== BigInt(items.length) ||
      Buffer.from(expected).toString('hex') !== commitment ||
      BigInt(cursor) > BigInt(items.length) ||
      (Number(cursor) % 25 !== 0 && Number(cursor) !== items.length) ||
      Buffer.from(hash).toString('hex') !==
        hashes[Math.ceil(Number(cursor) / 25)]
    )
      throw new Error('Import progress commitment mismatch');
    for (let i = Number(cursor); i < items.length; i += 25)
      await write('import_legacy_batch', [i, items.slice(i, i + 25)]);
    await this.verifyDestination(snapshot);
    await this.canonical(snapshot.cutoff);
    if (activate) await write('finish_import');
    status = await this.read(this.destination, 'migration_status');
    if (status.importing === activate)
      throw new Error('Unexpected destination activation state');
    return {
      contract: this.release.contract,
      importing: status.importing,
      totals: status.totals,
      commitment,
    };
  }
  /** Permanent import proof remains valid after ordinary V2 activity changes live counts. */
  async verifyBaseline(snapshot: LegacySnapshot, importingAllowed = false) {
    const proof = await this.commitment(snapshot);
    const { manifest, items, commitment } = proof;
    if (snapshot.commitment !== commitment)
      throw new Error('Saved snapshot commitment mismatch');
    const status = await this.read(this.destination, 'migration_status');
    const [native, legacy] = await this.read(
      this.destination,
      'get_import_source',
    );
    if (
      status.abandoned ||
      status.frozen ||
      !status.import_started ||
      (!importingAllowed && status.importing) ||
      native ||
      !same(legacy, manifest)
    )
      throw new Error('Destination lifecycle or import source mismatch');
    const [cursor, total, hash, expected, videos, authors] = await this.read(
      this.destination,
      'get_import_progress',
    );
    if (
      BigInt(cursor) !== BigInt(items.length) ||
      BigInt(total) !== BigInt(items.length) ||
      BigInt(videos) !== 0n ||
      BigInt(authors) !== 0n ||
      Buffer.from(hash).toString('hex') !== commitment ||
      Buffer.from(expected).toString('hex') !== commitment
    )
      throw new Error('Incomplete destination import commitment');
    return proof;
  }
  async verifyDestination(snapshot: LegacySnapshot) {
    const { manifest } = await this.verifyBaseline(snapshot, true);
    if (!same(await this.read(this.destination, 'get_totals'), manifest.totals))
      throw new Error('Destination inventory changed');
    for (const video of snapshot.videos) {
      const expectedVideo = {
        id: video.id,
        creator: video.creator,
        cid: video.cid,
        size: video.size,
        withdrawn: video.withdrawn,
      };
      if (
        !same(
          await this.read(this.destination, 'get_video', [video.id]),
          expectedVideo,
        ) ||
        BigInt(
          await this.read(this.destination, 'get_likes_count', [video.id]),
        ) !== BigInt(video.likes.length)
      )
        throw new Error('Imported video mismatch');
      for (const actor of video.likes)
        if (
          !(await this.read(this.destination, 'has_liked', [actor, video.id]))
        )
          throw new Error('Imported membership missing');
    }
    return manifest;
  }
}
