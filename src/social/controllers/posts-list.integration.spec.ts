import 'dotenv/config';
import { encode, Encoding } from '@aeternity/aepp-sdk';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { SocialGraphService } from '@/plugins/social-graph/social-graph.service';
import { ProfileReadService } from '@/profile/services/profile-read.service';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Token } from '@/tokens/entities/token.entity';
import { Post } from '../entities/post.entity';
import { Topic } from '../entities/topic.entity';
import { PopularRankingService } from '../services/popular-ranking.service';
import { ReadsService } from '../services/reads.service';
import { PostsController } from './posts.controller';

const d = process.env.DB_HOST ? describe : describe.skip;

const alice = encode(Buffer.alloc(32, 1), Encoding.AccountAddress);
const bob = encode(Buffer.alloc(32, 2), Encoding.AccountAddress);

const ids = (response: request.Response) =>
  response.body.items.map((item: { id: string }) => item.id);

d('GET /posts list (integration)', () => {
  let db: IsolatedDb;
  let app: INestApplication;

  const list = (query = '') =>
    request(app.getHttpServer()).get(`/posts?${query}`).expect(200);

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [Post, Topic, Token],
      migrations: [],
    });
    await db.dataSource.synchronize();

    const [ae, aeternity, defi] = await db.dataSource
      .getRepository(Topic)
      .save([{ name: 'ae' }, { name: 'aeternity' }, { name: 'defi' }]);

    const post = (
      id: string,
      minute: number,
      topics: Topic[],
      extra: Partial<Post>,
    ) => ({
      id,
      tx_hash: `th_${id}`,
      tx_args: [],
      sender_address: alice,
      contract_address: 'ct_posts',
      type: 'post',
      content: id,
      total_comments: 0,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, minute)),
      topics,
      ...extra,
    });
    await db.dataSource.getRepository(Post).save([
      post('hidden', 50, [ae], { is_hidden: true }),
      post('newest', 40, [ae, aeternity, defi], {
        language: 'en',
        total_comments: 1,
      }),
      post('untagged', 30, [], {
        sender_address: bob,
        content: 'all about ae',
        language: 'zh',
        total_comments: 5,
      }),
      post('defi-only', 20, [defi], { language: 'en', total_comments: 3 }),
      post('oldest', 10, [ae, defi], { sender_address: bob }),
    ]);

    const module = await Test.createTestingModule({
      controllers: [PostsController],
      providers: [
        {
          provide: getRepositoryToken(Post),
          useValue: db.dataSource.getRepository(Post),
        },
        { provide: getRepositoryToken(Token), useValue: {} },
        { provide: PopularRankingService, useValue: {} },
        { provide: ReadsService, useValue: {} },
        { provide: CommunityFactoryService, useValue: {} },
        {
          provide: ProfileReadService,
          useValue: { getProfilesByAddresses: async () => [] },
        },
        { provide: SocialGraphService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (db) await db.drop();
  }, 60_000);

  const all = ['newest', 'untagged', 'defi-only', 'oldest'];

  it('lists each visible post once, however many topics it has', async () => {
    const response = await list();

    expect(ids(response)).toEqual(all);
    expect(response.body.meta).toEqual({
      itemCount: 4,
      totalItems: 4,
      totalPages: 1,
      currentPage: 1,
    });
  });

  it('treats blank topics as no filter', async () => {
    const response = await list('topics=,%20,');

    expect(ids(response)).toEqual(all);
    expect(response.body.meta.totalItems).toBe(4);
  });

  it('pages without overlap', async () => {
    const first = await list('limit=3');
    const second = await list('limit=3&page=2');

    expect(ids(first)).toEqual(['newest', 'untagged', 'defi-only']);
    expect(ids(second)).toEqual(['oldest']);
    expect(first.body.meta).toMatchObject({ totalItems: 4, totalPages: 2 });
  });

  it.each([
    ['order_direction=ASC', ['oldest', 'defi-only', 'untagged', 'newest']],
    [
      'order_by=total_comments&order_direction=DESC',
      ['untagged', 'defi-only', 'newest', 'oldest'],
    ],
    [
      'order_by=total_comments&order_direction=ASC',
      ['oldest', 'newest', 'defi-only', 'untagged'],
    ],
  ])('orders by %s', async (query, expected) => {
    expect(ids(await list(query))).toEqual(expected);
  });

  it.each([
    ['language=en', ['newest', 'defi-only']],
    [`account_address=${bob}`, ['untagged', 'oldest']],
    [`account_address=${alice}&language=en`, ['newest', 'defi-only']],
  ])('filters by %s', async (query, expected) => {
    const response = await list(query);

    expect(ids(response)).toEqual(expected);
    expect(response.body.meta.totalItems).toBe(expected.length);
  });

  it.each([
    // Partial match: both "ae" and "aeternity" hit the first post.
    ['topics=ae', ['newest', 'oldest']],
    ['topics=defi,aeternity', ['newest', 'defi-only', 'oldest']],
    // Content or topic name: "untagged" only matches on its content.
    ['search=ae', ['newest', 'untagged', 'oldest']],
    ['search=ae&language=en', ['newest']],
    ['topics=defi&order_direction=ASC', ['oldest', 'defi-only', 'newest']],
  ])('matches topics with %s, one row per post', async (query, expected) => {
    const response = await list(query);

    expect(ids(response)).toEqual(expected);
    expect(response.body.meta.totalItems).toBe(expected.length);
  });
});
