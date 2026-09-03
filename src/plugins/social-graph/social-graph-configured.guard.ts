import {
  CanActivate,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SOCIAL_GRAPH_ENABLED } from './social-graph.constants';

/**
 * Class-level guard for the social-graph controller: when the contract is
 * unconfigured every route answers 503 uniformly, so a disabled feature never
 * returns a plausible-but-wrong answer (four `false`s reads exactly like "no
 * relationship"). The message matches what the contract service throws, so the
 * disabled body is identical whichever layer produces it.
 */
@Injectable()
export class SocialGraphConfiguredGuard implements CanActivate {
  canActivate(): boolean {
    if (!SOCIAL_GRAPH_ENABLED) {
      throw new ServiceUnavailableException(
        'SocialGraph contract is not configured',
      );
    }
    return true;
  }
}
