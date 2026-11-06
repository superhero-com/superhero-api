import {
  Controller,
  Post,
  Body,
  Param,
  Get,
  Render,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Raw, Repository } from 'typeorm';
import { randomInt } from 'crypto';
import { CreateAffiliationDto } from '../dto/create-affiliation.dto';
import { Affiliation } from '../entities/affiliation.entity';
import { AffiliationCode } from '../entities/affiliation-code.entity';
import { OAuthService } from '../services/oauth.service';
import {
  InviteCodePipe,
  ProviderParamPipe,
} from '@/common/validation/request-validation';

// Serializes invite claims across instances. Distinct from the other 1-arg
// keys (…746–…750).
export const INVITE_CLAIM_LOCK_KEY = 4019283751;

@Controller('affiliations')
@ApiTags('Affiliations')
export class AffiliationController {
  constructor(
    @InjectRepository(Affiliation)
    private affiliationRepository: Repository<Affiliation>,
    @InjectRepository(AffiliationCode)
    private affiliationCodeRepository: Repository<AffiliationCode>,
    private oauthService: OAuthService,
  ) {
    //
  }

  @Get('invites/:code')
  @ApiOperation({
    operationId: 'getJoinInviteInfo',
    summary: 'Get invite link',
  })
  async getJoinInviteInfo(@Param('code', InviteCodePipe) code: string) {
    return this.affiliationRepository.findOne({ where: { code } });
  }

  @Post('invites/:code/:provider/:access_code')
  @ApiOperation({
    operationId: 'getRewardCode',
    summary: 'Get reward code',
  })
  async getRewardCode(
    @Param('code', InviteCodePipe) code: string,
    @Param('provider', ProviderParamPipe) provider: string,
    @Param('access_code') access_code: string,
  ) {
    // Verify the access token with the OAuth provider
    const userInfo = await this.oauthService.verifyAccessToken(
      provider,
      access_code,
    );

    // The provider param is case-insensitive, so every spelling of it must
    // map to the same claimant.
    const claimant = `${provider.toLowerCase()}@${userInfo.id}`;

    // The claimant check and the pick are read-then-write, so without the
    // lock parallel requests could each walk away with a code, and two users
    // could be handed the same one.
    return this.affiliationCodeRepository.manager.transaction(
      async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock($1)', [
          INVITE_CLAIM_LOCK_KEY,
        ]);

        const affiliation = await manager.findOne(Affiliation, {
          where: { code },
          relations: ['codes'],
        });

        if (!affiliation) {
          throw new NotFoundException('Affiliation not found');
        }

        // Lowercased on both sides so a mixed-case provider (old rows) or id
        // can't hide an earlier claim.
        const claimedCode = await manager.findOne(AffiliationCode, {
          where: {
            claimed_by: Raw((alias) => `LOWER(${alias}) = LOWER(:claimant)`, {
              claimant,
            }),
          },
        });

        // A code with claimed_by set has been shown to someone even when
        // claimed_at is empty, which is how claims were stored before.
        const availableCodes =
          affiliation.codes?.filter((c) => !c.claimed_at && !c.claimed_by) ||
          [];

        let invitationCode: AffiliationCode;
        if (claimedCode) {
          // The user already holds this secret, so handing it out again leaks
          // nothing and lets them recover from a lost response.
          if (!affiliation.codes?.some((c) => c.id === claimedCode.id)) {
            throw new ConflictException('User already claimed a code');
          }
          invitationCode = claimedCode;
        } else {
          if (availableCodes.length === 0) {
            throw new ConflictException(
              'No available codes for this affiliation',
            );
          }

          invitationCode = availableCodes[randomInt(availableCodes.length)];
          await manager.update(AffiliationCode, invitationCode.id, {
            claimed_by: claimant,
            claimed_at: new Date(),
          });
        }

        // Return only the minimum data the client needs to redeem the invite.
        // Previously this leaked the full OAuth profile (including email) and
        // the full AffiliationCode entity (including claimed_by), which was
        // unnecessary PII exposure over an unauthenticated endpoint.
        return {
          affiliation: {
            code: affiliation.code,
            available_codes: availableCodes.length,
          },
          invitationCode: {
            private_code: invitationCode.private_code,
          },
        };
      },
    );
  }

  @Post('')
  @ApiOperation({
    operationId: 'generateMultipleInviteLink',
    summary: 'Generate multiple invites link',
  })
  @ApiResponse({
    status: 200,
    description: 'Affiliation created successfully',
    type: CreateAffiliationDto,
  })
  @ApiBody({
    type: CreateAffiliationDto,
    description: 'Create affiliation',
    examples: {
      'example 1': {
        value: {
          sender_address: 'ak_...',
          codes: ['code1', 'code2', 'code3'],
        },
      },
    },
  })
  async generateMultieInviteLink(
    @Body() createAffiliationDto: CreateAffiliationDto,
  ) {
    // Generate random code (10 characters, a-z, 0-9)
    const generateRandomCode = (): string => {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let result = '';
      for (let i = 0; i < 10; i++) {
        result += chars.charAt(randomInt(chars.length));
      }
      return result;
    };

    // Create new affiliation
    const affiliation = this.affiliationRepository.create({
      account_address: createAffiliationDto.sender_address,
      code: generateRandomCode(),
    });

    const savedAffiliation = await this.affiliationRepository.save(affiliation);

    // Create affiliation codes for each code in the array
    const affiliationCodes = createAffiliationDto.codes.map((code) =>
      this.affiliationCodeRepository.create({
        affiliation: savedAffiliation,
        private_code: code,
      }),
    );

    if (affiliationCodes.length > 0) {
      await this.affiliationCodeRepository.save(affiliationCodes);
    }

    // Return only the affiliation code
    return {
      code: savedAffiliation.code,
    };
  }

  @Get('preview')
  @Render('affiliation')
  root() {
    return { message: 'Hello world!' };
  }
}
