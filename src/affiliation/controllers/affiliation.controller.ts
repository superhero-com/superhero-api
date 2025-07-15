import { Controller, Post, Body } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Affiliation } from '../entities/affiliation.entity';
import { AffiliationCode } from '../entities/affiliation-code.entity';

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
  ) {
    //
  }

  @Post('')
  @ApiOperation({ summary: 'Generate multiple invites link' })
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
