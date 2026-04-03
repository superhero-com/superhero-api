import { AeModule } from '@/ae/ae.module';
import { AffiliationModule } from '@/affiliation/affiliation.module';
import { Account } from '@/account/entities/account.entity';
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AddressLinksController } from './address-links.controller';
import { AddressLinksService } from './address-links.service';
import { AddressLinksContractService } from './contract.service';
import { AddressLinksEventListenerService } from './event-listener.service';
import { XLinkVerifierService } from './verification/x-link-verifier.service';
import { NostrLinkVerifierService } from './verification/nostr-link-verifier.service';

@Module({
  imports: [
    AeModule,
    forwardRef(() => AffiliationModule),
    TypeOrmModule.forFeature([Account]),
  ],
  controllers: [AddressLinksController],
  providers: [
    AddressLinksService,
    AddressLinksContractService,
    AddressLinksEventListenerService,
    XLinkVerifierService,
    NostrLinkVerifierService,
  ],
  exports: [AddressLinksContractService],
})
export class AddressLinksModule {}
