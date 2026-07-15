import 'dotenv/config';
import { DataSource, Repository } from 'typeorm';
import { MemoryAccount, verifyMessageSignature } from '@aeternity/aepp-sdk';
import { DATABASE_CONFIG } from '@/configs/database';
import { Token } from '@/tokens/entities/token.entity';
import { NotificationPreference } from '@/notifications/entities/notification-preference.entity';
import { DeviceChallenge } from '@/notifications/entities/device-challenge.entity';
import { NotificationPreferencesService } from '@/notifications/services/notification-preferences.service';
import { DeviceChallengeService } from '@/notifications/services/device-challenge.service';
import { CommunityRoom } from '../entities/community-room.entity';
import { RoomMembership } from '../entities/room-membership.entity';
import { RoomNotificationPreference } from '../entities/room-notification-preference.entity';
import { RoomsQueryService } from '../services/rooms-query.service';
import { RoomPreferencesService } from '../services/room-preferences.service';
import { RoomMuteService } from '../services/room-mute.service';
import { buildRoomMuteMessage } from '../notifications/room-mute.message';

/**
 * Task 13 client room API — DB integration (harness mirrors Task 04's isolated
 * `tgrNN_test` schema). Drives the read services + the signed mute roundtrip
 * against a real Postgres; the relay/queue are never touched (out of scope).
 *
 * Auto-skips when `DB_HOST` is unset so unit-only runs stay green.
 */
const HAS_DB = !!process.env.DB_HOST;
const d = HAS_DB ? describe : describe.skip;

const SCHEMA = 'tgr13_test';
const SALE_ELIGIBLE = 'ct_tgr13_eligible';
const SALE_UNLINKED = 'ct_tgr13_unlinked';
const SALE_INELIGIBLE = 'ct_tgr13_ineligible';

// a valid nsec (secret = 32 bytes of 0x01); derived pubkey is deterministic.
const NSEC = 'nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqstywftw';
const EXPECTED_PUB =
  '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f';

const tgrConfigStub = {
  nostrRelayUrl: 'ws://relay.tgr13.local',
  nostrBotNsec: NSEC,
} as any;

const challengeConfig = {
  challengeTtlMs: 300_000,
  challengeMaxPendingPerAddress: 5,
} as any;

