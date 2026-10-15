import {
  BadRequestException,
  Inject,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { ShortsScope } from './shorts-metadata.service';

export const SHORTS_PRIVATE_OBJECT_CONFIG = Symbol(
  'SHORTS_PRIVATE_OBJECT_CONFIG',
);
const MAX_BYTES = 64 * 1024 * 1024;
const MAGIC = Buffer.from('SHPRIV01');
const OVERHEAD = MAGIC.length + 12 + 16;
const hash = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');

/** Internal database reference. Never return this or an S3 URL to the browser. */
export interface PrivateObjectRef {
  key: string;
  keyId: string;
  bytes: number;
  sha256: string;
}
export interface PrivateBucketConfig {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}
export interface PrivateObjectConfig extends PrivateBucketConfig {
  activeKeyId: string;
  keys: Record<string, Buffer>;
}

async function secretJson(path: string) {
  if (!path || !isAbsolute(path))
    throw new Error('Private storage requires absolute secret-file paths');
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0)
      throw new Error(
        'Private storage secrets must be owner-only regular files, at most 16 KiB',
      );
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384)
      throw new Error('Private storage secret file is too large');
    try {
      return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    } catch {
      // JSON parser messages can include pieces of a malformed secret.
      throw new Error('Invalid private storage secret JSON');
    }
  } finally {
    await file.close();
  }
}

/** Explicit credentials only: never fall through to a machine's ambient AWS role. */
export async function privateBucketConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PrivateBucketConfig> {
  const endpoint = new URL(env.SHORTS_PRIVATE_S3_ENDPOINT || '');
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(
    endpoint.hostname,
  );
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/' ||
    (endpoint.protocol !== 'https:' &&
      !(
        endpoint.protocol === 'http:' &&
        loopback &&
        env.NODE_ENV !== 'production' &&
        env.SHORTS_PRIVATE_S3_ALLOW_LOOPBACK === '1'
      ))
  )
    throw new Error(
      'Private S3 requires an HTTPS origin; explicit loopback HTTP is for tests only',
    );
  const region = env.SHORTS_PRIVATE_S3_REGION || '';
  const bucket = env.SHORTS_PRIVATE_S3_BUCKET || '';
  const prefix = env.SHORTS_PRIVATE_S3_PREFIX || 'shorts-private-v1';
  const pathStyle = env.SHORTS_PRIVATE_S3_PATH_STYLE ?? 'true';
  if (
    !/^[a-zA-Z0-9-]{1,64}$/.test(region) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    bucket.includes('..') ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(prefix) ||
    !['true', 'false'].includes(pathStyle)
  )
    throw new Error(
      'Invalid private S3 region, bucket, prefix or path-style setting',
    );
  const credentials = await secretJson(env.SHORTS_PRIVATE_S3_CREDENTIALS_FILE);
  if (
    !credentials ||
    typeof credentials.accessKeyId !== 'string' ||
    !credentials.accessKeyId ||
    typeof credentials.secretAccessKey !== 'string' ||
    !credentials.secretAccessKey ||
    (credentials.sessionToken !== undefined &&
      typeof credentials.sessionToken !== 'string')
  )
    throw new Error('Invalid private S3 credential file');
  return {
    endpoint: endpoint.origin,
    region,
    bucket,
    prefix,
    forcePathStyle: pathStyle === 'true',
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken
        ? { sessionToken: credentials.sessionToken }
        : {}),
    },
  };
}

export async function privateObjectConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PrivateObjectConfig> {
  const bucket = await privateBucketConfig(env);
  const ring = await secretJson(env.SHORTS_PRIVATE_ENCRYPTION_KEYS_FILE);
  if (
    !ring ||
    typeof ring.activeKeyId !== 'string' ||
    !ring.keys ||
    Array.isArray(ring.keys) ||
    typeof ring.keys !== 'object' ||
    Object.keys(ring.keys).length > 8
  )
    throw new Error('Invalid private encryption key ring');
  const keys: Record<string, Buffer> = Object.create(null);
  for (const [id, value] of Object.entries(ring.keys)) {
    if (
      !/^[a-zA-Z0-9_-]{1,32}$/.test(id) ||
      typeof value !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value)
    )
      throw new Error('Private encryption keys must be named 256-bit hex keys');
    keys[id] = Buffer.from(value, 'hex');
  }
  if (!Object.hasOwn(keys, ring.activeKeyId))
    throw new Error('Active private encryption key is missing');
  return {
    ...bucket,
    activeKeyId: ring.activeKeyId,
    keys,
  };
}

