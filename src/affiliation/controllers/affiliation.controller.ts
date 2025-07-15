import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Affiliation } from '../entities/affiliation.entity';

@Controller('affiliations')
@ApiTags('Affiliations')
export class AffiliationController {
  constructor(
    @InjectRepository(Affiliation)
    private analyticRepository: Repository<Affiliation>,
  ) {
    //
  }

  @Get('')
  async getAffiliations() {
    return {
      code: '123456',
    };
  }
}
