import { Injectable } from '@nestjs/common';
import { ShortsPrivateObjectsService } from './shorts-private-objects.service';
import { ShortsSourceService } from './shorts-source.service';
import { ShortsScope } from './shorts-metadata.service';
import { ShortRecord } from './shorts.types';

@Injectable()
export class ShortsPrivateMediaService {
  constructor(
    private readonly objects: ShortsPrivateObjectsService,
    private readonly sources: ShortsSourceService,
  ) {}
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
