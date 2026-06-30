import { AeModule } from '@/ae/ae.module';
import { AffiliationModule } from '@/affiliation/affiliation.module';
import { Account } from '@/account/entities/account.entity';
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NostrLinkController } from './nostr-link.controller';
import { XLinkController } from './x-link.controller';
import { BioLinkController } from './bio-link.controller';
import { SiteLinkController } from './site-link.controller';
import { PreferredLinkController } from './preferred-link.controller';
import { AddressLinksService } from './address-links.service';
import { AddressLinksContractService } from './contract.service';
import { XLinkVerifierService } from './verification/x-link-verifier.service';
import { NostrLinkVerifierService } from './verification/nostr-link-verifier.service';
import { BioLinkVerifierService } from './verification/bio-link-verifier.service';
import { SiteLinkVerifierService } from './verification/site-link-verifier.service';
import { PreferredLinkVerifierService } from './verification/preferred-link-verifier.service';

@Module({
  imports: [
    AeModule,
    forwardRef(() => AffiliationModule),
    TypeOrmModule.forFeature([Account]),
  ],
  controllers: [
    NostrLinkController,
    XLinkController,
    BioLinkController,
    SiteLinkController,
    PreferredLinkController,
  ],
  providers: [
    AddressLinksService,
    AddressLinksContractService,
    XLinkVerifierService,
    NostrLinkVerifierService,
    BioLinkVerifierService,
    SiteLinkVerifierService,
    PreferredLinkVerifierService,
  ],
  exports: [AddressLinksContractService],
})
export class AddressLinksModule {}
