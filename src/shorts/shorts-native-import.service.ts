import { AciContractCallEncoder } from '@aeternity/aepp-calldata';
import { signedWalletTransactionFromNode } from './shorts-sponsored-observation';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  AccountMemory,
  AeSdk,
  Contract,
  Node,
  Tag,
  buildTxHash,
  unpackTx,
  decode,
  encode,
  Encoding,
  hash as transactionHash,
  rebuildUnpackedTx,
  verifySignature,
} from '@aeternity/aepp-sdk';
import { createHash } from 'node:crypto';
import { open, lstat, readFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { shortsContractPolicy } from './shorts-contract-policy';
import { isAbsolute, dirname } from 'node:path';
import {
  shortsArtifact,
  shortsConfigJson,
  shortsRelease,
  ShortsRelease,
} from './shorts-release';
import { ShortsNodeAccessService } from './shorts-node-access.service';

export interface NativeImportConfig {
  kind: 'native';
  releaseFile: string;
  artifactFile: string;
  sourceArtifactFile: string;
  maxRecords: number;
  destinationConfig: Record<string, string | number | boolean>;
}
export interface NativeSnapshot {
  version: 2;
  kind: 'native';
  network: string;
  destination: string;
  source: string;
  sourceCodeHash: string;
  cutoff: { height: number; hash: string };
  snapshotHeight: string;
  totals: Record<string, string>;
  records: any[];
  videos: { id: string; withdrawn: boolean; likes: string[] }[];
  commitment: string;
}
export const nativeNormalize = (value: any): any => {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  if (Array.isArray(value)) return value.map(nativeNormalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, nativeNormalize(value[k])]),
    );
  return value;
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(nativeNormalize(a)) === JSON.stringify(nativeNormalize(b));
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const nativeContractAddress = (value: unknown): string | undefined => {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !/^(ak|ct)_/.test(value))
    throw new Error('Invalid native contract address');
  return encode(
    decode(value as `ak_${string}` | `ct_${string}`),
    Encoding.ContractAddress,
  );
};
const stringify = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

/** Snapshot bodies can exceed the 1 MiB configuration limit; never follow links. */
export async function readShortsMigrationSnapshot(
  path: string,
): Promise<
  NativeSnapshot | import('./shorts-legacy-import.service').LegacySnapshot
> {
  if (!isAbsolute(path || ''))
    throw new Error('Absolute migration snapshot required');
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const limit = 16777216,
      stat = await fd.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error('Invalid migration snapshot size');
    const data = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < data.length) {
      const result = await fd.read(data, offset, data.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset > limit)
      throw new Error('Migration snapshot exceeds read limit');
    return JSON.parse(data.subarray(0, offset).toString('utf8'));
  } finally {
    await fd.close();
  }
}

/** Explicit, bounded native owner migration. Never loaded by a serving API. */
@Injectable()
export class ShortsNativeImportService implements OnModuleDestroy {
  private release: ShortsRelease;
  private config: NativeImportConfig;
  private sdk: AeSdk;
  private source: Contract<any>;
  private destination: Contract<any>;
  private owner: string;
  private encoders = new Map<string, AciContractCallEncoder>();
  private journalFile?: string;
  private lockFile?: string;
  private context?: {
    contract: string;
    method: string;
    args: unknown[];
    height: number;
  };
  private entries: any[] = [];
  constructor(private readonly access: ShortsNodeAccessService) {}

