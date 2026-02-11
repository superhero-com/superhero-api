import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountModule } from '@/account/account.module';
import { Profile } from './entities/profile.entity';
import { ProfileUpdateChallenge } from './entities/profile-update-challenge.entity';
import { ProfileController } from './controllers/profile.controller';
import { ProfileService } from './services/profile.service';

@Module({
  imports: [
    AccountModule,
    TypeOrmModule.forFeature([Profile, ProfileUpdateChallenge]),
  ],
  controllers: [ProfileController],
  providers: [ProfileService],
})
export class ProfileModule {}
