import type { Request } from 'express';

export const SHORTS_UPLOAD_SIGNAL = Symbol('SHORTS_UPLOAD_SIGNAL');
export type ShortsUploadRequest = Request & {
  [SHORTS_UPLOAD_SIGNAL]?: AbortSignal;
};
