import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RateLimitGuard } from '@/api-core/guards/rate-limit.guard';
import { AeAccountAddressPipe } from '@/common/validation/request-validation';
import { DeviceChallengeService } from '../services/device-challenge.service';
import {
  PriceAlertService,
  PriceAlertView,
} from '../price-alerts/price-alert.service';
import {
  CreatePriceAlertDto,
  DeletePriceAlertDto,
  PriceAlertViewDto,
} from '../dto/price-alert.dto';

/**
 * Token price alerts. Reads are public by address (like preferences); writes
 * need a signed challenge from POST /notifications/preferences/challenge,
 * bound to the exact alert body (see price-alert.message.ts).
 */
@ApiTags('notifications')
@Controller('notifications')
@UseGuards(RateLimitGuard)
export class PriceAlertsController {
  constructor(
    private readonly challenges: DeviceChallengeService,
    private readonly priceAlerts: PriceAlertService,
  ) {}

  @Get(':address/price-alerts')
  @ApiOkResponse({ type: [PriceAlertViewDto] })
  async list(
    @Param('address', AeAccountAddressPipe) address: string,
  ): Promise<PriceAlertView[]> {
    return this.priceAlerts.listFor(address);
  }

  @Post(':address/price-alerts')
  @HttpCode(201)
  @ApiOkResponse({ type: PriceAlertViewDto })
  async create(
    @Param('address', AeAccountAddressPipe) address: string,
    @Body() dto: CreatePriceAlertDto,
  ): Promise<PriceAlertView> {
    await this.challenges.verifyAndConsumeForPriceAlert(
      dto.nonce,
      address,
      {
        action: 'create',
        saleAddress: dto.sale_address,
        direction: dto.direction,
        targetAe: dto.target_ae,
      },
      dto.signature,
    );
    return this.priceAlerts.create(
      address,
      dto.sale_address,
      dto.direction,
      dto.target_ae,
    );
  }

  @Delete(':address/price-alerts/:id')
  @HttpCode(204)
  async remove(
    @Param('address', AeAccountAddressPipe) address: string,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DeletePriceAlertDto,
  ): Promise<void> {
    await this.challenges.verifyAndConsumeForPriceAlert(
      dto.nonce,
      address,
      { action: 'delete', alertId: id },
      dto.signature,
    );
    await this.priceAlerts.remove(address, id);
  }
}
