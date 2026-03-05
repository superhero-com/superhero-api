import { AeModule } from '@/ae/ae.module';
import { AffiliationModule } from '@/affiliation/affiliation.module';
import { Account } from '@/account/entities/account.entity';
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
// import { ProfileController } from './controllers/profile.controller';
import { ProfileCache } from './entities/profile-cache.entity';
import { ProfileSyncState } from './entities/profile-sync-state.entity';
import { ProfileXVerificationReward } from './entities/profile-x-verification-reward.entity';
import { ProfileAttestationService } from './services/profile-attestation.service';
import { ProfileContractService } from './services/profile-contract.service';
import { ProfileIndexerService } from './services/profile-indexer.service';
import { ProfileLiveSyncService } from './services/profile-live-sync.service';
import { ProfileReadService } from './services/profile-read.service';
import { ProfileXVerificationRewardService } from './services/profile-x-verification-reward.service';

@Module({
  imports: [
    AeModule,
    forwardRef(() => AffiliationModule),
    TypeOrmModule.forFeature([
      ProfileCache,
      ProfileSyncState,
      ProfileXVerificationReward,
      Account,
    ]),
  ],
  providers: [
    ProfileAttestationService,
    ProfileContractService,
    ProfileIndexerService,
    ProfileLiveSyncService,
    ProfileReadService,
    ProfileXVerificationRewardService,
  ],
  // TODO: Disable unfinished profile feature
  // controllers: [ProfileController],
  exports: [TypeOrmModule, ProfileReadService, ProfileContractService],
})
export class ProfileModule {}
