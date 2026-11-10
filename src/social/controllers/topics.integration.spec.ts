import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { createIsolatedDatabase, IsolatedDb } from '@/test/harness/db';
import { Token } from '@/tokens/entities/token.entity';
import { Post } from '../entities/post.entity';
import { Topic } from '../entities/topic.entity';
import { TopicsController } from './topics.controller';

const d = process.env.DB_HOST ? describe : describe.skip;

d('GET /topics/:id and /topics/name/:name (integration)', () => {
  let db: IsolatedDb;
  let app: INestApplication;
  let topic: Topic;

  beforeAll(async () => {
    db = await createIsolatedDatabase({
      entities: [Post, Topic, Token],
      migrations: [],
    });
    await db.dataSource.synchronize();

    topic = await db.dataSource
      .getRepository(Topic)
      .save({ name: 'aeternity', post_count: 1 });
    await db.dataSource.getRepository(Post).save({
      id: 'tagged',
      tx_hash: 'th_tagged',
      tx_args: [],
      sender_address: 'ak_author',
      contract_address: 'ct_posts',
      type: 'post',
      content: '#aeternity',
      total_comments: 0,
      topics: [topic],
    });

    const module = await Test.createTestingModule({
      controllers: [TopicsController],
      providers: [
        {
          provide: getRepositoryToken(Topic),
          useValue: db.dataSource.getRepository(Topic),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (db) await db.drop();
  }, 60_000);

  // Posts come from the paged /posts?topic= instead; the full list was 4 MB
  // for #aeternity.
  it.each([
    ['name', () => '/topics/name/aeternity'],
    ['id', () => `/topics/${topic.id}`],
  ])('returns a topic by %s without its posts', async (_, path) => {
    const { body } = await request(app.getHttpServer()).get(path()).expect(200);

    expect(body).toMatchObject({
      id: topic.id,
      name: 'aeternity',
      post_count: 1,
    });
    expect(body).not.toHaveProperty('posts');
  });
});
