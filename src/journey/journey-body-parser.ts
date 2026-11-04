import express, {
  ErrorRequestHandler,
  RequestHandler,
  Request,
  Response,
  NextFunction,
} from 'express';
import { JOURNEY_LIMITS } from './journey.constants';

/** Path of the public ingest route, global prefix included. */
export const JOURNEY_INGEST_PATH = '/api/analytics/journey/events';

/**
 * Route-scoped body handling for the ingest endpoint.
 *
 * Beacons arrive as `text/plain` (no CORS preflight), some fetches as
 * `application/json`. Both are read as raw text here and parsed by the
 * handler, so that the app-wide JSON parser never sees this route: it would
 * answer a malformed or oversized body with a 400/413, and this endpoint must
 * only ever answer 204.
 *
 * MUST be mounted with `app.use()` BEFORE `app.init()`/`listen()`. Nest adds
 * its own body parsers during init, and those skip a request whose body was
 * already read; module-level middleware would run after them, too late.
 */
export function journeyIngestBodyHandlers(): (
  RequestHandler | ErrorRequestHandler
)[] {
  const readText = express.text({
    type: () => true,
    limit: JOURNEY_LIMITS.MAX_BODY,
  });
  const swallow: ErrorRequestHandler = (
    _error: unknown,
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    if (request.method !== 'POST') {
      return next(_error);
    }
    // Too large, bad encoding, aborted upload: the client is told nothing.
    response.status(204).end();
  };
  const onlyPost: RequestHandler = (request, response, next) => {
    if (request.method !== 'POST') {
      return next();
    }
    return readText(request, response, next);
  };
  return [onlyPost, swallow];
}
