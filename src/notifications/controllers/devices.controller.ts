import { RateLimitGuard } from '@/api-core/guards/rate-limit.guard';
import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DeviceService } from '../services/device.service';
import { DeviceChallengeService } from '../services/device-challenge.service';
import { RequestChallengeDto } from '../dto/request-challenge.dto';
import { RegisterDeviceDto } from '../dto/register-device.dto';
import { UnregisterDeviceDto } from '../dto/unregister-device.dto';

@ApiTags('notifications')
@Controller('notifications/devices')
@UseGuards(RateLimitGuard)
export class DevicesController {
  constructor(
    private readonly deviceService: DeviceService,
    private readonly challengeService: DeviceChallengeService,
  ) {}

  /** Issue a nonce + the exact message the device must sign for `address`. */
  @Post('challenge')
  async requestChallenge(@Body() dto: RequestChallengeDto) {
    return this.challengeService.issue(dto.address);
  }

  /** Register/refresh a device's Expo token for an address (signature-verified). */
  @Post()
  @HttpCode(200)
  async register(@Body() dto: RegisterDeviceDto) {
    await this.deviceService.register(dto);
    return { ok: true };
  }

  /**
   * Unregister a device (logout / push disabled). Requires a signed challenge
   * that binds to both the address and the token; otherwise anyone who knew a
   * push token could silently disable the victim's notifications.
   */
  @Delete()
  @HttpCode(200)
  async unregister(@Body() dto: UnregisterDeviceDto) {
    await this.deviceService.unregister(dto);
    return { ok: true };
  }
}
