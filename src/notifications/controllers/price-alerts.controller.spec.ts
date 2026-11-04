import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MemoryAccount } from '@aeternity/aepp-sdk';
import request from 'supertest';
import { DeviceChallenge } from '../entities/device-challenge.entity';
import notificationsConfig from '../notifications.config';
import {
  buildPriceAlertMessage,
  PriceAlertIntent,
} from '../price-alerts/price-alert.message';
import { PriceAlertService } from '../price-alerts/price-alert.service';
import { DeviceChallengeService } from '../services/device-challenge.service';
import { FeedSessionService } from '../services/feed-session.service';
import { PriceAlertsController } from './price-alerts.controller';

const SALE = 'ct_wS3iFu3UkvprrkreRdjJJ8RrK9tLou5LeBBSbiPbmf6g51gvt';

describe('PriceAlertsController (HTTP)', () => {
  const alice = MemoryAccount.generate();
  const bob = MemoryAccount.generate();
  const path = `/notifications/${alice.address}/price-alerts`;
  const createIntent: PriceAlertIntent = {
    action: 'create',
    saleAddress: SALE,
    direction: 'above',
    targetAe: '0.01',
  };
  const createBody = {
    nonce: 'n1',
    signature: 'ab',
    sale_address: SALE,
    direction: 'above',
    target_ae: '0.01',
  };

  let app: INestApplication;
  let challengeRepo: { findOne: jest.Mock; update: jest.Mock };
  let sessions: { resolve: jest.Mock };
  let priceAlerts: { listFor: jest.Mock; create: jest.Mock; remove: jest.Mock };

  /** Signs the price-alert message for Alice's address with `signer`'s key. */
  async function sign(signer: MemoryAccount, intent: PriceAlertIntent) {
    const message = buildPriceAlertMessage(alice.address, 'n1', intent);
    return Buffer.from(await signer.signMessage(message)).toString('hex');
  }

  // A fresh app per test: RateLimitGuard allows 10 requests a minute per route.
  beforeEach(async () => {
    challengeRepo = {
      findOne: jest.fn().mockResolvedValue({
        nonce: 'n1',
        address: alice.address,
        consumed_at: null,
        expires_at: new Date(Date.now() + 60_000),
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    sessions = { resolve: jest.fn().mockResolvedValue(null) };
    priceAlerts = {
      listFor: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 1 }),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({
      controllers: [PriceAlertsController],
      providers: [
        DeviceChallengeService,
        {
          provide: getRepositoryToken(DeviceChallenge),
          useValue: challengeRepo,
        },
        {
          provide: notificationsConfig.KEY,
          useValue: {
            challengeTtlMs: 300_000,
            challengeMaxPendingPerAddress: 5,
          },
        },
        { provide: FeedSessionService, useValue: sessions },
        { provide: PriceAlertService, useValue: priceAlerts },
      ],
    }).compile();
    app = module.createNestApplication();
    // Same pipe as main.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(() => app.close());

  describe('GET', () => {
    it('needs a feed session', async () => {
      await request(app.getHttpServer()).get(path).expect(401);
      expect(priceAlerts.listFor).not.toHaveBeenCalled();
    });

    it("rejects another account's session", async () => {
      sessions.resolve.mockResolvedValue(bob.address);
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', 'Bearer tok')
        .expect(401);
      expect(priceAlerts.listFor).not.toHaveBeenCalled();
    });

    it("lists the session owner's alerts", async () => {
      sessions.resolve.mockResolvedValue(alice.address);
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', 'Bearer tok')
        .expect(200, []);
      expect(sessions.resolve).toHaveBeenCalledWith('tok');
      expect(priceAlerts.listFor).toHaveBeenCalledWith(alice.address);
    });
  });

  describe('POST', () => {
    it.each([
      ['an unknown direction', { direction: 'sideways' }],
      ['a numeric target', { target_ae: 0.01 }],
      ['an exponent target', { target_ae: '1e5' }],
      ['a malformed token', { sale_address: 'ct_x' }],
      ['an unknown field', { address: bob.address }],
    ])('rejects %s before touching the challenge', async (_, override) => {
      await request(app.getHttpServer())
        .post(path)
        .send({ ...createBody, ...override })
        .expect(400);
      expect(challengeRepo.findOne).not.toHaveBeenCalled();
      expect(priceAlerts.create).not.toHaveBeenCalled();
    });

    it('rejects a malformed account address', async () => {
      await request(app.getHttpServer())
        .post('/notifications/ak_bad/price-alerts')
        .send(createBody)
        .expect(400);
      expect(challengeRepo.findOne).not.toHaveBeenCalled();
    });

    it('creates exactly the signed alert and consumes the nonce', async () => {
      const signature = await sign(alice, createIntent);
      await request(app.getHttpServer())
        .post(path)
        .send({ ...createBody, signature })
        .expect(201, { id: 1 });
      expect(priceAlerts.create).toHaveBeenCalledWith(
        alice.address,
        SALE,
        'above',
        '0.01',
      );
      expect(challengeRepo.update).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['for another target', alice, { target_ae: '0.02' }],
      ['for another direction', alice, { direction: 'below' }],
      ['by another account', bob, {}],
    ])('rejects a signature made %s', async (_, signer, override) => {
      const signature = await sign(signer, createIntent);
      await request(app.getHttpServer())
        .post(path)
        .send({ ...createBody, ...override, signature })
        .expect(401);
      expect(priceAlerts.create).not.toHaveBeenCalled();
      expect(challengeRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    it('deletes only the signed alert id', async () => {
      const signature = await sign(alice, { action: 'delete', alertId: 4 });
      await request(app.getHttpServer())
        .delete(`${path}/5`)
        .send({ nonce: 'n1', signature })
        .expect(401);
      expect(priceAlerts.remove).not.toHaveBeenCalled();

      await request(app.getHttpServer())
        .delete(`${path}/4`)
        .send({ nonce: 'n1', signature })
        .expect(204);
      expect(priceAlerts.remove).toHaveBeenCalledWith(alice.address, 4);
    });

    it('rejects a non-numeric alert id', async () => {
      await request(app.getHttpServer())
        .delete(`${path}/abc`)
        .send({ nonce: 'n1', signature: 'ab' })
        .expect(400);
      expect(challengeRepo.findOne).not.toHaveBeenCalled();
    });
  });
});
