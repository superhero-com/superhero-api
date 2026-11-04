import {
  SHORTS_IPFS_IMPORT_OPTIONS,
  SHORTS_IPFS_IMPORT_QUERY,
} from './shorts-ipfs-import-profile';
import { shortsStorageScope } from './shorts-runtime-scope';
import { reclamationStorage } from './shorts-reclamation-storage';
import type { InputReclamationPermit } from './shorts-input-reclamation-permits.service';
import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  rm,
  open,
  rename,
  mkdtemp,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { openAsBlob } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { ShortsMediaFile, verifiedMediaBytes } from './shorts-media-file';
import {
  validateOriginalContent,
  derivedFiles,
  derivedFileCid,
} from './shorts-original-content';
import {
  ScratchCapacityError,
  ShortsScratchService,
} from './shorts-scratch.service';
import { LOCAL_DIR } from './shorts-chain.service';
import { ShortRecord } from './shorts.types';
import {
  ShortsSafetyService,
  ShortsModerationUnavailableError,
} from './shorts-safety.service';
import { ShortsEncodingService } from './shorts-encoding.service';
import { ShortsPrivateMediaService } from './shorts-private-media.service';
import { ShortsRecordsService } from './shorts-records.service';
import { ShortsPackageService } from './shorts-package.service';
import {
  PinPurpose,
  ShortsPinTransfersService,
} from './shorts-pin-transfers.service';
import {
  PlaybackDescriptor,
  deliverySourceIdentity,
} from './hls-protocol/playback-descriptor';
import { HlsPackage, validateSourcePackage } from './hls-protocol/hls-package';
import { shortsPlaybackDescriptor } from './shorts-playback-descriptor';
import {
  ShortsMediaAdmissionService,
  ShortsMediaUnavailableError,
} from './shorts-media-admission.service';
import {
  discardShortsResponse,
  readShortsJson,
  readShortsResponse,
} from './shorts-upstream';

