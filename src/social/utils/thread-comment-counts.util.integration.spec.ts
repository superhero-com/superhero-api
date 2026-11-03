import 'dotenv/config';
import { Repository } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Token } from '@/tokens/entities/token.entity';
import { Post } from '../entities/post.entity';
import { Topic } from '../entities/topic.entity';
import {
  recountAllThreadComments,
  REFRESH_MAX_HEIGHT,
  refreshThreadCommentCounts,
} from './thread-comment-counts.util';

/**
 * Runs the recount SQL against real Postgres; the recursive CTEs are the part
 * a mock can't check. Skipped automatically when no DB host is set.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

d('thread comment counts (integration)', () => {
  let db: IsolatedDb;
  let posts: Repository<Post>;

  const insertPost = (
    id: string,
    postId: string | null = null,
    extra: Partial<Post> = {},
  ) =>
    posts.insert({
      id,
      post_id: postId,
      tx_hash: `th_${id}`,
      tx_args: [],
      sender_address: 'ak_author',
      contract_address: 'ct_post',
      type: 'post_without_tip',
      content: id,
      total_comments: 0,
      ...extra,
    });

  const reply = async (id: string, parentId: string, extra?: Partial<Post>) => {
    await insertPost(id, parentId, extra);
    await refreshThreadCommentCounts(posts.manager, parentId);
  };

  const totals = async () =>
    Object.fromEntries(
      (await posts.find({ order: { id: 'ASC' } })).map((post) => [
        post.id,
        post.total_comments,
      ]),
    );

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [Post, Topic, Token],
      migrations: [],
    });
    await db.dataSource.synchronize();
    posts = db.dataSource.getRepository(Post);
  }, 60_000);

  afterEach(async () => {
    await posts.query('DELETE FROM posts');
  });

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  it('counts replies at every depth for the parent and every post above it', async () => {
    await insertPost('root');
    await reply('a', 'root');
    await reply('b', 'a');
    await reply('c', 'b');
    await reply('d', 'root');
    await reply('e', 'a', { is_hidden: true });

    expect(await totals()).toEqual({
      a: 3,
      b: 1,
      c: 0,
      d: 0,
      e: 0,
      root: 5,
    });
  });

  it('leaves posts outside the thread alone', async () => {
    await insertPost('root');
    await insertPost('other', null, { total_comments: 7 });

    await reply('a', 'root');

    expect(await totals()).toEqual({ a: 0, other: 7, root: 1 });
  });

  it('rewrites stored direct-reply counts as whole-thread totals', async () => {
    await insertPost('root', null, { total_comments: 2 });
    await insertPost('a', 'root', { total_comments: 1 });
    await insertPost('b', 'a', { total_comments: 1 });
    await insertPost('c', 'b');
    await insertPost('d', 'root');

    expect(await recountAllThreadComments(posts.manager)).toBe(2);
    expect(await totals()).toEqual({ a: 2, b: 1, c: 0, d: 0, root: 4 });
  });

  it('leaves the totals unchanged when they already add up', async () => {
    await insertPost('root');
    await reply('a', 'root');
    await reply('b', 'a');

    expect(await recountAllThreadComments(posts.manager)).toBe(0);
    expect(await totals()).toEqual({ a: 1, b: 0, root: 2 });
  });

  it('ends exact when a post is refreshed before the reply below it', async () => {
    await insertPost('root');
    await reply('a', 'root');
    await insertPost('deep', 'a');
    await insertPost('top', 'root');

    await refreshThreadCommentCounts(posts.manager, 'root');
    await refreshThreadCommentCounts(posts.manager, 'a');

    expect(await totals()).toEqual({ a: 1, deep: 0, root: 3, top: 0 });
  });

  it('catches up a chain deeper than the refresh walk at the recount', async () => {
    // k0 is the root and each k<n> replies to k<n-1>.
    const last = REFRESH_MAX_HEIGHT + 100;
    await posts.query(
      `INSERT INTO posts (id, post_id, tx_hash, tx_args, sender_address,
         contract_address, type, content, total_comments)
       SELECT 'k' || n, CASE WHEN n > 0 THEN 'k' || (n - 1) END, 'th_k' || n,
         '[]', 'ak_author', 'ct_post', 'post_without_tip', 'k' || n, 0
       FROM generate_series(0, $1::int) n`,
      [last],
    );
    await recountAllThreadComments(posts.manager);

    // The walk reaches k100; k99 and above keep their old totals until the recount.
    await reply('tip', `k${last}`);
    const walked = await totals();
    expect([walked.k100, walked.k99, walked.k0]).toEqual([
      last - 99,
      last - 99,
      last,
    ]);

    expect(await recountAllThreadComments(posts.manager)).toBe(100);
    const after = await totals();
    expect([after.k99, after.k0]).toEqual([last - 98, last + 1]);
  });

  it('stops at a reply cycle without inflating its totals', async () => {
    await insertPost('x');
    await reply('p', 'x');
    await reply('q', 'p');
    await posts.update('x', { post_id: 'p' });

    await refreshThreadCommentCounts(posts.manager, 'p');
    await refreshThreadCommentCounts(posts.manager, 'p');
    expect(await totals()).toEqual({ p: 2, q: 0, x: 2 });

    // A cycle has no exact total: refreshing from x leaves x at its direct
    // replies, and the recount leaves the cycle as it is.
    await refreshThreadCommentCounts(posts.manager, 'x');
    await recountAllThreadComments(posts.manager);
    expect(await totals()).toEqual({ p: 2, q: 0, x: 1 });
  });

  it('ends with exact totals when replies land in parallel', async () => {
    await insertPost('root');
    await reply('a', 'root');
    await reply('b', 'root');

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        reply(`r${String(index).padStart(2, '0')}`, index % 2 ? 'a' : 'b'),
      ),
    );

    const after = await totals();
    expect([after.root, after.a, after.b]).toEqual([22, 10, 10]);
  });
});