d('Client room API (integration)', () => {
  let ds: DataSource;
  let roomRepo: Repository<CommunityRoom>;
  let membershipRepo: Repository<RoomMembership>;
  let roomPrefRepo: Repository<RoomNotificationPreference>;
  let notifPrefRepo: Repository<NotificationPreference>;
  let challengeRepo: Repository<DeviceChallenge>;

  let query: RoomsQueryService;
  let muteService: RoomMuteService;
  let roomPrefs: RoomPreferencesService;
  let challenges: DeviceChallengeService;

  let account: any;
  let address: string;

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
        RoomNotificationPreference,
        NotificationPreference,
        DeviceChallenge,
      ],
    });
    await ds.initialize();

    roomRepo = ds.getRepository(CommunityRoom);
    membershipRepo = ds.getRepository(RoomMembership);
    roomPrefRepo = ds.getRepository(RoomNotificationPreference);
    notifPrefRepo = ds.getRepository(NotificationPreference);
    challengeRepo = ds.getRepository(DeviceChallenge);

    const notifPrefs = new NotificationPreferencesService(notifPrefRepo);
    roomPrefs = new RoomPreferencesService(roomPrefRepo, notifPrefs);
    muteService = new RoomMuteService(roomPrefs, notifPrefs);
    query = new RoomsQueryService(roomRepo, membershipRepo, tgrConfigStub);
    challenges = new DeviceChallengeService(challengeRepo, challengeConfig);

    account = MemoryAccount.generate();
    address = account.address;
  }, 60_000);

  beforeEach(async () => {
    await membershipRepo.clear();
    await roomRepo.clear();
    await roomPrefRepo.clear();
    await notifPrefRepo.clear();
    await challengeRepo.clear();

    await roomRepo.save([
      roomRepo.create({
        sale_address: SALE_ELIGIBLE,
        token_address: 'ct_token_e',
        symbol: 'ELIG',
        owner_address: 'ak_owner',
        is_private: true,
        is_community: false,
        deleted: false,
        created_height: 200,
      }),
      roomRepo.create({
        sale_address: SALE_UNLINKED,
        token_address: 'ct_token_u',
        symbol: 'UNLK',
        owner_address: 'ak_owner',
        is_private: true,
        is_community: false,
        deleted: false,
        created_height: 100,
      }),
      roomRepo.create({
        sale_address: SALE_INELIGIBLE,
        token_address: 'ct_token_i',
        symbol: 'INEL',
        owner_address: 'ak_owner',
        is_private: false,
        is_community: false,
        deleted: false,
        created_height: 50,
      }),
    ]);

    await membershipRepo.save([
      // eligible + added + linked → readable
      membershipRepo.create({
        sale_address: SALE_ELIGIBLE,
        member_address: address,
        member_pubkey: 'a'.repeat(64),
        role: 'member',
        eligible: true,
        relay_state: 'added',
      }),
      // eligible but unlinked (§6.6): no pubkey, pending_add → readable=false
      membershipRepo.create({
        sale_address: SALE_UNLINKED,
        member_address: address,
        member_pubkey: null,
        role: 'member',
        eligible: true,
        relay_state: 'pending_add',
      }),
      // ineligible → must NOT appear in the eligible list
      membershipRepo.create({
        sale_address: SALE_INELIGIBLE,
        member_address: address,
        member_pubkey: 'c'.repeat(64),
        role: 'member',
        eligible: false,
        relay_state: 'added',
      }),
      // another member of the eligible room (for the members list)
      membershipRepo.create({
        sale_address: SALE_ELIGIBLE,
        member_address: 'ak_other_member',
        member_pubkey: 'd'.repeat(64),
        role: 'admin',
        eligible: true,
        relay_state: 'added',
      }),
    ]);
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await ds.destroy();
    }
  });

  it('listEligibleRooms returns only eligible + non-deleted rooms with correct readable', async () => {
    const res = await query.listEligibleRooms(address, 1, 100);
    const bySale = new Map(res.items.map((r) => [r.sale_address, r]));
    expect(res.meta.totalItems).toBe(2); // eligible + unlinked, NOT ineligible
    expect(bySale.has(SALE_INELIGIBLE)).toBe(false);

    expect(bySale.get(SALE_ELIGIBLE)).toMatchObject({
      symbol: 'ELIG',
      relay_state: 'added',
      readable: true,
    });
    expect(bySale.get(SALE_UNLINKED)).toMatchObject({
      symbol: 'UNLK',
      relay_state: 'pending_add',
      member_pubkey: null,
      readable: false,
    });
    // newest (created_height DESC) first
    expect(res.items[0].sale_address).toBe(SALE_ELIGIBLE);
  });

  it('listEligibleRooms paginates deterministically', async () => {
    const p1 = await query.listEligibleRooms(address, 1, 1);
    const p2 = await query.listEligibleRooms(address, 2, 1);
    expect(p1.items).toHaveLength(1);
    expect(p2.items).toHaveLength(1);
    expect(p1.items[0].sale_address).not.toBe(p2.items[0].sale_address);
    expect(p1.meta.totalItems).toBe(2);
  });

  it('listRoomMembers returns the added members; unknown room → 404', async () => {
    const res = await query.listRoomMembers(SALE_ELIGIBLE, 1, 100);
    expect(res.items.length).toBe(2);
    expect(res.items[0]).not.toHaveProperty('balance');
    await expect(
      query.listRoomMembers('ct_does_not_exist', 1, 100),
    ).rejects.toThrow(/not found/i);
  });

  it('getRoomConfig returns the relay url + derived hex admin pubkey (never the nsec)', () => {
    const cfg = query.getRoomConfig();
    expect(cfg.relay_url).toBe('ws://relay.tgr13.local');
    expect(cfg.admin_pubkey).toBe(EXPECTED_PUB);
    expect(JSON.stringify(cfg)).not.toContain(NSEC);
  });

  it('mute roundtrip: challenge → sign → verify+set persists; replay rejected; Task 12 isRoomEnabled honors it', async () => {
    // 1. issue challenge
    const { nonce } = await challenges.issue(address);

    // 2. sign the body-bound room-mute message
    const message = buildRoomMuteMessage(
      address,
      nonce,
      SALE_ELIGIBLE,
      true,
      true,
    );
    const sigBytes = await account.signMessage(message);
    expect(
      verifyMessageSignature(message, sigBytes, address as `ak_${string}`),
    ).toBe(true);
    const signature = Buffer.from(sigBytes).toString('hex');

    // 3. verify + apply (the controller's two steps)
    await challenges.verifyAndConsumeForRoomMute(
      nonce,
      address,
      SALE_ELIGIBLE,
      true,
      true,
      signature,
    );
    const state = await muteService.setMute(address, SALE_ELIGIBLE, true, true);
    expect(state).toEqual({ muted: true, mute_all: true });

    // per-room row persisted
    const row = await roomPrefRepo.findOne({
      where: { address, sale_address: SALE_ELIGIBLE },
    });
    expect(row?.muted).toBe(true);

    // 4. replay the SAME nonce → rejected
    await expect(
      challenges.verifyAndConsumeForRoomMute(
        nonce,
        address,
        SALE_ELIGIBLE,
        true,
        true,
        signature,
      ),
    ).rejects.toThrow(/already used/i);

    // 5. cross-task enforcement: the pref this task wrote is the one Task 12 reads.
    expect(
      await roomPrefs.isRoomEnabled(address, 'room-messages', SALE_ELIGIBLE),
    ).toBe(false);
  });

  it('mute write with only per-room muted leaves the type-level switch untouched', async () => {
    const { nonce } = await challenges.issue(address);
    const message = buildRoomMuteMessage(
      address,
      nonce,
      SALE_ELIGIBLE,
      true,
      undefined,
    );
    const sigBytes = await account.signMessage(message);
    const signature = Buffer.from(sigBytes).toString('hex');

    await challenges.verifyAndConsumeForRoomMute(
      nonce,
      address,
      SALE_ELIGIBLE,
      true,
      undefined,
      signature,
    );
    const state = await muteService.setMute(
      address,
      SALE_ELIGIBLE,
      true,
      undefined,
    );
    // mute_all stays false (no room-messages override written)
    expect(state).toEqual({ muted: true, mute_all: false });
    const typeRow = await notifPrefRepo.findOne({
      where: { address, type: 'room-messages' },
    });
    expect(typeRow).toBeNull();
  });
});
