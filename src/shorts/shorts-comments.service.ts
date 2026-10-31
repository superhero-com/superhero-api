import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ShortsChainService } from './shorts-chain.service';
import { ShortsService } from './shorts.service';

const counter = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value))
    throw new BadRequestException(`Invalid ${name}`);
  return value;
};

/** Bounded public reads; comment mutations are always signed by the user's wallet. */
@Injectable()
export class ShortsCommentsService {
  constructor(
    private readonly chain: ShortsChainService,
    private readonly shorts: ShortsService,
  ) {}
  private enabled() {
    if (this.chain.release.schemaVersion !== 2)
      throw new NotFoundException(
        'Comments are not available on this contract',
      );
  }
  async author(address: string) {
    this.enabled();
    this.chain.address(address);
    const [author, policy, head] = await Promise.all([
      this.chain.read('get_author', [address]),
      this.chain.policy(),
      this.chain.readNode(() => this.chain.sdk.api.getCurrentKeyBlock()),
    ]);
    return {
      sequence: String(author.sequence),
      nextSequence: String(BigInt(author.sequence) + 1n),
      availableAt: String(
        BigInt(author.height) + BigInt(policy.commentCooldown),
      ),
      height: head.height,
      policy,
    };
  }
  async page(
    id: string,
    query: { cursor?: string; version?: string; limit?: string },
  ) {
    this.enabled();
    await this.shorts.ensurePlayable(id);
    const cursor = counter(query.cursor ?? '0', 'comment cursor');
    const limit = Number(counter(query.limit ?? '25', 'comment limit'));
    if (
      limit < 1 ||
      limit > 25 ||
      (cursor !== '0' && query.version === undefined)
    )
      throw new BadRequestException(
        'Comment pages require their original version',
      );
    const stats = await this.chain.read('get_video_stats', [id]);
    const version =
      query.version === undefined
        ? String(stats.comment_version)
        : counter(query.version, 'comment version');
    try {
      const page = await this.chain.read('get_comments_page', [
        id,
        cursor,
        limit,
        version,
      ]);
      return {
        version: String(page.version),
        total: String(page.end_cursor),
        next:
          page.next_cursor < page.end_cursor ? String(page.next_cursor) : null,
        items: page.items.map(([n, comment]) => ({
          id: String(n),
          author: comment.author,
          text: comment.text,
          height: String(comment.height),
          sequence: String(comment.sequence),
        })),
      };
    } catch (error) {
      if (error instanceof Error && /STALE_CURSOR/.test(error.message))
        throw new ConflictException('Comments changed. Reload the first page.');
      throw error;
    }
  }
  async stats(id: string) {
    this.enabled();
    await this.shorts.ensurePlayable(id);
    const value = await this.chain.read('get_video_stats', [id]);
    return {
      likes: String(value.likes),
      comments: String(value.comments),
      commentVersion: String(value.comment_version),
    };
  }
}
