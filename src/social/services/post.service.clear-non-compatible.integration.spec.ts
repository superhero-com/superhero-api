import 'dotenv/config';
import { Repository } from 'typeorm';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { PostPersistenceService } from '@/plugins/social/services/post-persistence.service';
import { TopicManagementService } from '@/plugins/social/services/topic-management.service';
import { Token } from '@/tokens/entities/token.entity';
import { POST_SYNC_VERSION } from '../config/post-contracts.config';
import { Post } from '../entities/post.entity';
import { Topic } from '../entities/topic.entity';
import { PostService } from './post.service';

/**
 * Runs PostService's boot cleanup against real Postgres, with rows written by
 * the social plugin's own writers. The cleanup is raw, unqualified SQL, so it
 * needs a throwaway database: in a throwaway schema it would hit the shared
 * database's public tables. Skipped automatically when no DB host is set.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

d('PostService.clearNonCompatibleData (integration)', () => {
  let db: IsolatedDb;
  let posts: Repository<Post>;
  let topics: Repository<Topic>;

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [Post, Topic, Token],
      migrations: [],
    });
    await db.dataSource.synchronize();
    posts = db.dataSource.getRepository(Post);
    topics = db.dataSource.getRepository(Topic);
  }, 60_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  it('keeps plugin-written rows, relabels version 6 ones and deletes other versions', async () => {
    const persistence = new PostPersistenceService(posts, topics, {
      emit: jest.fn(),
    } as any);
    const [current, six, seven] = await new TopicManagementService(
      topics,
      posts,
    ).createOrGetTopics(['current', 'six', 'seven']);

    const postData = (returnValue: number, postTopics: Topic[]) =>
      persistence.createPostData(
        {
          hash: `th_${returnValue}`,
          micro_time: '1700000000000',
          caller_id: 'ak_author',
          contract_id: 'ct_post',
          function: 'post_without_tip',
          raw: { return: { value: returnValue }, arguments: [] },
        } as any,
        { contractAddress: 'ct_post', version: 3 },
        { content: 'hello', topics: [], media: [], trendMentions: [] },
        postTopics,
        {
          isComment: false,
          isBclSale: false,
          isBclTx: false,
          isBclGain: false,
        },
      );
    await posts.save(posts.create(postData(1, [current])));
    await posts.save(
      posts.create({ ...postData(2, [six, seven]), version: 6 }),
    );
    await posts.save(posts.create({ ...postData(3, [seven]), version: 7 }));
    await topics.update(six.id, { version: 6 });
    await topics.update(seven.id, { version: 7 });

    await (
      new PostService(posts, topics, {} as any) as any
    ).clearNonCompatibleData();

    const survivors = await posts.find({
      relations: { topics: true },
      order: { id: 'ASC' },
    });
    expect(
      survivors.map((post) => [
        post.id,
        post.version,
        post.topics.map((topic) => topic.name),
      ]),
    ).toEqual([
      ['1_v3', POST_SYNC_VERSION, ['current']],
      ['2_v3', POST_SYNC_VERSION, ['six']],
    ]);
    const remainingTopics = await topics.find({ order: { name: 'ASC' } });
    expect(remainingTopics.map((topic) => [topic.name, topic.version])).toEqual(
      [
        ['current', POST_SYNC_VERSION],
        ['six', POST_SYNC_VERSION],
      ],
    );
  });
});
