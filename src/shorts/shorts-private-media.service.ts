import { Injectable } from '@nestjs/common';
import { ShortsPrivateObjectsService } from './shorts-private-objects.service';
import { ShortsSourceService } from './shorts-source.service';
import { ShortsScope } from './shorts-metadata.service';
import { ShortRecord } from './shorts.types';
import {
  ShortsScratchService,
  ScratchCapacityError,
} from './shorts-scratch.service';
import { ShortsMediaFile } from './shorts-media-file';
import {
  validateOriginalContent,
  derivedFiles,
  ShortsDerivedPackage,
} from './shorts-original-content';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { shortsDeliverySource } from './shorts-delivery-source';

@Injectable()
export class ShortsPrivateMediaService {
  constructor(
    private readonly objects: ShortsPrivateObjectsService,
    private readonly sources: ShortsSourceService,
    private readonly scratch: ShortsScratchService,
  ) {}
  private async withScratch<T>(
    bytes: number,
    parent: AbortSignal | undefined,
    work: (directory: string, signal: AbortSignal) => Promise<T>,
  ) {
    const reservation = await this.scratch.reserve(bytes, 16, parent);
    const signal = AbortSignal.any([
      reservation.signal,
      ...(parent ? [parent] : []),
    ]);
    let directory: string | undefined;
    try {
      signal.throwIfAborted();
      directory = await mkdtemp(
        join(this.scratch.directory, 'shorts-transfer-'),
      );
      return await work(directory, signal);
    } catch (error) {
      if (reservation.signal.reason instanceof ScratchCapacityError)
        throw reservation.signal.reason;
      throw error;
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        reservation.release();
      }
    }
  }
  withOriginal<T>(
    scope: ShortsScope,
    short: ShortRecord,
    work: (file: ShortsMediaFile, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ) {
    if (!validateOriginalContent(short) || !short.privateMedia)
      throw new Error('Original source unavailable');
    return this.withScratch(short.bytes, signal, async (directory, active) => {
      const file = await this.sources.readToFile(
        scope,
        {
          id: short.id,
          creator: short.creator,
          input: short.privateMedia.source,
        },
        join(directory, 'original'),
        active,
      );
      return work(file, active);
    });
  }
  /** Bounded authenticated legacy upload read; never reads the compressed package as a source. */
  withRetainedOriginal<T>(
    scope: ShortsScope,
    short: ShortRecord,
    work: (file: ShortsMediaFile, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ) {
    const source = shortsDeliverySource(short);
    if (source.kind !== 'retained-upload')
      throw new Error('Retained legacy source required');
    return this.withScratch(source.bytes, signal, async (directory, active) => {
      const file = await this.sources.readToFile(
        scope,
        {
          id: short.id,
          creator: short.creator,
          input: short.privateMedia.source,
        },
        join(directory, 'original'),
        active,
      );
      if (file.bytes !== source.bytes || file.sha256 !== source.sha256)
        throw new Error('Retained source identity changed');
      return work(file, active);
    });
  }
  withDerivedPackage<T>(
    scope: ShortsScope,
    short: ShortRecord,
    kind: ShortsDerivedPackage,
    work: (
      files: (ShortsMediaFile & { name: string })[],
      signal: AbortSignal,
    ) => Promise<T>,
    signal?: AbortSignal,
  ) {
    if (!validateOriginalContent(short) || !short.privateMedia)
      throw new Error('Prepared derivatives unavailable');
    const entries = derivedFiles(short.files, kind);
    return this.withScratch(
      entries.reduce((sum, file) => sum + file.bytes, 0),
      signal,
      async (directory, active) => {
        const files: (ShortsMediaFile & { name: string })[] = [];
        for (const entry of entries) {
          const ref = short.privateMedia.files[entry.name];
          if (!ref || ref.bytes !== entry.bytes || ref.sha256 !== entry.sha256)
            throw new Error('Prepared media reference mismatch');
          const file = await this.objects.getToFile(
            scope,
            ref,
            join(directory, entry.name),
            active,
          );
          files.push({ ...file, name: entry.name });
        }
        return work(files, active);
      },
    );
  }
  async file(
    scope: ShortsScope,
    short: ShortRecord,
    name: string,
    signal?: AbortSignal,
  ) {
    const entry = short.files.find((file) => file.name === name),
      ref = short.privateMedia?.files[name];
    if (
      !entry ||
      !ref ||
      ref.bytes !== entry.bytes ||
      ref.sha256 !== entry.sha256
    )
      throw new Error('Prepared media reference mismatch');
    return this.objects.get(scope, ref, signal);
  }
  async original(scope: ShortsScope, short: ShortRecord, signal?: AbortSignal) {
    if (!short.privateMedia) throw new Error('Private source is missing');
    return this.sources.read(
      scope,
      {
        id: short.id,
        creator: short.creator,
        input: short.privateMedia.source,
      },
      signal,
    );
  }
}
