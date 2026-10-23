import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  AeAccountAddressPipe,
  AeContractAddressPipe,
  OptionalAeContractAddressPipe,
} from '@/common/validation/request-validation';
import {
  DelegatedPowerResult,
  GovernancePowerService,
  PollPowerResult,
} from '../services/governance-power.service';

@Controller('governance')
@ApiTags('Governance')
export class GovernancePowerController {
  constructor(private readonly powerService: GovernancePowerService) {}

  @ApiParam({ name: 'pollAddress', type: String })
  @ApiOperation({
    operationId: 'getGovernancePollPower',
    summary: 'Stake-weighted results of a poll',
    description:
      'Per-option stake, total vote power and each voter stake (own balance + delegated balance) at the poll close height, or the current height while the poll is open. Amounts are in AE.',
  })
  @Get('polls/:pollAddress/power')
  async pollPower(
    @Param('pollAddress', AeContractAddressPipe) pollAddress: string,
  ): Promise<PollPowerResult> {
    return this.powerService.getPollPower(pollAddress);
  }

  @ApiParam({ name: 'accountAddress', type: String })
  @ApiQuery({
    name: 'poll',
    type: String,
    required: false,
    description:
      'Poll address. Delegators who voted in this poll keep their own power.',
  })
  @ApiOperation({
    operationId: 'getGovernanceDelegatedPower',
    summary: 'Vote power of an account',
    description:
      'Own AE balance plus the balance delegated to the account (directly or through a chain). Amounts are in AE.',
  })
  @Get('power/:accountAddress')
  async delegatedPower(
    @Param('accountAddress', AeAccountAddressPipe) accountAddress: string,
    @Query('poll', OptionalAeContractAddressPipe) poll?: string,
  ): Promise<DelegatedPowerResult> {
    return this.powerService.getDelegatedPower(accountAddress, poll);
  }
}