/** Immutable encrypted quarantine objects; deliberately no list, delete or public URL API. */
@Injectable()
export class ShortsPrivateObjectsService implements OnModuleDestroy {
  private readonly client: S3Client;
  constructor(
    @Inject(SHORTS_PRIVATE_OBJECT_CONFIG)
    private readonly config: PrivateObjectConfig,
  ) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: config.credentials,
      forcePathStyle: config.forcePathStyle,
      followRegionRedirects: false,
      maxAttempts: 2,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: {
        connectionTimeout: 5000,
        requestTimeout: 60000,
        throwOnRequestTimeout: true,
      },
    });
  }
  onModuleDestroy() {
    this.client.destroy();
  }

  private prefix(scope: ShortsScope) {
    if (
      !['ae_uat', 'ae_mainnet'].includes(scope?.network) ||
      !/^ct_[a-zA-Z0-9]{1,97}$/.test(scope.contract)
    )
      throw new BadRequestException('Invalid private object scope');
    return `${this.config.prefix}/${hash(JSON.stringify([scope.network, scope.contract]))}/`;
  }
  validateReference(scope: ShortsScope, ref: PrivateObjectRef) {
    if (
      !ref ||
      typeof ref.key !== 'string' ||
      ref.key.length > 512 ||
      !ref.key.startsWith(this.prefix(scope)) ||
      !/^[a-zA-Z0-9_/-]+$/.test(ref.key) ||
      ref.key.includes('//') ||
      !/^[a-zA-Z0-9_-]{1,32}$/.test(ref.keyId) ||
      !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      !ref.key.endsWith(`/${ref.keyId}/${ref.sha256}`) ||
      !Number.isSafeInteger(ref.bytes) ||
      ref.bytes < 1 ||
      ref.bytes > MAX_BYTES
    )
      throw new BadRequestException('Invalid private object reference');
    if (!Object.hasOwn(this.config.keys, ref.keyId))
      throw new ServiceUnavailableException(
        'Private media encryption key is unavailable',
      );
  }
  private aad(ref: PrivateObjectRef) {
    return Buffer.from(
      JSON.stringify([1, ref.key, ref.keyId, ref.sha256, ref.bytes]),
    );
  }
  async put(
    scope: ShortsScope,
    uploadId: string,
    slot: string,
    bytes: Buffer,
    signal?: AbortSignal,
  ): Promise<PrivateObjectRef> {
    signal?.throwIfAborted();
    if (
      !/^[a-zA-Z0-9_-]{1,80}$/.test(uploadId) ||
      !/^[a-z0-9_-]{1,40}(\/[a-z0-9_-]{1,40}){0,3}$/.test(slot) ||
      !Buffer.isBuffer(bytes) ||
      !bytes.length ||
      bytes.length > MAX_BYTES
    )
      throw new BadRequestException('Invalid private media object');
    const sha256 = hash(bytes),
      keyId = this.config.activeKeyId;
    const ref = {
      key: `${this.prefix(scope)}${uploadId}/${slot}/${keyId}/${sha256}`,
      keyId,
      bytes: bytes.length,
      sha256,
    };
    this.validateReference(scope, ref);
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.config.keys[keyId], iv);
    cipher.setAAD(this.aad(ref));
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const body = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
    const abortSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: ref.key,
          Body: body,
          IfNoneMatch: '*',
          ContentType: 'application/octet-stream',
          ContentLength: body.length,
          CacheControl: 'no-store',
          ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
        }),
        { abortSignal },
      );
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 412
      ) {
        // The first writer may have succeeded before its response was lost.
        // Check the actual immutable content; never trust ETag or metadata alone.
        await this.get(scope, ref, abortSignal);
      } else {
        throw new ServiceUnavailableException(
          'Private media storage is unavailable',
        );
      }
    }
    return ref;
  }
  async get(
    scope: ShortsScope,
    ref: PrivateObjectRef,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    this.validateReference(scope, ref);
    const abortSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000);
    let stream: Readable;
    const abort = () =>
      stream?.destroy(new Error('Private media read aborted'));
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: ref.key }),
        { abortSignal },
      );
      stream = response.Body as Readable;
      if (
        !(stream instanceof Readable) ||
        response.ContentLength !== ref.bytes + OVERHEAD
      )
        throw new Error('Private media length mismatch');
      abortSignal.addEventListener('abort', abort, { once: true });
      if (abortSignal.aborted) abort();
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of stream) {
        const data = Buffer.from(chunk);
        length += data.length;
        if (length > ref.bytes + OVERHEAD)
          throw new Error('Private media exceeded expected size');
        chunks.push(data);
      }
      const body = Buffer.concat(chunks);
      if (length !== ref.bytes + OVERHEAD || !body.subarray(0, 8).equals(MAGIC))
        throw new Error('Invalid private media envelope');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.config.keys[ref.keyId],
        body.subarray(8, 20),
      );
      decipher.setAuthTag(body.subarray(20, 36));
      decipher.setAAD(this.aad(ref));
      const plain = Buffer.concat([
        decipher.update(body.subarray(36)),
        decipher.final(),
      ]);
      if (hash(plain) !== ref.sha256)
        throw new Error('Private media hash mismatch');
      return plain;
    } catch (error) {
      throw new ServiceUnavailableException(
        'Private media could not be verified',
      );
    } finally {
      abortSignal.removeEventListener('abort', abort);
      stream?.destroy();
    }
  }
}
