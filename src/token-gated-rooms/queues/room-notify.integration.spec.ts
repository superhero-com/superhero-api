import 'dotenv/config';
import { DataSource, Repository } from 'typeorm';
import { DATABASE_CONFIG } from '@/configs/database';
import { Token } from '@/tokens/entities/token.entity';
import { NotificationPreference } from '@/notifications/entities/notification-preference.entity';
import { NotificationPreferencesService } from '@/notifications/services/notification-preferences.service';
import { CommunityRoom } from '../entities/community-room.entity';
import { RoomMembership } from '../entities/room-membership.entity';
import { RoomMembershipEvent } from '../entities/room-membership-event.entity';
import { RoomNotificationPreference } from '../entities/room-notification-preference.entity';
import { RoomMessageSeen } from '../entities/room-message-seen.entity';
import { TokenBalance } from '../entities/token-balance.entity';
import { RoomBackfillState } from '../entities/room-backfill-state.entity';
import { RoomPreferencesService } from '../services/room-preferences.service';
import { RoomMembershipNotification } from '../notifications/room-membership.notification';
import { RoomNotifyProcessor } from './room-notify.processor';
import type { RoomNotifyJob } from './room-notify.types';
import type { Job } from 'bull';

/**
 * DB integration for the membership-notification dispatch path (Task 12). Mirrors
 * the Task 10 harness: a real Postgres backs `token` + `room_notification_preference`
 * + `notification_preferences` in a DEDICATED `tgr12_test` schema
 * (`synchronize: true`). The processor's dispatch sink (`NotificationService.send`)
 * + device lookup (`DeviceService.getActiveTokens`) are mocked so the test asserts
 * the SKIP/dispatch decision over the REAL mute SQL.
 *
 * Requires the local Postgres (`DB_HOST`); auto-skips otherwise.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const SCHEMA = 'tgr12_test';
const SALE = 'ct_tgr12_sale';
const TOKEN_ADDR = 'ct_tgr12_token';
const MEMBER = 'ak_tgr12_member';

d('RoomNotifyProcessor (integration)', () => {
  let ds: DataSource;
  let tokenRepo: Repository<Token>;
  let roomPrefRepo: Repository<RoomNotificationPreference>;
  let notifPrefRepo: Repository<NotificationPreference>;
  let roomPreferences: RoomPreferencesService;
  let processor: RoomNotifyProcessor;
  let send: jest.Mock;
  let getActiveTokens: jest.Mock;

  const job = (over: Partial<RoomNotifyJob> = {}): Job<RoomNotifyJob> =>
    ({
      data: {
        saleAddress: SALE,
        memberAddress: MEMBER,
        change: 'added',
        ...over,
      },
    }) as Job<RoomNotifyJob>;

  beforeAll(async () => {
    const boot = new DataSource({
      ...(DATABASE_CONFIG as any),
      synchronize: false,
      entities: [],
    });
    await boot.initialize();
    await boot.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await boot.query(`CREATE SCHEMA "${SCHEMA}"`);
    await boot.destroy();

    ds = new DataSource({
      ...(DATABASE_CONFIG as any),
      schema: SCHEMA,
      synchronize: true,
      entities: [
        Token,
        CommunityRoom,
        RoomMembership,
        RoomMembershipEvent,
        RoomNotificationPreference,
        RoomMessageSeen,
        TokenBalance,
        RoomBackfillState,
        NotificationPreference,
      ],
    });
    await ds.initialize();

    tokenRepo = ds.getRepository(Token);
    roomPrefRepo = ds.getRepository(RoomNotificationPreference);
    notifPrefRepo = ds.getRepository(NotificationPreference);
  }, 60_000);

  beforeEach(async () => {
    await roomPrefRepo.clear();
    await notifPrefRepo.clear();
    await tokenRepo.clear();

    await tokenRepo.save(
      tokenRepo.create({
        sale_address: SALE,
        address: TOKEN_ADDR,
        name: 'TGR12',
        symbol: 'TGR',
        owner_address: 'ak_owner',
      } as Partial<Token>),
    );

    const notifPrefs = new NotificationPreferencesService(notifPrefRepo);
    roomPreferences = new RoomPreferencesService(roomPrefRepo, notifPrefs);

    send = jest.fn().mockResolvedValue({ outcome: 'sent' });
    getActiveTokens = jest.fn().mockResolvedValue(['ExponentPushToken[x]']);
    processor = new RoomNotifyProcessor(
      tokenRepo,
      ds.getRepository(RoomMembershipEvent),
      { getActiveTokens } as any,
      roomPreferences,
      { send } as any,
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
    const cleanup = new DataSource({
      ...(DATABASE_CONFIG as any),
      synchronize: false,
      entities: [],
    });
    await cleanup.initialize();
    await cleanup.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await cleanup.destroy();
  }, 60_000);

  it('dispatches when not muted and a device exists', async () => {
    await processor.process(job());
    expect(send).toHaveBeenCalledTimes(1);
    const [notifiable, notification] = send.mock.calls[0];
    expect(notifiable).toEqual({ address: MEMBER });
    expect(notification).toBeInstanceOf(RoomMembershipNotification);
    expect(notification.toExpo().data).toMatchObject({
      type: 'room-membership',
      saleAddress: SALE,
      change: 'added',
    });
  });

  it('does NOT dispatch when per-room muted (room_notification_preference.muted=true)', async () => {
    await roomPrefRepo.save(
      roomPrefRepo.create({ address: MEMBER, sale_address: SALE, muted: true }),
    );
    await processor.process(job());
    expect(send).not.toHaveBeenCalled();
  });

  it('does NOT dispatch when type-level muted-all (notification_preferences enabled=false)', async () => {
    await notifPrefRepo.save(
      notifPrefRepo.create({
        address: MEMBER,
        type: RoomMembershipNotification.META.type,
        enabled: false,
      }),
    );
    await processor.process(job());
    expect(send).not.toHaveBeenCalled();
  });

  it('does NOT dispatch when the member has no registered device', async () => {
    getActiveTokens.mockResolvedValue([]);
    await processor.process(job());
    expect(send).not.toHaveBeenCalled();
  });

  it('a per-room mute in one room does not suppress another room', async () => {
    await roomPrefRepo.save(
      roomPrefRepo.create({
        address: MEMBER,
        sale_address: 'ct_other',
        muted: true,
      }),
    );
    await processor.process(job());
    expect(send).toHaveBeenCalledTimes(1);
  });
});
