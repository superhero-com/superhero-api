import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiOkResponse,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { BclPnlService } from '../services/bcl-pnl.service';
import { GetPnlQueryDto } from '../dto/get-pnl-query.dto';
import { GetPnlResponseDto } from '../dto/pnl-response.dto';

@Controller('accounts')
@ApiTags('Accounts')
export class BclPnlController {
  constructor(
    private readonly bclPnlService: BclPnlService,
    private readonly aeSdkService: AeSdkService,
  ) {}

  @ApiOperation({ operationId: 'getPnl' })
  @ApiParam({ name: 'address', type: 'string', description: 'Account address' })
  @ApiOkResponse({ type: GetPnlResponseDto })
  @Get(':address/pnl')
  async getPnl(
    @Param('address') address: string,
    @Query() query: GetPnlQueryDto,
  ) {
    // If blockHeight is not provided, get the current block height
    let targetBlockHeight: number;
    if (query.blockHeight !== undefined && query.blockHeight !== null) {
      if (isNaN(query.blockHeight) || query.blockHeight < 0) {
        throw new BadRequestException(
          'blockHeight must be a valid positive number',
        );
      }
      targetBlockHeight = query.blockHeight;
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
      block_height: targetBlockHeight,
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