  async initialize(
    config: NativeImportConfig,
    keyFile?: string,
    journalFile?: string,
  ) {
    if (
      config.kind !== 'native' ||
      !Number.isSafeInteger(config.maxRecords) ||
      config.maxRecords < 1 ||
      config.maxRecords > 10000
    )
      throw new Error(
        'Native import requires an explicit bounded record allowance',
      );
    this.config = config;
    this.release = shortsRelease(
      await shortsConfigJson(config.releaseFile),
      true,
    );
    const r = this.release;
    if (
      r.network !== 'ae_uat' ||
      r.schemaVersion !== 2 ||
      !r.previousContract ||
      !r.previousArtifact ||
      r.likeFeeAetto !== '0'
    )
      throw new Error(
        'Native import requires a pinned free testnet destination and predecessor',
      );
    const account = keyFile
      ? new AccountMemory((await shortsConfigJson(keyFile, true)).secretKey)
      : undefined;
    if (account) await this.openJournal(journalFile);
    const transport = this.access.transport(r.node, !!account);
    const node = new Node(r.node, {
      retryCount: 0,
      httpClient: {
        sendRequest: async (request) => {
          if (
            request.method === 'POST' &&
            new URL(request.url).pathname === '/v3/transactions'
          ) {
            const raw = JSON.parse(String(request.body)).tx;
            if (!this.context || !account)
              throw new Error(
                'Migration submission outside current owner operation',
              );
            this.validateSigned({ raw, ...this.context });
            if (
              this.entries.some(
                (e) =>
                  e.type === 'signed' &&
                  !this.entries.some(
                    (r) => r.type === 'receipt' && r.hash === e.hash,
                  ),
              )
            )
              throw new Error(
                'Unresolved signed migration transaction; reconcile its exact hash first',
              );
            await this.append({
              type: 'signed',
              hash: buildTxHash(raw),
              raw,
              ...this.context,
            });
          }
          return transport.sendRequest(request);
        },
      },
    });
    node.pipeline.removePolicy({ name: 'combine-get-requests' });
    this.sdk = new AeSdk({
      nodes: [{ name: r.network, instance: node }],
      accounts: account ? [account] : [],
      interval: 1500,
    });
    if ((await this.sdk.api.getStatus()).networkId !== r.network)
      throw new Error('Native migration node network mismatch');
    const artifact = shortsArtifact(
      await shortsConfigJson(config.artifactFile),
      r,
    );
    const old = shortsArtifact(
      await shortsConfigJson(config.sourceArtifactFile),
      r.previousArtifact,
    );
    this.encoders.set(r.contract, new AciContractCallEncoder(artifact.aci));
    this.encoders.set(r.previousContract, new AciContractCallEncoder(old.aci));
    this.destination = await Contract.initialize({
      ...this.sdk.getContext(),
      aci: artifact.aci,
      address: r.contract,
    });
    this.source = await Contract.initialize({
      ...this.sdk.getContext(),
      aci: old.aci,
      address: r.previousContract,
    });
    for (const [contract, expected] of [
      [r.contract, r.bytecodeHash],
      [r.previousContract, r.previousArtifact.bytecodeHash],
    ]) {
      if (
        hash(
          (await this.sdk.api.getContractCode(contract as `ct_${string}`))
            .bytecode,
        ) !== expected
      )
        throw new Error('Native migration bytecode mismatch');
    }
    const [source, destination] = await Promise.all([
      this.read(this.source, 'migration_status'),
      this.read(this.destination, 'migration_status'),
    ]);
    if (
      BigInt(source.schema) !== 2n ||
      BigInt(destination.schema) !== 2n ||
      source.owner !== destination.owner ||
      (account && source.owner !== account.address)
    )
      throw new Error('Native schema/owner mismatch');
    const cfg = (await this.read(this.destination, 'get_config'))[0];
    if (
      !same(cfg, config.destinationConfig) ||
      shortsContractPolicy([cfg, 0n], 2).operator !== r.operator ||
      'like_fee' in cfg ||
      'treasury' in cfg
    )
      throw new Error('Native destination configuration mismatch');
    this.owner = source.owner;
    this.total(source.totals);
    if (account) await this.reconcile();
  }

