import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RateLimitGuard } from '@/api-core/guards/rate-limit.guard';
import { AeAccountAddressPipe } from '@/common/validation/request-validation';
import { DeviceChallengeService } from '../services/device-challenge.service';
import { NotificationPreferencesService } from '../services/notification-preferences.service';
import { RequestChallengeDto } from '../dto/request-challenge.dto';
import { UpdatePreferencesDto } from '../dto/update-preferences.dto';
import { PreferenceView } from '../dto/preference.view.dto';

@ApiTags('notifications')
@Controller('notifications')
@UseGuards(RateLimitGuard)
export class PreferencesController {
  constructor(
    private readonly challenges: DeviceChallengeService,
    private readonly preferences: NotificationPreferencesService,
  ) {}

  /**
   * Issue a nonce the user must sign in the preferences-update message. The
   * message string is rebuilt client-side from `(address, nonce, preferences)`
   * — exposing only the nonce here prevents server-side drift from confusing
   * which message format applies to which intent.
   */
  @Post('preferences/challenge')
  async requestChallenge(@Body() dto: RequestChallengeDto) {
    return this.challenges.issue(dto.address);
  }

  /**
   * Catalog merged with this address's stored overrides. Public, by validated
   * address — case-mismatch (which would silently create a stranded preference
   * row) is now blocked by the pipe.
   */
  @Get(':address/preferences')
  @ApiOkResponse({ type: [PreferenceView] })
  async list(
    @Param('address', AeAccountAddressPipe) address: string,
  ): Promise<PreferenceView[]> {
    return this.preferences.listFor(address);
  }

  /**
   * Partial upsert of preferences for `address`. The signature now binds to the
   * canonical hash of the body (sorted `type=0|1` joined by `;`, SHA-256), so a
   * captured nonce+sig cannot be replayed with a swapped `preferences` array.
   */
  @Post(':address/preferences')
  @HttpCode(200)
  @ApiOkResponse({ type: [PreferenceView] })
  async update(
    @Param('address', AeAccountAddressPipe) address: string,
    @Body() dto: UpdatePreferencesDto,
  ): Promise<PreferenceView[]> {
    await this.challenges.verifyAndConsumeForPreferences(
      dto.nonce,
      address,
      dto.preferences,
      dto.signature,
    );
    await this.preferences.applyPartial(address, dto.preferences);
    return this.preferences.listFor(address);
  }
}
