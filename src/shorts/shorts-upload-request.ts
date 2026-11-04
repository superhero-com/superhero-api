import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { UploadInput } from './shorts-uploads.service';

export interface UploadRequestIdentity {
  key: string;
  hash: string;
}

export function validateUploadRequest(request: UploadRequestIdentity) {
  if (
    !request ||
    typeof request.key !== 'string' ||
    typeof request.hash !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      request.key,
    ) ||
    !/^[a-f0-9]{64}$/.test(request.hash)
  )
    throw new BadRequestException('Invalid upload request key');
}

/** Hash only the public creation contract, in a stable field order. */
export function shortsUploadRequest(
  input: UploadInput,
): UploadRequestIdentity | undefined {
  if (input?.requestKey === undefined) return undefined;
  if (
    input.expectedFormat !== undefined &&
    !['original-file-v1', 'legacy-directory-v1'].includes(input.expectedFormat)
  ) {
    throw new BadRequestException('Invalid upload format');
  }
  const request = {
    key: input.requestKey,
    hash: createHash('sha256')
      .update(
        JSON.stringify({
          title: input.title,
          topic: input.topic,
          rights: input.rights,
          bytes: input.bytes,
          sha256: input.sha256,
          expectedFormat: input.expectedFormat,
          details: {
            description: input.details?.description,
            language: input.details?.language,
            synthetic: input.details?.synthetic,
            sponsored: input.details?.sponsored,
            captions: input.details?.captions,
          },
        }),
      )
      .digest('hex'),
  };
  validateUploadRequest(request);
  return request;
}
