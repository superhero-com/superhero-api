import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { BclPnlService } from '../services/bcl-pnl.service';

@Controller('accounts')
@ApiTags('Accounts')
export class BclPnlController {
  constructor(
    private readonly bclPnlService: BclPnlService,
    private readonly aeSdkService: AeSdkService,
  ) {}

  @ApiOperation({ operationId: 'getPnl' })
  @ApiParam({ name: 'address', type: 'string', description: 'Account address' })
  @ApiQuery({
    name: 'blockHeight',
    type: 'number',
    required: false,
    description: 'Block height (default: current block height)',
  })
  @Get(':address/pnl')
  async getPnl(
    @Param('address') address: string,
    @Query('blockHeight') blockHeight?: string,
  ) {
    // If blockHeight is not provided, get the current block height
    let targetBlockHeight: number;
    if (blockHeight) {
      targetBlockHeight = parseInt(blockHeight, 10);
      if (isNaN(targetBlockHeight)) {
        throw new BadRequestException('blockHeight must be a valid number');
      }
    } else {
      const currentGeneration =
        await this.aeSdkService.sdk.getCurrentGeneration();
      targetBlockHeight = currentGeneration.keyBlock.height;
    }

    const pnlResult = await this.bclPnlService.calculateTokenPnls(
      address,
      targetBlockHeight,
    );

    // Calculate total PNL percentage
    const totalPnlPercentage =
      pnlResult.totalCostBasisAe > 0
        ? (pnlResult.totalGainAe / pnlResult.totalCostBasisAe) * 100
        : 0;

    return {
      blockHeight: targetBlockHeight,
      total_pnl: {
        percentage: totalPnlPercentage,
        invested: {
          ae: pnlResult.totalCostBasisAe,
          usd: pnlResult.totalCostBasisUsd,
        },
        current_value: {
          ae: pnlResult.totalCurrentValueAe,
          usd: pnlResult.totalCurrentValueUsd,
        },
        gain: {
          ae: pnlResult.totalGainAe,
          usd: pnlResult.totalGainUsd,
        },
      },
      tokens_pnl: pnlResult.pnls,
    };
  }
}

