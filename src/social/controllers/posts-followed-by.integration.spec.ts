import 'dotenv/config';
import { encode, Encoding } from '@aeternity/aepp-sdk';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { CommunityFactoryService } from '@/ae/community-factory.service';
import { SocialGraphProjection1718900000035 } from '@/migrations/1718900000035-SocialGraphProjection';
import { SocialGraphProjectionService } from '@/plugins/social-graph/social-graph-projection.service';
import { SocialGraphQueryService } from '@/plugins/social-graph/social-graph-query.service';
import { SocialGraphReader } from '@/plugins/social-graph/social-graph-reader';
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

const account = (seed: number) =>
  encode(Buffer.alloc(32, seed), Encoding.AccountAddress);
const viewer = account(1);
const followed = account(2);
const alsoFollowed = account(3);
const unfollowed = account(4);
const blocked = account(5);
const followedBeforeRebuild = account(6);
const stranger = account(7);
const followsNobody = account(8);

const identity = { network: 'ae_dev', contract: 'ct_abc' };
const previous = { ...identity, generation: '1' };
const current = { ...identity, generation: '2' };

const event = (transaction: string) => ({
  transaction,
  index: 0,
  height: '100',
});
const follow = (to: string) => ({
  from: viewer,
  to,
  kind: 'follow' as const,
  present: true,
});
const post = (
  id: string,
  sender_address: string,
  minute: number,
  extra: Partial<Post> = {},
) => ({
  id,
  tx_hash: `th_${id}`,
  tx_args: [],
  sender_address,
  contract_address: 'ct_posts',
  type: 'post',
  content: id,
  total_comments: 0,
  created_at: new Date(Date.UTC(2026, 0, 1, 0, minute)),
  ...extra,
});
const ids = (response: request.Response) =>
  response.body.items.map((item: { id: string }) => item.id);

d('GET /posts?followed_by (integration)', () => {
  const savedEnv = {
    contract: process.env.SOCIAL_GRAPH_CONTRACT_ADDRESS,
    network: process.env.SOCIAL_GRAPH_NETWORK_ID,
  };
  let db: IsolatedDb;
  let ds: DataSource;
  let app: INestApplication;
  let projection: SocialGraphProjectionService;

  const list = (query: string) =>
    request(app.getHttpServer()).get(`/posts?${query}`);

  beforeAll(async () => {
    process.env.SOCIAL_GRAPH_CONTRACT_ADDRESS = identity.contract;
    process.env.SOCIAL_GRAPH_NETWORK_ID = identity.network;
    jest
      .spyOn(SocialGraphReader.prototype, 'verifyIdentity')
      .mockResolvedValue();

    db = await createIsolatedDatabase({
      entities: [Post, Topic, Token],
      migrations: [SocialGraphProjection1718900000035],
    });
    ds = db.dataSource;
    await ds.synchronize();
    await ds.runMigrations();

    await ds.query(
      "INSERT INTO social_graph_projection_scopes(network,contract,generation,state) VALUES('ae_dev','ct_abc',1,'ready'),('ae_dev','ct_abc',2,'ready')",
    );
    projection = new SocialGraphProjectionService(ds);
    // A rebuild starts a new generation and leaves the old edges in the table.
    await projection.applyEvent(previous, event('th_previous'), [
      follow(followedBeforeRebuild),
    ]);
    await projection.invalidateAfterReorg(previous);
    await projection.applyEvent(current, event('th_follow'), [
      follow(followed),
      follow(alsoFollowed),
      follow(unfollowed),
      { ...follow(blocked), kind: 'block' },
      { ...follow(viewer), from: stranger },
    ]);
    await projection.applyEvent(current, event('th_unfollow'), [
      { ...follow(unfollowed), present: false },
    ]);

    await ds
      .getRepository(Post)
      .insert([
        post('hidden', followed, 40, { is_hidden: true }),
        post('followed-new', followed, 30, { language: 'en' }),
        post('own', viewer, 29),
        post('stranger', stranger, 28),
        post('before-rebuild', followedBeforeRebuild, 27),
        post('blocked', blocked, 26),
        post('unfollowed', unfollowed, 25),
        post('also-followed', alsoFollowed, 20),
        post('followed-old', followed, 10),
      ]);

    const module = await Test.createTestingModule({
      controllers: [PostsController],
      providers: [
        { provide: getRepositoryToken(Post), useValue: ds.getRepository(Post) },
        { provide: getRepositoryToken(Token), useValue: {} },
        { provide: PopularRankingService, useValue: {} },
        { provide: ReadsService, useValue: {} },
        { provide: CommunityFactoryService, useValue: {} },
        {
          provide: ProfileReadService,
          useValue: { getProfilesByAddresses: async () => [] },
        },
        {
          provide: SocialGraphService,
          useValue: new SocialGraphService(
            { sdk: { getContext: () => ({ onNode: {} }) } } as any,
            new SocialGraphQueryService(ds),
          ),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  }, 60_000);

  afterEach(async () => {
    await ds.query(
      "UPDATE social_graph_projection_scopes SET state='ready' WHERE generation=2",
    );
  });

  afterAll(async () => {
    await app?.close();
    if (db) await db.drop();
    jest.restoreAllMocks();
    for (const [key, value] of [
      ['SOCIAL_GRAPH_CONTRACT_ADDRESS', savedEnv.contract],
      ['SOCIAL_GRAPH_NETWORK_ID', savedEnv.network],
    ]) {
      if (value == null) delete process.env[key!];
      else process.env[key!] = value;
    }
  }, 60_000);

  it('pages through the visible posts of current follows only', async () => {
    const first = await list(`followed_by=${viewer}&limit=2`).expect(200);
    const second = await list(`followed_by=${viewer}&limit=2&page=2`).expect(
      200,
    );

    expect(ids(first)).toEqual(['followed-new', 'also-followed']);
    expect(ids(second)).toEqual(['followed-old']);
    expect(first.body.meta).toEqual({
      itemCount: 2,
      totalItems: 3,
      totalPages: 2,
      currentPage: 1,
    });
    expect(second.body.meta).toEqual({
      itemCount: 1,
      totalItems: 3,
      totalPages: 2,
      currentPage: 2,
    });
  });

  it('combines with the other list filters', async () => {
    const english = await list(`followed_by=${viewer}&language=en`).expect(200);
    expect(ids(english)).toEqual(['followed-new']);
    expect(english.body.meta.totalItems).toBe(1);

    const notFollowed = await list(
      `followed_by=${viewer}&account_address=${stranger}`,
    ).expect(200);
    expect(ids(notFollowed)).toEqual([]);
  });

  it('returns an empty page for an account that follows nobody', async () => {
    const response = await list(`followed_by=${followsNobody}`).expect(200);

    expect(ids(response)).toEqual([]);
    expect(response.body.meta).toMatchObject({ totalItems: 0, totalPages: 0 });
  });

  it('fails closed while the graph rebuilds and leaves the plain list up', async () => {
    await projection.invalidateAfterReorg(current);

    await list(`followed_by=${viewer}`).expect(503);
    const plain = await list('limit=1').expect(200);
    expect(ids(plain)).toEqual(['followed-new']);
  });

  it.each([
    ['a malformed address', 'followed_by=not_an_address'],
    ['repeated values', `followed_by=${viewer}&followed_by=${followed}`],
  ])('rejects %s', async (_name, query) => {
    await list(query).expect(400);
  });
});
