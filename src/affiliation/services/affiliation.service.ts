import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AffiliationService {
  private readonly logger = new Logger(AffiliationService.name);

}
