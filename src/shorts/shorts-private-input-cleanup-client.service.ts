import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { discardShortsResponse, readShortsJson } from './shorts-upstream';
import { privateCleanupVerifications } from './shorts-private-cleanup-batch';

/** Metadata-only verifier client. No IPFS, streaming or publication credentials. */
@Injectable()
export class ShortsPrivateInputCleanupClientService {
  private readonly endpoint = process.env.SHORTS_STORAGE_CONTROL_URL;
  private readonly keyFile = process.env.SHORTS_STORAGE_CONTROL_TOKEN_FILE;
  constructor() {
    if (this.endpoint) {
      const url = new URL(this.endpoint);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/' ||
        (url.protocol !== 'https:' &&
          !(
            url.protocol === 'http:' &&
            ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
            process.env.NODE_ENV !== 'production'
          )) ||
        !this.keyFile ||
        !isAbsolute(this.keyFile)
      )
        throw new Error(
          'Storage control requires an HTTPS origin and absolute credential path',
        );
    }
  }
  private async request(
    path: string,
    body: unknown,
    limit: number,
    parent: AbortSignal,
  ) {
    if (!this.endpoint)
      throw new Error('Private cleanup verifier is not configured');
    const signal = AbortSignal.any([parent, AbortSignal.timeout(300000)]);
    signal.throwIfAborted();
    const key = (
      await readFile(this.keyFile!, { encoding: 'utf8', signal })
    ).trim();
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error('Invalid storage control credential');
    const response = await fetch(
      new URL(
        `/api/shorts/internal/private-input-cleanup/${path}`,
        this.endpoint,
      ),
      {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (response.status !== 200) {
      await discardShortsResponse(response);
      throw new Error('Private cleanup verification unavailable');
    }
    return readShortsJson(response, limit, signal);
  }
  private proof(proof: any, operation: string, verification: string) {
    if (
      !proof ||
      Array.isArray(proof) ||
      Object.keys(proof).sort().join(',') !==
        'expires_at,id,operation_id,verified_at' ||
      proof.id !== verification ||
      proof.operation_id !== operation ||
      typeof proof.verified_at !== 'string' ||
      typeof proof.expires_at !== 'string' ||
      !Number.isFinite(Date.parse(proof.verified_at)) ||
      !Number.isFinite(Date.parse(proof.expires_at)) ||
      Date.parse(proof.expires_at) - Date.parse(proof.verified_at) !== 30000
    )
      throw new Error('Invalid private cleanup verification response');
    // SQL owns expiry and dispatch authority; client clocks never extend either.
    return { id: verification };
  }
  async verify(operation: string, verification: string, parent: AbortSignal) {
    privateCleanupVerifications([
      { operationId: operation, verificationId: verification },
    ]);
    return this.proof(
      await this.request(
        `${operation}/verify`,
        { verificationId: verification },
        4096,
        parent,
      ),
      operation,
      verification,
    );
  }
  async verifyMany(input: unknown, parent: AbortSignal) {
    const requests = privateCleanupVerifications(input);
    const response = await this.request(
      'verify-batch',
      { operations: requests },
      65536,
      parent,
    );
    if (
      !response ||
      Array.isArray(response) ||
      Object.keys(response).length !== 1 ||
      !Array.isArray(response.proofs) ||
      response.proofs.length !== requests.length
    )
      throw new Error('Invalid private cleanup batch response');
    const proofs = new Map<string, any>();
    for (const proof of response.proofs) {
      if (
        !proof ||
        typeof proof.operation_id !== 'string' ||
        proofs.has(proof.operation_id)
      )
        throw new Error('Invalid private cleanup batch response');
      proofs.set(proof.operation_id, proof);
    }
    return requests.map((request) =>
      this.proof(
        proofs.get(request.operationId),
        request.operationId,
        request.verificationId,
      ),
    );
  }
}
