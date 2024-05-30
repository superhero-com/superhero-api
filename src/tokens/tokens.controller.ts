import { Controller, Get, Param } from '@nestjs/common';
import { TokensService } from './tokens.service';

@Controller('tokens')
export class TokensController {
  constructor(private readonly tokensService: TokensService) {}

  @Get()
  findAll() {
    return this.tokensService.findAll();
  }

  @Get(':address')
  findOne(@Param('address') address: string) {
    return this.tokensService.findByAddress(address);
  }
}