  private async openJournal(file?: string) {
    if (!file || !isAbsolute(file))
      throw new Error('Absolute private migration journal required');
    const lock = await open(file + '.lock', 'wx', 0o600);
    this.lockFile = file + '.lock';
    await lock.writeFile(
      stringify({ pid: process.pid, at: new Date().toISOString() }),
    );
    await lock.sync();
    await lock.close();
    try {
      const stat = await lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.mode & 0o077 ||
        stat.uid !== process.getuid?.()
      )
        throw new Error(
          'Migration journal must be an owned private regular file',
        );
      const text = await readFile(file, 'utf8');
      if (text && !text.endsWith('\n'))
        throw new Error('Truncated migration journal');
      this.entries = text.trim()
        ? text
            .trimEnd()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const fresh = await open(file, 'wx', 0o600);
      await fresh.sync();
      await fresh.close();
    }
    this.journalFile = file;
    const binding = {
      network: this.release.network,
      source: this.release.previousContract,
      destination: this.release.contract,
      sourceHash: this.release.sourceHash,
    };
    if (
      this.entries.length &&
      (!same(this.entries[0].binding, binding) ||
        this.entries[0].type !== 'binding')
    )
      throw new Error('Migration journal binding changed');
    if (!this.entries.length) await this.append({ type: 'binding', binding });
    const directory = await open(dirname(file), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private async append(entry: any) {
    if (!this.journalFile)
      throw new Error('Read-only native migration service');
    const row = { at: new Date().toISOString(), ...entry };
    const fd = await open(this.journalFile, 'a', 0o600);
    try {
      await fd.writeFile(stringify(row) + '\n');
      await fd.sync();
    } finally {
      await fd.close();
    }
    this.entries.push(row);
  }
  async onModuleDestroy() {
    if (this.lockFile) {
      await unlink(this.lockFile);
      this.lockFile = undefined;
    }
  }
  private total(t: any): number {
    const values = ['videos', 'likes', 'comments', 'authors'].map((k) =>
      BigInt(t[k]),
    );
    const n = values.reduce((a, b) => a + b, 0n);
    if (values.some((v) => v < 0n) || n > BigInt(this.config.maxRecords))
      throw new Error('Native migration record allowance exceeded');
    return Number(n);
  }
  private async read(
    contract: Contract<any>,
    method: string,
    args: unknown[] = [],
    top?: string,
  ): Promise<any> {
    return this.access.read(
      async () =>
        (
          await contract.$call(method, args, {
            callStatic: true,
            ...(top ? { top: top as `kh_${string}` } : {}),
          })
        ).decodedResult,
    );
  }
  async canonical(cutoff: NativeSnapshot['cutoff']) {
    if (
      !Number.isSafeInteger(cutoff.height) ||
      cutoff.height < 0 ||
      !cutoff.hash.startsWith('kh_')
    )
      throw new Error('Invalid native cutoff');
    const [block, tip, status] = await Promise.all([
      this.sdk.api.getKeyBlockByHeight(cutoff.height),
      this.sdk.api.getCurrentKeyBlock(),
      this.sdk.api.getStatus(),
    ]);
    if (
      block.hash !== cutoff.hash ||
      tip.height - cutoff.height < 3 ||
      status.networkId !== this.release.network
    )
      throw new Error('Native cutoff is not canonical and confirmed');
  }
  private validateSigned(entry: any) {
    const signed = unpackTx(entry.raw, Tag.SignedTx) as any;
    const tx = signed.encodedTx;
    const allowed =
      entry.contract === this.release.previousContract
        ? ['announce_successor', 'freeze_for_migration', 'seal_next']
        : entry.contract === this.release.contract
          ? [
              'reserve_import_source',
              'begin_import',
              'import_next',
              'finish_import',
            ]
          : [];
    const encoder = this.encoders.get(entry.contract);
    if (
      !allowed.includes(entry.method) ||
      !encoder ||
      !Array.isArray(entry.args) ||
      signed.signatures.length !== 1 ||
      tx.tag !== Tag.ContractCallTx ||
      tx.version !== 1 ||
      tx.abiVersion !== 3 ||
      tx.callerId !== this.owner ||
      tx.contractId !== entry.contract ||
      BigInt(tx.amount) !== 0n ||
      !Number.isSafeInteger(tx.nonce) ||
      tx.nonce < 1 ||
      !Number.isSafeInteger(entry.height) ||
      !Number.isSafeInteger(tx.ttl) ||
      tx.ttl <= entry.height ||
      tx.ttl > entry.height + 40 ||
      tx.gasLimit > 6000000 ||
      BigInt(tx.fee) + BigInt(tx.gasLimit) * BigInt(tx.gasPrice) >
        1000000000000000000n ||
      rebuildUnpackedTx(signed) !== entry.raw ||
      encoder.encodeCall('Shorts', entry.method, entry.args) !== tx.callData
    )
      throw new Error(
        'Migration signed bytes do not match their bounded operation',
      );
    const binary = decode(rebuildUnpackedTx(tx));
    if (
      ![transactionHash(binary), binary].some((payload) =>
        verifySignature(
          Buffer.concat([Buffer.from(this.release.network), payload]),
          signed.signatures[0],
          tx.callerId,
        ),
      )
    )
      throw new Error('Migration owner signature/network mismatch');
    return tx;
  }
  private async receipt(entry: any) {
    const hash = entry.hash as `th_${string}`;
    const call = this.validateSigned(entry);
    const [tx, info] = await Promise.all([
      this.sdk.api.getTransactionByHash(hash),
      this.sdk.api.getTransactionInfoByHash(hash),
    ]);
    if (
      tx.hash !== hash ||
      tx.blockHeight < 0 ||
      signedWalletTransactionFromNode(tx) !== entry.raw
    )
      throw new Error('Migration transaction remains unresolved');
    const generation = await this.sdk.api.getGenerationByHeight(tx.blockHeight);
    if (
      !generation.microBlocks.includes(tx.blockHash as `mh_${string}`) ||
      info.callInfo?.returnType !== 'ok' ||
      info.callInfo.callerId !== call.callerId ||
      info.callInfo.contractId !== call.contractId ||
      info.callInfo.callerNonce !== call.nonce ||
      info.callInfo.height !== tx.blockHeight
    )
      throw new Error(
        'Migration receipt is not canonical successful execution',
      );
    const [again, status] = await Promise.all([
      this.sdk.api.getGenerationByHeight(tx.blockHeight),
      this.sdk.api.getStatus(),
    ]);
    if (
      again.keyBlock.hash !== generation.keyBlock.hash ||
      !again.microBlocks.includes(tx.blockHash as `mh_${string}`) ||
      status.networkId !== this.release.network
    )
      throw new Error('Migration receipt reorganized during verification');
    return {
      hash,
      blockHash: tx.blockHash,
      blockHeight: tx.blockHeight,
      gasUsed: info.callInfo.gasUsed,
      gasPrice: info.callInfo.gasPrice,
      fee: (tx.tx as any).fee,
    };
  }
  async reconcile() {
    for (const entry of this.entries.filter((e) => e.type === 'signed')) {
      if (
        buildTxHash(entry.raw) !== entry.hash ||
        ![this.release.contract, this.release.previousContract].includes(
          entry.contract,
        )
      )
        throw new Error('Signed migration journal changed');
      const receipt = await this.receipt(entry);
      if (
        !this.entries.some(
          (e) =>
            e.type === 'receipt' &&
            e.hash === entry.hash &&
            e.blockHash === receipt.blockHash,
        )
      )
        await this.append({ type: 'receipt', ...receipt });
    }
  }
  private async write(
    contract: Contract<any>,
    address: string,
    method: string,
    args: unknown[] = [],
  ) {
    if (!this.journalFile || this.context)
      throw new Error('Exclusive migration owner operation required');
    await this.reconcile();
    const tip = await this.sdk.api.getCurrentKeyBlock();
    this.context = { contract: address, method, args, height: tip.height };
    try {
      await contract.$call(method, args, {
        callStatic: false,
        amount: 0,
        gasLimit: 5000000,
        ttl: tip.height + 40,
        absoluteTtl: true,
      } as any);
      await this.reconcile();
    } finally {
      this.context = undefined;
    }
  }
  async prepare() {
    const [s, d] = await Promise.all([
      this.read(this.source, 'migration_status'),
      this.read(this.destination, 'migration_status'),
    ]);
    if (
      s.frozen ||
      s.importing ||
      s.abandoned ||
      !d.importing ||
      d.import_started ||
      d.abandoned ||
      d.frozen ||
      this.total(d.totals) !== 0
    )
      throw new Error('Invalid native preparation lifecycle');
    if (d.reserved_source == null)
      await this.write(
        this.destination,
        this.release.contract,
        'reserve_import_source',
        [this.release.previousContract],
      );
    else if (
      nativeContractAddress(d.reserved_source) !== this.release.previousContract
    )
      throw new Error('Destination reserved for another source');
    if (s.successor == null)
      await this.write(
        this.source,
        this.release.previousContract!,
        'announce_successor',
        [this.release.contract, 0],
      );
    else if (nativeContractAddress(s.successor) !== this.release.contract)
      throw new Error('Source has another successor');
  }
  async freezeAndSeal() {
    let s = await this.read(this.source, 'migration_status');
    if (
      nativeContractAddress(s.successor) !== this.release.contract ||
      s.importing ||
      s.abandoned
    )
      throw new Error('Source not prepared for this destination');
    if (!s.frozen) {
      await this.write(
        this.source,
        this.release.previousContract!,
        'freeze_for_migration',
      );
      s = await this.read(this.source, 'migration_status');
    }
    const total = this.total(s.totals);
    if (!s.sealed) {
      const signed = this.entries.filter(
        (e) =>
          e.type === 'signed' && e.contract === this.release.previousContract,
      );
      if (!signed.some((e) => e.method === 'freeze_for_migration'))
        throw new Error(
          'Unrecognized frozen source; explicit journal reconciliation required',
        );
      const seals = signed.filter((e) => e.method === 'seal_next');
      let cursor = seals.length
        ? Math.min(
            Number(seals.at(-1).args[0]) + Number(seals.at(-1).args[1]),
            total,
          )
        : 0;
      while (cursor < total) {
        await this.write(
          this.source,
          this.release.previousContract!,
          'seal_next',
          [cursor, 25],
        );
        cursor = Math.min(cursor + 25, total);
      }
    }
    s = await this.read(this.source, 'migration_status');
    if (!s.frozen || !s.sealed) throw new Error('Source not sealed');
    return nativeNormalize(s);
  }
  async snapshot(cutoff?: NativeSnapshot['cutoff']): Promise<NativeSnapshot> {
    if (!cutoff) {
      const tip = await this.sdk.api.getCurrentKeyBlock();
      const block = await this.sdk.api.getKeyBlockByHeight(tip.height - 3);
      cutoff = { height: block.height, hash: block.hash };
    }
    await this.canonical(cutoff);
    const s = await this.read(this.source, 'migration_status', [], cutoff.hash);
    if (
      !s.frozen ||
      !s.sealed ||
      s.importing ||
      s.abandoned ||
      nativeContractAddress(s.successor) !== this.release.contract
    )
      throw new Error('Snapshot requires confirmed frozen, sealed source');
    const total = this.total(s.totals),
      records: any[] = [],
      videos: NativeSnapshot['videos'] = [];
    for (let cursor = 0; cursor < total;) {
      const page = await this.read(
        this.source,
        'export_page',
        [cursor, 25],
        cutoff.hash,
      );
      const next = Math.min(cursor + 25, total);
      if (
        Number(page.next_cursor) !== next ||
        Number(page.end_cursor) !== total ||
        page.items.length !== next - cursor
      )
        throw new Error('Invalid native export page');
      records.push(...nativeNormalize(page.items));
      cursor = next;
    }
    for (const item of records) {
      if (item.Video) {
        const [k, v] = item.Video;
        if (Number(k) !== videos.length)
          throw new Error('Invalid native video order');
        videos.push({ id: v.id, withdrawn: v.withdrawn, likes: [] });
      } else if (item.Like) {
        const [k, a] = item.Like;
        if (!videos[Number(k)] || videos[Number(k)].likes.includes(a))
          throw new Error('Invalid native membership');
        videos[Number(k)].likes.push(a);
      }
    }
    await this.canonical(cutoff);
    return {
      version: 2,
      kind: 'native',
      network: this.release.network,
      destination: this.release.contract,
      source: this.release.previousContract!,
      sourceCodeHash: this.release.previousArtifact!.bytecodeHash,
      cutoff,
      snapshotHeight: String(s.snapshot_height),
      totals: nativeNormalize(s.totals),
      records,
      videos,
      commitment: nativeNormalize(s.digest),
    };
  }
  private async anchor(confirmed: boolean) {
    if (confirmed) {
      const tip = await this.sdk.api.getCurrentKeyBlock();
      const block = await this.sdk.api.getKeyBlockByHeight(tip.height - 3);
      return {
        height: block.height,
        hash: block.hash,
        keyHash: block.hash,
        confirmations: 3,
      };
    }
    const generation = await this.sdk.api.getCurrentGeneration();
    return {
      height: generation.keyBlock.height,
      hash: generation.microBlocks.at(-1) ?? generation.keyBlock.hash,
      keyHash: generation.keyBlock.hash,
      confirmations: 0,
    };
  }
  private async checkAnchor(anchor: {
    height: number;
    hash: string;
    keyHash: string;
    confirmations: number;
  }) {
    const [g, tip, status] = await Promise.all([
      this.sdk.api.getGenerationByHeight(anchor.height),
      this.sdk.api.getCurrentKeyBlock(),
      this.sdk.api.getStatus(),
    ]);
    if (
      status.networkId !== this.release.network ||
      g.keyBlock.hash !== anchor.keyHash ||
      (anchor.hash !== anchor.keyHash &&
        !g.microBlocks.includes(anchor.hash as `mh_${string}`)) ||
      tip.height - anchor.height < anchor.confirmations
    )
      throw new Error('Native proof anchor changed or is not confirmed');
  }
  async verifyBaseline(snapshot: NativeSnapshot) {
    const anchor = await this.anchor(true);
    await this.baseline(snapshot, anchor.hash, false);
    await this.checkAnchor(anchor);
    return { verified: true, commitment: snapshot.commitment, anchor };
  }
  private async baseline(
    snapshot: NativeSnapshot,
    top: string,
    allowImporting: boolean,
  ) {
    if (
      snapshot.version !== 2 ||
      snapshot.kind !== 'native' ||
      snapshot.network !== this.release.network ||
      snapshot.destination !== this.release.contract ||
      snapshot.source !== this.release.previousContract ||
      snapshot.sourceCodeHash !== this.release.previousArtifact!.bytecodeHash
    )
      throw new Error('Native snapshot binding mismatch');
    if (!same(await this.snapshot(snapshot.cutoff), snapshot))
      throw new Error('Native snapshot differs from canonical source');
    const [s, d, origin, p] = await Promise.all([
      this.read(this.source, 'migration_status', [], top),
      this.read(this.destination, 'migration_status', [], top),
      this.read(this.destination, 'get_import_source', [], top),
      this.read(this.destination, 'get_import_progress', [], top),
    ]);
    const currentConfig = (
      await this.read(this.destination, 'get_config', [], top)
    )[0];
    if (!same(currentConfig, this.config.destinationConfig))
      throw new Error('Native destination configuration changed');
    const total = this.total(snapshot.totals);
    if (
      !s.frozen ||
      !s.sealed ||
      nativeContractAddress(s.successor) !== this.release.contract ||
      !same(s.digest, snapshot.commitment) ||
      d.abandoned ||
      d.frozen ||
      !d.import_started ||
      (!allowImporting && d.importing) ||
      nativeContractAddress(origin[0]) !== snapshot.source ||
      origin[1] != null ||
      Number(p[0]) !== total ||
      Number(p[1]) !== total ||
      !same(p[2], snapshot.commitment) ||
      !same(p[3], snapshot.commitment) ||
      BigInt(p[4]) !== 0n ||
      BigInt(p[5]) !== 0n
    )
      throw new Error('Native import proof is incomplete or changed');
    return { verified: true, commitment: snapshot.commitment };
  }
  async verifyDestination(snapshot: NativeSnapshot, allowImporting = false) {
    const anchor = await this.anchor(!allowImporting);
    const top = anchor.hash;
    await this.baseline(snapshot, top, allowImporting);
    if (
      !same(
        await this.read(this.destination, 'get_totals', [], top),
        snapshot.totals,
      )
    )
      throw new Error('Native destination totals differ');
    for (const item of snapshot.records) {
      if (item.Video) {
        const [k, video, stats] = item.Video;
        if (
          !same(
            await this.read(this.destination, 'get_video_key', [video.id], top),
            k,
          ) ||
          !same(
            await this.read(this.destination, 'get_video', [video.id], top),
            video,
          ) ||
          !same(
            await this.read(
              this.destination,
              'get_video_stats',
              [video.id],
              top,
            ),
            stats,
          )
        )
          throw new Error('Native video or stats differ');
      } else if (item.Like) {
        const [k, a] = item.Like;
        if (
          (await this.read(
            this.destination,
            'has_liked',
            [a, snapshot.videos[Number(k)].id],
            top,
          )) !== true
        )
          throw new Error('Native membership missing');
      } else if (item.Comment) {
        const [k, n, comment] = item.Comment;
        if (
          !same(
            await this.read(
              this.destination,
              'get_comment',
              [snapshot.videos[Number(k)].id, n],
              top,
            ),
            comment,
          )
        )
          throw new Error('Native comment differs');
      } else if (item.Author) {
        const [a, author] = item.Author;
        if (
          !same(
            await this.read(this.destination, 'get_author', [a], top),
            author,
          )
        )
          throw new Error('Native author controls differ');
      } else throw new Error('Unknown native record');
    }
    await this.checkAnchor(anchor);
    return { verified: true, records: snapshot.records.length, top, anchor };
  }
  async copy(snapshot: NativeSnapshot) {
    if (!same(await this.snapshot(snapshot.cutoff), snapshot))
      throw new Error('Native snapshot changed');
    const d = await this.read(this.destination, 'migration_status');
    if (
      !d.importing ||
      d.abandoned ||
      d.frozen ||
      nativeContractAddress(d.reserved_source) !== snapshot.source
    )
      throw new Error('Destination not reserved and importing');
    if (!d.import_started)
      await this.write(
        this.destination,
        this.release.contract,
        'begin_import',
        [snapshot.source],
      );
    const total = this.total(snapshot.totals);
    let cursor = Number(
      (await this.read(this.destination, 'get_import_progress'))[0],
    );
    while (cursor < total) {
      await this.write(this.destination, this.release.contract, 'import_next', [
        cursor,
        25,
      ]);
      const next = Number(
        (await this.read(this.destination, 'get_import_progress'))[0],
      );
      if (next !== Math.min(cursor + 25, total))
        throw new Error('Native import cursor mismatch');
      cursor = next;
    }
    return this.verifyDestination(snapshot, true);
  }
  async activate(snapshot: NativeSnapshot) {
    await this.verifyDestination(snapshot, true);
    const status = await this.read(this.destination, 'migration_status');
    if (!status.importing)
      return { activated: true, requiresConfirmedVerification: true };
    await this.write(this.destination, this.release.contract, 'finish_import');
    return { activated: true, requiresConfirmedVerification: true };
  }
}
