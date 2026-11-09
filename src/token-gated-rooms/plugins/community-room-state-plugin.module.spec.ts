import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import {
  getDataSourceToken,
  getRepositoryToken,
  TypeOrmModule,
} from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { AeModule } from '@/ae/ae.module';
import { AeSdkService } from '@/ae/ae-sdk.service';
import tgrConfig from '../config/tgr.config';
import { RELAY_WRITER } from '../nostr/relay-writer.contract';
import { RelayWriterService } from '../nostr/relay-writer.service';
import { PublishNip29Module } from '../queues/publish-nip29.module';
import { PUBLISH_NIP29_QUEUE } from '../queues/publish-nip29.processor';
import { CommunityRoomBackfillService } from '../services/community-room-backfill.service';
import { CommunityRoomStatePluginModule } from './community-room-state-plugin.module';
import { CommunityRoomStatePlugin } from './community-room-state.plugin';
import { CommunityRoomStateSyncService } from './community-room-state-sync.service';
import { RoomStateService } from '../services/room-state.service';
import { MembershipSyncService } from '../services/membership-sync.service';
import { RoomAdminsService } from '../services/room-admins.service';
import { Token } from '@/tokens/entities/token.entity';
import { CommunityRoom } from '../entities/community-room.entity';
import { RoomMembership } from '../entities/room-membership.entity';
import { TGR_RELAY_READY } from '../events';

@Global()
@Module({
  providers: [
    SchedulerRegistry,
    {
      provide: getDataSourceToken(),
      useValue: {
        entityMetadatas: [],
        options: { type: 'postgres' },
        getRepository: () => ({}),
      },
    },
  ],
  exports: [SchedulerRegistry, getDataSourceToken()],
})
class TestInfrastructureModule {}

@Module({
  providers: [{ provide: AeSdkService, useValue: {} }],
  exports: [AeSdkService],
})
class TestAeModule {}

describe('community provisioning relay dependency', () => {
  it('resolves the existing writer across both module imports without creating a second writer', async () => {
    const container = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        EventEmitterModule.forRoot(),
        TestInfrastructureModule,
        CommunityRoomStatePluginModule,
        PublishNip29Module,
      ],
    })
      .overrideModule(AeModule)
      .useModule(TestAeModule)
      .overrideProvider(tgrConfig.KEY)
      .useValue({ publishRatePerSec: 100 })
      .overrideProvider(getQueueToken(PUBLISH_NIP29_QUEUE))
      .useValue({})
      .compile();
    try {
      const writer = container
        .select(PublishNip29Module)
        .get(RelayWriterService, { strict: true });
      const provisioning = container
        .select(CommunityRoomStatePluginModule)
        .get(CommunityRoomBackfillService, { strict: true });
      expect(container.get(RELAY_WRITER)).toBe(writer);
      expect((provisioning as any).relay).toBe(writer);
      expect((writer as any).eventEmitter).toBe(container.get(EventEmitter2));
      expect(writer.isHealthy()).toBe(false);
    } finally {
      await container.close();
    }
  });

  it('automatically catches up deferred room and membership scans through the shared readiness event', async () => {
    let healthy = false;
    const writer = { isHealthy: () => healthy };
    const query = (rows: unknown[]) => {
      const builder: any = { getMany: jest.fn(async () => rows) };
      for (const name of ['where', 'andWhere', 'orderBy', 'limit'])
        builder[name] = () => builder;
      return builder;
    };
    const roomQuery = query([{ sale_address: 'ct_new', room_id: null }]);
    const pending = {
      id: 1,
      sale_address: 'ct_existing',
      member_address: 'ak_member',
      member_pubkey: 'a'.repeat(64),
      relay_state: 'pending_remove',
    };
    const memberQuery = query([pending]);
    const tokens = {
      createQueryBuilder: () => roomQuery,
      findOne: async () => ({ nostr_room_state: 'created' }),
    };
    const members = { createQueryBuilder: () => memberQuery };
    const roomState = {
      readAndUpsertRoomState: jest.fn(async () => ({ emitted: false })),
    };
    const queue = {
      process: jest.fn(),
      isPaused: async () => false,
      add: jest.fn().mockResolvedValue(undefined),
    };
    const container = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        EventEmitterModule.forRoot(),
        TestInfrastructureModule,
        CommunityRoomStatePluginModule,
        PublishNip29Module,
        TypeOrmModule.forFeature([Token, CommunityRoom, RoomMembership]),
        ConfigModule.forFeature(tgrConfig),
      ],
      providers: [
        MembershipSyncService,
        { provide: getQueueToken(PUBLISH_NIP29_QUEUE), useValue: queue },
        {
          provide: RoomAdminsService,
          useValue: { isConfiguredAdmin: () => false },
        },
      ],
    })
      .overrideModule(AeModule)
      .useModule(TestAeModule)
      .overrideProvider(tgrConfig.KEY)
      .useValue({
        nostrRelayUrl: 'ws://relay',
        nostrBotNsec: 'configured',
        publishRatePerSec: 100,
        reconcileIntervalSec: 600,
        reconcileBatchSize: 100,
        roomProvisionBatchSize: 100,
      })
      .overrideProvider(RelayWriterService)
      .useValue(writer)
      .overrideProvider(getQueueToken(PUBLISH_NIP29_QUEUE))
      .useValue(queue)
      .overrideProvider(getRepositoryToken(Token))
      .useValue(tokens)
      .overrideProvider(getRepositoryToken(RoomMembership))
      .useValue(members)
      .overrideProvider(getRepositoryToken(CommunityRoom))
      .useValue({ findOne: async () => ({ deleted: false }) })
      .overrideProvider(RoomStateService)
      .useValue(roomState)
      .overrideProvider(CommunityRoomStatePlugin)
      .useValue({})
      .overrideProvider(CommunityRoomStateSyncService)
      .useValue({})
      .compile();
    try {
      await container.init();
      const provisioning = container.get(CommunityRoomBackfillService);
      const membership = container.get(MembershipSyncService);
      for (let tick = 0; tick < 3; tick++) {
        await provisioning.provisionRoomlessTokens(100);
        await membership.scanAndPublishPending();
      }
      expect(roomQuery.getMany).not.toHaveBeenCalled();
      expect(memberQuery.getMany).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();

      healthy = true;
      await container.get(EventEmitter2).emitAsync(TGR_RELAY_READY);
      await container.get(EventEmitter2).emitAsync(TGR_RELAY_READY);
      expect(roomState.readAndUpsertRoomState).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add.mock.calls[0][0].template.kind).toBe(9001);
      expect(pending.relay_state).toBe('pending_remove');
    } finally {
      await container.close();
    }
  });
});
