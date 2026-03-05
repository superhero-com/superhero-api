import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AeModule } from '@/ae/ae.module';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { PluginSyncState } from '@/mdw-sync/entities/plugin-sync-state.entity';
import { Post } from '@/social/entities/post.entity';
import { Topic } from '@/social/entities/topic.entity';
import { Account } from '@/account/entities/account.entity';
import socialConfig from './config/post-contracts.config';
import { SocialPlugin } from './social.plugin';
import { SocialPluginSyncService } from './social-plugin-sync.service';
import { PostTransactionValidationService } from './services/post-transaction-validation.service';
import { PostTypeDetectionService } from './services/post-type-detection.service';
import { TopicManagementService } from './services/topic-management.service';
import { PostPersistenceService } from './services/post-persistence.service';
import { PostTransactionProcessorService } from './services/post-transaction-processor.service';

@Module({
  imports: [
    ConfigModule.forFeature(socialConfig),
    TypeOrmModule.forFeature([Tx, PluginSyncState, Post, Topic, Account]),
    AeModule,
  ],
  providers: [
    PostTransactionValidationService,
    PostTypeDetectionService,
    TopicManagementService,
    PostPersistenceService,
    PostTransactionProcessorService,
    SocialPluginSyncService,
    SocialPlugin,
  ],
  exports: [SocialPlugin],
})
export class SocialPluginModule {}
