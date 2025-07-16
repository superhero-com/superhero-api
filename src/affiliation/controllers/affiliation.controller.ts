import { Controller, Post, Body, Param, Get } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Affiliation } from '../entities/affiliation.entity';
import { AffiliationCode } from '../entities/affiliation-code.entity';
import { OAuthService } from '../services/oauth.service';

class CreateAffiliationDto {
  sender_address: string;
  codes: string[];
}

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
  async getJoinInviteInfo(@Param('code') code: string) {
    /**
     * TODO:
     * - make sure this affiliation has non claimed codes.
     */
    return this.affiliationRepository.findOne({ where: { code } });
  }

  @Post('invites/:code/:provider/:access_code')
  @ApiOperation({
    operationId: 'getRewardCode',
    summary: 'Get reward code',
  })
  async getRewardCode(
    @Param('code') code: string,
    @Param('provider') provider: string,
    @Param('access_code') access_code: string,
  ) {
    // Verify the access token with the OAuth provider
    const userInfo = await this.oauthService.verifyAccessToken(
      provider,
      access_code,
    );

    // Check if the affiliation exists and has non-claimed codes
    const affiliation = await this.affiliationRepository.findOne({
      where: { code },
      relations: ['codes'],
    });

    if (!affiliation) {
      throw new Error('Affiliation not found');
    }

    // Check if there are any non-claimed codes available
    const availableCodes =
      affiliation.codes?.filter((c) => !c.claimed_at) || [];

    if (availableCodes.length === 0) {
      throw new Error('No available codes for this affiliation');
    }

    // Return the user info along with affiliation details
    return {
      user: userInfo,
      affiliation: {
        code: affiliation.code,
        available_codes: availableCodes.length,
      },
    };
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
        result += chars.charAt(Math.floor(Math.random() * chars.length));
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
}
