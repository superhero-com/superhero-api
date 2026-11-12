import { ShortsDatabaseModule } from './shorts-database.module';
import { Module } from '@nestjs/common';
import { ShortsPublicationsService } from './shorts-publications.service';

// Imported by the isolated publisher and its trusted admission boundary. This
// module never imports the API core, media decoder, wallet key or local store.
@Module({
  imports: [ShortsDatabaseModule],
  providers: [ShortsPublicationsService],
  exports: [ShortsPublicationsService],
})
export class ShortsPublicationsModule {}