@Injectable()
export class ShortsMediaService implements OnModuleInit, OnModuleDestroy {
  private key: Buffer;
  private pinnedCids = new Set<string>();
  private readonly shutdown = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();
  private ipfsStarts = Promise.resolve();
  private lastIpfsStart = -Infinity;
  private readonly expiringWrites: boolean;
  readonly api = (
    process.env.SHORTS_IPFS_API || 'http://127.0.0.1:35002/api/v0'
  )
    .trim()
    .replace(/\/$/, '');
  constructor(
    readonly safety: ShortsSafetyService,
    @Optional() private readonly privateMedia?: ShortsPrivateMediaService,
    @Optional() private readonly records?: ShortsRecordsService,
    @Optional() private readonly encoder?: ShortsEncodingService,
    @Optional() private readonly admission?: ShortsMediaAdmissionService,
    @Optional() private readonly scratch?: ShortsScratchService,
    @Optional() private readonly pinTransfers?: ShortsPinTransfersService,
  ) {
    const flag = process.env.SHORTS_IPFS_EXPIRING_WRITES ?? 'false';
    if (!['true', 'false'].includes(flag))
      throw new Error('Invalid expiring IPFS writes flag');
    this.expiringWrites = flag === 'true';
  }
  private async withCapacity<T>(
    short: ShortRecord,
    parent: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
    waitForCapacity = false,
  ): Promise<T> {
    const operation = this.transfer(short, parent, work, waitForCapacity);
    this.operations.add(operation);
    try {
      return await operation;
    } finally {
      this.operations.delete(operation);
    }
  }
  private async transfer<T>(
    short: ShortRecord,
    parent: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
    waitForCapacity: boolean,
  ): Promise<T> {
    const active = this.signal(parent, 180000);
    active.throwIfAborted();
    if (this.records?.shared && !this.admission)
      throw new ShortsMediaUnavailableError();
    const reservation = this.records?.shared
      ? await this.admission!.acquire(
          short.creator,
          waitForCapacity ? active : undefined,
        )
      : undefined;
    const signal = reservation
      ? AbortSignal.any([active, reservation.signal])
      : active;
    try {
      signal.throwIfAborted();
      const result = await work(signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (
        (reservation?.signal.aborted ||
          error instanceof ShortsModerationUnavailableError ||
          error instanceof ScratchCapacityError) &&
        !active.aborted
      )
        throw new ShortsMediaUnavailableError();
      throw error;
    } finally {
      // Keep capacity while cancelled S3/scanner/IPFS work is still draining.
      await reservation?.release();
    }
  }
  private scope() {
    if (!this.records?.chain.state.contract)
      throw new Error('Private media deployment is unavailable');
    return shortsStorageScope(this.records.chain);
  }
  private async preparedFile(
    short: ShortRecord,
    name: string,
    signal?: AbortSignal,
  ) {
    const active = this.signal(signal);
    active.throwIfAborted();
    if (short.privateMedia) {
      if (!this.privateMedia)
        throw new Error('Shared private media is unavailable');
      return this.privateMedia.file(this.scope(), short, name, active);
    }
    if (this.records?.shared)
      throw new Error('Migrate private media before using the hosted API');
    return this.load(short.id, name);
  }
  private signal(signal?: AbortSignal, timeoutMs?: number) {
    return AbortSignal.any([
      this.shutdown.signal,
      ...(signal ? [signal] : []),
      ...(timeoutMs ? [AbortSignal.timeout(timeoutMs)] : []),
    ]);
  }
  async onModuleInit() {
    // Validate storage configuration before accepting uploads.
    await this.ipfsHeaders();
    if (this.expiringWrites && (!this.records?.shared || !this.pinTransfers))
      throw new Error(
        'Expiring IPFS writes require shared pin transfer metadata',
      );
    if (this.records?.shared) {
      if (!this.privateMedia)
        throw new Error('Hosted media requires private shared storage');
      if (!this.admission)
        throw new Error('Hosted media requires shared transfer admission');
      return;
    }
    await mkdir(join(LOCAL_DIR, 'private'), { recursive: true, mode: 0o700 });
    try {
      this.key = await readFile(join(LOCAL_DIR, 'quarantine.key'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.key = randomBytes(32);
      await writeFile(join(LOCAL_DIR, 'quarantine.key'), this.key, {
        mode: 0o600,
        flag: 'wx',
      });
    }
  }
  private async ipfsHeaders(): Promise<Headers> {
    if (
      process.env.SHORTS_IPFS_APIS !== undefined ||
      process.env.SHORTS_IPFS_CREDENTIALS_FILE !== undefined
    )
      throw new Error(
        'Replace SHORTS_IPFS_APIS and SHORTS_IPFS_CREDENTIALS_FILE with SHORTS_IPFS_API and SHORTS_IPFS_TOKEN_FILE',
      );
    const url = new URL(this.api);
    const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if (
      this.api.includes(',') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/api/v0' ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          local &&
          process.env.NODE_ENV !== 'production'
        ))
    )
      throw new Error(
        'IPFS requires an explicit HTTPS RPC endpoint (HTTP is local development only)',
      );
    const tokenFile = process.env.SHORTS_IPFS_TOKEN_FILE;
    const headers = new Headers();
    if (!tokenFile) {
      if (!local || process.env.NODE_ENV === 'production')
        throw new Error('IPFS credentials are required for remote storage');
      return headers;
    }
    if (!isAbsolute(tokenFile))
      throw new Error('IPFS token file must use an absolute path');
    // Read the server-only key per request so rotation needs no API restart.
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (!/^[0-9a-f]{64}$/.test(token))
      throw new Error('Invalid IPFS service token');
    headers.set('Authorization', `Bearer ${token}`);
    return headers;
  }
  private async ipfsFetch(path: string, init: RequestInit) {
    const signal = this.signal(init.signal ?? undefined);
    signal.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      const start = this.ipfsStarts.then(async () => {
        signal.throwIfAborted();
        const headers = await this.ipfsHeaders();
        // Pace actual starts, including after an event-loop delay. This local
        // budget reduces bursts; the shared upstream limit remains authoritative.
        while (performance.now() < this.lastIpfsStart + 75)
          await delay(this.lastIpfsStart + 75 - performance.now(), undefined, {
            signal,
          });
        signal.throwIfAborted();
        this.lastIpfsStart = performance.now();
        // Release the scheduling turn after dispatch, without waiting for the
        // response headers/body. Requests and non-success statuses are not retried.
        resolve(
          fetch(`${this.api}/${path}`, {
            ...init,
            signal,
            headers,
            // Never send a storage credential to a redirected destination.
            redirect: 'error',
          }),
        );
      });
      this.ipfsStarts = start.catch(reject).finally(() => {
        signal.removeEventListener('abort', cancel);
      });
    });
  }
  private async store(id: string, name: string, data: Buffer) {
    if (this.records?.shared)
      throw new Error('Hosted media cannot write local files');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const bytes = Buffer.concat([cipher.update(data), cipher.final()]);
    const directory = join(LOCAL_DIR, 'private');
    const path = join(directory, `${id}-${name}.enc`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(Buffer.concat([iv, cipher.getAuthTag(), bytes]));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      const parent = await open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async load(id: string, name: string) {
    if (this.records?.shared)
      throw new Error('Hosted media cannot read local files');
    const input = await readFile(
      join(LOCAL_DIR, 'private', `${id}-${name}.enc`),
    );
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      input.subarray(0, 12),
    );
    decipher.setAuthTag(input.subarray(12, 28));
    return Buffer.concat([
      decipher.update(input.subarray(28)),
      decipher.final(),
    ]);
  }
  async saveUploadPart(id: string, index: number, bytes: Buffer) {
    await this.store(id, `part-${index}`, bytes);
  }
  async removePrepared(id: string) {
    if (this.records?.shared)
      throw new Error('Hosted media cannot delete local files');
    await Promise.all(
      [
        'original',
        'video.mp4',
        'poster.jpg',
        'manifest.json',
        'captions.vtt',
      ].map((name) =>
        rm(join(LOCAL_DIR, 'private', `${id}-${name}.enc`), { force: true }),
      ),
    );
  }
  async removeOrphanedPrepared(registered: Set<string>) {
    if (this.records?.shared)
      throw new Error('Hosted media cannot sweep local files');
    // Runs before HTTP starts, after the chain has loaded the registry. Parts
    // belong to resumable sessions and are managed separately by their TTL.
    for (const name of await readdir(join(LOCAL_DIR, 'private'))) {
      // Only startup calls this, before an ingestion worker or HTTP can write.
      if (/^[a-f0-9-]{36}-.+\.enc\.[a-f0-9-]{36}\.tmp$/.test(name)) {
        await rm(join(LOCAL_DIR, 'private', name), { force: true });
        continue;
      }
      const match =
        /^([a-f0-9-]{36})-(original|video\.mp4|poster\.jpg|manifest\.json|captions\.vtt)\.enc$/.exec(
          name,
        );
      if (match && !registered.has(match[1]))
        await rm(join(LOCAL_DIR, 'private', name), { force: true });
    }
  }
  async loadUploadPart(id: string, index: number) {
    return this.load(id, `part-${index}`);
  }
  async removeUploadParts(id: string, count: number) {
    if (this.records?.shared)
      throw new Error('Hosted media cannot delete local files');
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        rm(join(LOCAL_DIR, 'private', `${id}-part-${index}.enc`), {
          force: true,
        }),
      ),
    );
  }
  private async add(
    files: { name: string; data: Buffer }[],
    onlyHash: boolean,
    parent?: AbortSignal,
    short?: ShortRecord,
  ) {
    const signal = this.signal(parent, 60000);
    signal.throwIfAborted();
    const form = new FormData();
    for (const file of files)
      form.append('file', new Blob([new Uint8Array(file.data)]), file.name);
    if (!onlyHash && this.expiringWrites)
      return this.addWithIntent(
        form,
        true,
        short,
        short?.cid,
        'legacy',
        signal,
      );
    const response = await this.ipfsFetch(
      `add?wrap-with-directory=true&${SHORTS_IPFS_IMPORT_QUERY}&pin=${!onlyHash}&only-hash=${onlyHash}`,
      { method: 'POST', body: form, signal },
    );
    if (!response.ok) {
      discardShortsResponse(response);
      // Storage admission pauses writes under disk pressure or rate limits.
      // Keep the durable lifecycle job in capacity_wait, without spending its
      // failure attempts or retrying this upload outside the claimed job.
      if (response.status === 429 || response.status === 503)
        throw new ShortsMediaUnavailableError();
      throw new Error(`IPFS add failed (${response.status})`);
    }
    const bytes = await readShortsResponse(response, 16384, signal);
    let rows;
    try {
      rows = new TextDecoder('utf-8', { fatal: true })
        .decode(bytes)
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    } catch {
      throw new Error('Invalid IPFS add response');
    }
    if (rows.length > files.length + 1 || typeof rows.at(-1)?.Hash !== 'string')
      throw new Error('Invalid IPFS add response');
    return rows.at(-1).Hash as string;
  }
  async prepare(
    id: string,
    input: Buffer,
    title: string,
    topic: string,
    details: {
      description?: string;
      language?: string;
      synthetic?: boolean;
      sponsored?: boolean;
      captions?: string;
    } = {},
  ) {
    if (this.records?.shared)
      throw new Error('Hosted preparation requires the isolated media worker');
    if (!this.encoder) throw new Error('Local media encoder is unavailable');
    try {
      await this.store(id, 'original', input);
      const prepared = await this.encoder.encode(input, title, topic, details);
      const safety = await this.safety.scan(input);
      for (const file of prepared.files)
        await this.store(id, file.name, file.data);
      return {
        safety,
        cid: await this.add(prepared.files, true),
        bytes: prepared.bytes,
        duration: prepared.duration,
        files: prepared.files.map((file) => ({
          name: file.name,
          bytes: file.data.length,
          sha256: createHash('sha256').update(file.data).digest('hex'),
        })),
      };
    } catch (error) {
      await this.removePrepared(id);
      throw error;
    }
  }
  /** A prior interrupted handoff may have left a complete, reusable package. */
  async ensurePinned(short: ShortRecord, parent?: AbortSignal) {
    return this.withCapacity(short, parent, (signal) =>
      this.ensurePackage(short, signal),
    );
  }
  private async ensurePackage(short: ShortRecord, signal: AbortSignal) {
    signal.throwIfAborted();
    if (validateOriginalContent(short)) return this.pinOriginal(short, signal);
    if (!(await this.pinned(short.cid, signal))) {
      await this.pinPackage(short, signal);
      return;
    }
    // Recursive pin presence alone is not proof of the expected file hashes.
    for (const file of short.files) {
      signal.throwIfAborted();
      await this.retrieveFile(short, file.name, signal);
    }
    signal.throwIfAborted();
  }
  async pin(short: ShortRecord, parent?: AbortSignal) {
    return this.withCapacity(short, parent, (signal) =>
      this.pinPackage(short, signal),
    );
  }
  /** Repair permanent source/assets after the generation's inputs were retired. */
  async restoreDurablePins(short: ShortRecord, parent?: AbortSignal) {
    if (!validateOriginalContent(short))
      throw new Error('Original delivery required');
    return this.withCapacity(short, parent, (signal) =>
      this.pinOriginal(short, signal, false),
    );
  }
  private async pinPackage(short: ShortRecord, parent?: AbortSignal) {
    if (validateOriginalContent(short))
      return this.pinOriginal(short, this.signal(parent));
    const controller = new AbortController();
    const signal = this.signal(
      parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    );
    try {
      signal.throwIfAborted();
      const results = await Promise.allSettled(
        short.files.map(async (f) => {
          try {
            return {
              name: f.name,
              data: await this.preparedFile(short, f.name, signal),
            };
          } catch (error) {
            controller.abort();
            throw error;
          }
        }),
      );
      // Drain cancelled siblings before releasing lifecycle admission.
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      signal.throwIfAborted();
      const files = results.map(
        (result) =>
          (result as PromiseFulfilledResult<{ name: string; data: Buffer }>)
            .value,
      );
      if (
        short.privateMedia &&
        (await new ShortsPackageService().cid(files, signal)) !== short.cid
      )
        throw new Error('Prepared package identity mismatch');
      signal.throwIfAborted();
      if ((await this.add(files, false, signal, short)) !== short.cid)
        throw new Error('IPFS commitment mismatch');
      for (const f of short.files)
        await this.retrieveFile(short, f.name, signal);
      signal.throwIfAborted();
      this.rememberPin(short.cid);
    } finally {
      controller.abort();
    }
  }
  private async addFiles(
    files: (ShortsMediaFile & { name: string })[],
    directory: boolean,
    parent: AbortSignal,
    short: ShortRecord,
    cid: string,
    purpose: PinPurpose,
  ) {
    const signal = this.signal(parent, 120000);
    const form = new FormData();
    for (const file of files) {
      signal.throwIfAborted();
      form.append('file', await openAsBlob(file.path), file.name);
    }
    if (this.expiringWrites)
      return this.addWithIntent(form, directory, short, cid, purpose, signal);
    const response = await this.ipfsFetch(
      `add?wrap-with-directory=${directory}&${SHORTS_IPFS_IMPORT_QUERY}&pin=true&only-hash=false`,
      { method: 'POST', body: form, signal },
    );
    if (!response.ok) {
      discardShortsResponse(response);
      if ([429, 503].includes(response.status))
        throw new ShortsMediaUnavailableError();
      throw new Error('Original media pin unavailable');
    }
    const rows = new TextDecoder('utf-8', { fatal: true })
      .decode(await readShortsResponse(response, 16384, signal))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (
      !rows.length ||
      rows.length > files.length + (directory ? 1 : 0) ||
      !/^b[a-z2-7]{20,118}$/.test(rows.at(-1)?.Hash || '')
    )
      throw new Error('Invalid IPFS add response');
    return rows.at(-1).Hash as string;
  }
  private async addWithIntent(
    form: FormData,
    directory: boolean,
    short: ShortRecord,
    cid: string,
    purpose: PinPurpose,
    signal: AbortSignal,
  ) {
    if (!short || !this.records?.shared || !this.pinTransfers)
      throw new Error('Pin transfer metadata unavailable');
    signal.throwIfAborted();
    const intent = await this.pinTransfers.begin(this.scope(), {
      cid,
      jobId: short.id,
      purpose,
    });
    let sent = false;
    let rejected = false;
    try {
      if (intent.state !== 'issued' || intent.expires <= Date.now())
        throw new Error('Pin transfer authority expired');
      const capabilitySignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(5000),
      ]);
      const response = await this.ipfsFetch('shorts/capabilities', {
        method: 'POST',
        signal: capabilitySignal,
      });
      if (response.status !== 200) {
        discardShortsResponse(response);
        if ([429, 503].includes(response.status))
          throw new ShortsMediaUnavailableError();
        throw new Error('Expiring storage protocol unavailable');
      }
      const caps = await readShortsJson(response, 2048, capabilitySignal);
      const now = Date.now();
      if (
        caps?.version !== 1 ||
        caps.addVersion !== 1 ||
        caps.epochVersion !== 1 ||
        typeof caps.nodeEpoch !== 'string' ||
        !/^[a-f0-9]{64}$/.test(caps.nodeEpoch) ||
        typeof caps.peerId !== 'string' ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,120}$/.test(caps.peerId) ||
        caps.writing !== false ||
        caps.uncertain !== false ||
        caps.addMaxLifetimeMs !== 300000 ||
        caps.addTimeoutMs !== 120000 ||
        typeof caps.legacyWritesEnabled !== 'boolean' ||
        !Number.isSafeInteger(caps.serverTimeUnixMs) ||
        Math.abs(caps.serverTimeUnixMs - now) > 5000 ||
        Math.abs(Date.parse(intent.issuedAt) - now) > 5000
      )
        throw new Error(
          'Storage protocol or clock synchronization unavailable',
        );
      const bound = await this.pinTransfers.bind(intent.operationId, {
        peerId: caps.peerId,
        epoch: caps.nodeEpoch,
      });
      if (
        bound.state !== 'issued' ||
        bound.expires !== intent.expires ||
        Date.now() >= intent.expires
      )
        throw new Error('Pin transfer authority expired');
      const active = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, intent.expires - Date.now())),
      ]);
      active.throwIfAborted();
      const query = new URLSearchParams({
        expected: cid,
        epoch: caps.nodeEpoch,
        operation: intent.operationId,
        expires: String(intent.expires),
        'wrap-with-directory': String(directory),
        ...SHORTS_IPFS_IMPORT_OPTIONS,
        pin: 'true',
        'only-hash': 'false',
      });
      sent = true;
      const pinned = await this.ipfsFetch(`shorts/add?${query}`, {
        method: 'POST',
        body: form,
        signal: active,
      });
      if (pinned.status !== 200) {
        discardShortsResponse(pinned);
        rejected = [400, 401, 403, 409, 413, 415, 422, 429].includes(
          pinned.status,
        );
        if ([429, 503].includes(pinned.status))
          throw new ShortsMediaUnavailableError();
        throw new Error('Expiring IPFS import refused');
      }
      const receipt = await readShortsJson(pinned, 2048, active);
      if (
        receipt?.version !== 1 ||
        receipt.cid !== cid ||
        receipt.operation !== intent.operationId ||
        receipt.expires !== intent.expires ||
        receipt.status !== 'pinned' ||
        receipt.epoch !== caps.nodeEpoch
      )
        throw new Error('IPFS pin receipt does not match transfer');
      active.throwIfAborted();
      await this.pinTransfers.finish(intent.operationId, 'pinned');
      return cid;
    } catch (error) {
      // A failed metadata write leaves the durable issued row closed as well.
      // Never erase an ambiguous importer merely because its HTTP lease expired.
      await this.pinTransfers
        .finish(
          intent.operationId,
          !sent || rejected ? 'rejected' : 'uncertain',
        )
        .catch(() => {});
      throw error;
    }
  }
  private async verifyPinnedBytes(
    cid: string,
    path: string | undefined,
    identity: Pick<ShortsMediaFile, 'bytes' | 'sha256'>,
    parent: AbortSignal,
  ) {
    const signal = this.signal(parent, 120000);
    const response = await this.ipfsFetch(
      `cat?arg=${encodeURIComponent(path ? `${cid}/${path}` : cid)}`,
      { method: 'POST', signal },
    );
    if (!response.ok || !response.body) {
      discardShortsResponse(response);
      throw new Error('Pinned media unavailable');
    }
    for await (const chunk of verifiedMediaBytes(
      response.body as unknown as AsyncIterable<Uint8Array>,
      identity,
      signal,
    )) {
      // Consume through verification without retaining media in memory.
      void chunk;
    }
  }
  /** Download only the canonical original; callers receive a verified owned file. */
  async withPinnedOriginal<T>(
    short: ShortRecord,
    work: (file: ShortsMediaFile, signal: AbortSignal) => Promise<T>,
    parent?: AbortSignal,
  ): Promise<T> {
    if (!validateOriginalContent(short) || !this.scratch)
      throw new Error('Original restaging is unavailable');
    return this.withCapacity(short, parent, async (active) => {
      const reservation = await this.scratch.reserve(short.bytes, 4, active);
      const signal = AbortSignal.any([active, reservation.signal]);
      let directory: string | undefined;
      try {
        if (!(await this.pinned(short.cid, signal)))
          throw new Error('Canonical original is not recursively pinned');
        directory = await mkdtemp(
          join(this.scratch.directory, 'shorts-restage-'),
        );
        const path = join(directory, 'original');
        const output = await open(path, 'wx', 0o600);
        const identity = { bytes: short.bytes, sha256: short.original.sha256 };
        try {
          const response = await this.ipfsFetch(
            `cat?arg=${encodeURIComponent(short.cid)}`,
            { method: 'POST', signal },
          );
          if (!response.ok || !response.body) {
            discardShortsResponse(response);
            throw new Error('Canonical original is unavailable');
          }
          for await (const chunk of verifiedMediaBytes(
            response.body as unknown as AsyncIterable<Uint8Array>,
            identity,
            signal,
          ))
            await output.writeFile(chunk, { signal });
        } finally {
          await output.close();
        }
        const file = { path, ...identity };
        if (
          (await new ShortsPackageService().originalCid(file, signal)) !==
          short.cid
        )
          throw new Error('Canonical original CID mismatch');
        if (!(await this.pinned(short.cid, signal)))
          throw new Error('Canonical original pin changed during restaging');
        signal.throwIfAborted();
        return await work(file, signal);
      } finally {
        try {
          if (directory) await rm(directory, { recursive: true, force: true });
        } finally {
          reservation.release();
        }
      }
    });
  }
  private preparedDelivery(
    short: ShortRecord,
    descriptor: PlaybackDescriptor,
    value: HlsPackage,
  ) {
    validateOriginalContent(short);
    const expected = {
      ...shortsPlaybackDescriptor(short, {
        network: descriptor.network,
        contract: descriptor.contract,
      }),
      id: descriptor.id,
    };
    if (deliverySourceIdentity(expected) !== deliverySourceIdentity(descriptor))
      throw new Error('Prepared delivery source mismatch');
    return validateSourcePackage(descriptor, value);
  }
  /** Read every acknowledged HLS file before a coordinator records readiness. */
  async verifyPreparedDelivery(
    short: ShortRecord,
    descriptor: PlaybackDescriptor,
    value: HlsPackage,
    parent?: AbortSignal,
  ) {
    const prepared = this.preparedDelivery(short, descriptor, value);
    return this.withCapacity(
      short,
      parent,
      async (signal) => {
        if (!(await this.pinned(prepared.cid, signal)))
          throw new Error('Prepared HLS is not recursively pinned');
        for (const file of prepared.files)
          await this.verifyPinnedBytes(prepared.cid, file.name, file, signal);
        for (const cid of [
          short.cid,
          ...(short.derivatives ? [short.derivatives.assetsCid] : []),
          prepared.cid,
        ])
          if (!(await this.pinned(cid, signal)))
            throw new Error('Durable delivery pin changed');
        signal.throwIfAborted();
        return prepared;
      },
      true,
    );
  }
  /** Verify retained playback without restoring temporary encoded inputs. */
  async verifyDurableDelivery(
    short: ShortRecord,
    descriptor: PlaybackDescriptor,
    value: HlsPackage,
    parent?: AbortSignal,
  ) {
    const original = validateOriginalContent(short);
    this.preparedDelivery(short, descriptor, value);
    await this.withCapacity(
      short,
      parent,
      async (signal) => {
        if (!original) {
          for (const file of descriptor.files)
            await this.verifyPinnedBytes(short.cid, file.name, file, signal);
          return;
        }
        await this.verifyPinnedBytes(
          short.cid,
          undefined,
          { bytes: short.bytes, sha256: short.original.sha256 },
          signal,
        );
        for (const file of derivedFiles(short.files, 'assets'))
          await this.verifyPinnedBytes(
            short.derivatives.assetsCid,
            file.name,
            file,
            signal,
          );
      },
      true,
    );
    return this.verifyPreparedDelivery(short, descriptor, value, parent);
  }
  private async pinOriginal(
    short: ShortRecord,
    signal: AbortSignal,
    includeInputs = true,
  ) {
    if (!validateOriginalContent(short) || !this.privateMedia)
      throw new Error('Original media unavailable');
    const packages = new ShortsPackageService();
    if (!(await this.pinned(short.cid, signal))) {
      await this.privateMedia.withOriginal(
        this.scope(),
        short,
        async (file, active) => {
          if ((await packages.originalCid(file, active)) !== short.cid)
            throw new Error('Original CID mismatch');
          if (
            (await this.addFiles(
              [{ ...file, name: 'original.mp4' }],
              false,
              active,
              short,
              short.cid,
              'original',
            )) !== short.cid
          )
            throw new Error('Original IPFS commitment mismatch');
        },
        signal,
      );
    }
    await this.verifyPinnedBytes(
      short.cid,
      undefined,
      { bytes: short.bytes, sha256: short.original.sha256 },
      signal,
    );
    for (const kind of ['assets', 'inputs'] as const) {
      if (kind === 'inputs' && !includeInputs) continue;
      const cid =
        kind === 'assets' ? short.derivatives.assetsCid : short.derivatives.cid;
      if (!(await this.pinned(cid, signal))) {
        await this.privateMedia.withDerivedPackage(
          this.scope(),
          short,
          kind,
          async (files, active) => {
            if ((await packages.derivativeCid(files, kind, active)) !== cid)
              throw new Error('Derivative CID mismatch');
            if (
              (await this.addFiles(files, true, active, short, cid, kind)) !==
              cid
            )
              throw new Error('Derivative IPFS commitment mismatch');
          },
          signal,
        );
      }
      for (const file of derivedFiles(short.files, kind))
        await this.verifyPinnedBytes(cid, file.name, file, signal);
      signal.throwIfAborted();
      this.rememberPin(cid);
    }
    signal.throwIfAborted();
    this.rememberPin(short.cid);
  }
  async preview(short: ShortRecord) {
    return this.withCapacity(short, undefined, (signal) =>
      validateOriginalContent(short) &&
      (short.publication === 'published' || short.publication === 'withdrawn')
        ? this.retrieveFile(short, 'video.mp4', signal)
        : this.preparedFile(short, 'video.mp4', signal),
    );
  }
  async rescan(short: ShortRecord, parent?: AbortSignal) {
    const originalFormat = validateOriginalContent(short);
    // Published originals remain the inspection source after staging retirement.
    // Do not nest admission: withPinnedOriginal owns its transfer and scratch.
    if (
      originalFormat &&
      (short.publication === 'published' || short.publication === 'withdrawn')
    )
      return this.withPinnedOriginal(
        short,
        (file, signal) => this.safety.scan(file, signal, true),
        parent,
      );
    return this.withCapacity(short, parent, async (signal) => {
      if (originalFormat) {
        if (!this.privateMedia) throw new Error('Original source unavailable');
        return this.privateMedia.withOriginal(
          this.scope(),
          short,
          (file, active) => this.safety.scan(file, active, true),
          signal,
        );
      }
      const original = short.privateMedia
        ? await this.privateMedia?.original(this.scope(), short, signal)
        : await this.load(short.id, 'original');
      if (!original) throw new Error('Shared private media is unavailable');
      signal.throwIfAborted();
      const result = await this.safety.scan(original, signal, true);
      signal.throwIfAborted();
      return result;
    });
  }
  async retrieve(short: ShortRecord, name: string, parent?: AbortSignal) {
    return this.withCapacity(short, parent, (signal) =>
      this.retrieveFile(short, name, signal),
    );
  }
  private async retrieveFile(
    short: ShortRecord,
    name: string,
    parent?: AbortSignal,
  ) {
    validateOriginalContent(short);
    const entry = short.files.find((f) => f.name === name);
    if (!entry) throw new Error('Unknown media file');
    if (
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      entry.bytes > 64 * 1024 * 1024
    )
      throw new Error('Invalid media manifest size');
    const signal = this.signal(parent, 5000);
    signal.throwIfAborted();
    const response = await this.ipfsFetch(
      `cat?arg=${encodeURIComponent(`${derivedFileCid(short, name)}/${name}`)}`,
      { method: 'POST', signal },
    );
    if (!response.ok) {
      discardShortsResponse(response);
      throw new Error('IPFS media unavailable');
    }
    const data = await readShortsResponse(response, entry.bytes, signal);
    if (
      data.length !== entry.bytes ||
      createHash('sha256').update(data).digest('hex') !== entry.sha256
    )
      throw new Error('IPFS media integrity check failed');
    return data;
  }
  async health() {
    try {
      const response = await this.ipfsFetch('id', {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      });
      discardShortsResponse(response);
      return response.ok;
    } catch {
      return false;
    }
  }
  async pins(): Promise<Set<string>> {
    const signal = AbortSignal.timeout(10000);
    const response = await this.ipfsFetch('pin/ls?type=recursive', {
      method: 'POST',
      signal,
    });
    if (!response.ok) {
      discardShortsResponse(response);
      throw new Error('Cannot inspect IPFS pins');
    }
    const body = await readShortsJson(response, 262144, signal);
    if (!body.Keys || typeof body.Keys !== 'object' || Array.isArray(body.Keys))
      throw new Error('Cannot inspect IPFS pins');
    const keys = Object.keys(body.Keys);
    if (keys.length > 4096)
      throw new Error('IPFS pin inventory exceeds local limit');
    this.pinnedCids = new Set(keys);
    return new Set(this.pinnedCids);
  }
  hasPin(cid: string) {
    return this.pinnedCids.has(cid);
  }
  private rememberPin(cid: string) {
    this.pinnedCids.delete(cid);
    this.pinnedCids.add(cid);
    while (this.pinnedCids.size > 256)
      this.pinnedCids.delete(this.pinnedCids.values().next().value!);
  }
  /** Read the strict lifecycle protocol and current storage-process health. */
  async reclamationStorage(parent: AbortSignal) {
    const signal = this.signal(parent, 5000);
    const response = await this.ipfsFetch('shorts/capabilities', {
      method: 'POST',
      signal,
    });
    if (response.status !== 200) {
      discardShortsResponse(response);
      throw new Error('Storage reclamation protocol unavailable');
    }
    return reclamationStorage(await readShortsJson(response, 2048, signal));
  }
  /** Only the lifecycle coordinator may supply an issued, durably bound permit. */
  async reclaimInputPin(permit: InputReclamationPermit, parent: AbortSignal) {
    const now = Date.now();
    if (
      !permit.storage ||
      permit.state !== 'issued' ||
      permit.expires <= now ||
      permit.expires - now > 25000 ||
      !/^b[a-z2-7]{58}$/.test(permit.inputCid)
    )
      throw new Error('Current bound reclamation authority is required');
    const signal = this.signal(parent, Math.min(15000, permit.expires - now));
    signal.throwIfAborted();
    const query = new URLSearchParams({
      arg: permit.inputCid,
      operation: permit.operationId,
      expires: String(permit.expires),
      epoch: permit.storage.epoch,
    });
    const response = await this.ipfsFetch(`shorts/unpin?${query}`, {
      method: 'POST',
      signal,
    });
    if (response.status !== 200) {
      discardShortsResponse(response);
      throw new Error('Input unpin outcome unavailable');
    }
    const receipt = await readShortsJson(response, 2048, signal);
    if (
      receipt?.version !== 1 ||
      receipt.cid !== permit.inputCid ||
      receipt.operation !== permit.operationId ||
      receipt.expires !== permit.expires ||
      receipt.epoch !== permit.storage.epoch ||
      !['removed', 'not-pinned'].includes(receipt.status)
    )
      throw new Error('Input unpin receipt mismatch');
    signal.throwIfAborted();
    this.pinnedCids.delete(permit.inputCid);
    return receipt.status as 'removed' | 'not-pinned';
  }
  /** Inspect one recursive pin; an unavailable node is never interpreted as absence. */
  async pinned(cid: string, parent?: AbortSignal) {
    if (!/^[a-zA-Z0-9]{1,120}$/.test(cid)) throw new Error('Invalid IPFS CID');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const signal = this.signal(
      parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    );
    try {
      signal.throwIfAborted();
      const response = await this.ipfsFetch(
        `pin/ls?arg=${encodeURIComponent(cid)}&type=recursive`,
        {
          method: 'POST',
          signal,
        },
      );
      const body = await readShortsJson(response, 16384, signal);
      if (
        response.status === 500 &&
        body.Code === 0 &&
        body.Message === `path '${cid}' is not pinned`
      ) {
        this.pinnedCids.delete(cid);
        return false;
      }
      if (
        !response.ok ||
        !body.Keys ||
        Object.keys(body.Keys).length !== 1 ||
        body.Keys[cid]?.Type !== 'recursive'
      )
        throw new Error('Cannot inspect IPFS pin');
      this.rememberPin(cid);
      return true;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async unpin(cid: string) {
    if (!this.pinnedCids.has(cid)) return;
    const response = await this.ipfsFetch(
      `pin/rm?arg=${encodeURIComponent(cid)}`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      },
    );
    discardShortsResponse(response);
    if (!response.ok) throw new Error('Cannot remove IPFS pin');
    this.pinnedCids.delete(cid);
  }
  async onModuleDestroy() {
    this.shutdown.abort();
    await Promise.allSettled(this.operations);
  }
}
