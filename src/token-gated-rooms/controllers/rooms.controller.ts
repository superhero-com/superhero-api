import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { Pagination } from 'nestjs-typeorm-paginate';
import { RateLimitGuard } from '@/api-core/guards/rate-limit.guard';
import { AeAccountAddressPipe } from '@/common/validation/request-validation';
import { ApiOkResponsePaginated } from '@/utils/api-type';
import { DeviceChallengeService } from '@/notifications/services/device-challenge.service';
import { RequestChallengeDto } from '@/notifications/dto/request-challenge.dto';
import { RoomsQueryService } from '../services/rooms-query.service';
import { RoomMuteService } from '../services/room-mute.service';
import { RoomViewDto } from '../dto/room.view.dto';
import { RoomMemberViewDto } from '../dto/room-member.view.dto';
import { RoomConfigViewDto } from '../dto/room-config.view.dto';
import { RoomMuteViewDto } from '../dto/room-mute.view.dto';
import { UpdateRoomMuteDto } from '../dto/update-room-mute.dto';

const MAX_PAGE_LIMIT = 100;
const ROOMS_LIST_CACHE_TTL_MS = 10_000;
const MEMBERS_LIST_CACHE_TTL_MS = 10_000;
const CONFIG_CACHE_TTL_MS = 60_000;

/**
 * Client room API (Task 13). MAIN MODE — served by the API (HTTP) process.
 *
 * Read surface (public, by validated address): the rooms a holder is eligible
 * for, a room's members, the NIP-42 relay handshake config. Write surface: the
 * per-room mute preference, behind the SAME signed-challenge flow as notification
 * preferences (reuses {@link DeviceChallengeService} with a distinct, body-bound
 * room-mute message). No relay I/O, no queue enqueue, no notification dispatch —
 * the only writes are `room_notification_preference` + the type-level switch via
 * the existing prefs service.
 */
@ApiTags('Rooms')
@Controller('rooms')
@UseGuards(RateLimitGuard)
export class RoomsController {
  constructor(
    private readonly rooms: RoomsQueryService,
    private readonly mute: RoomMuteService,
    private readonly challenges: DeviceChallengeService,
  ) {}

  private validatePagination(page: number, limit: number): void {
    if (page < 1) {
      throw new BadRequestException('Page must be greater than or equal to 1');
    }
    if (limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw new BadRequestException(
        `Limit must be between 1 and ${MAX_PAGE_LIMIT}`,
      );
    }
  }

  /** Rooms the address is eligible for (paginated). */
  @Get()
  @UseInterceptors(CacheInterceptor)
  @CacheTTL(ROOMS_LIST_CACHE_TTL_MS)
  @ApiOperation({ operationId: 'listEligibleRooms' })
  @ApiQuery({ name: 'address', type: 'string', required: true })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiOkResponsePaginated(RoomViewDto)
  async listEligibleRooms(
    @Query('address', AeAccountAddressPipe) address: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
  ): Promise<Pagination<RoomViewDto>> {
    this.validatePagination(page, limit);
    return this.rooms.listEligibleRooms(address, page, limit);
  }

  /**
   * Relay handshake info for the app's NIP-42 AUTH (§16). Declared BEFORE the
   * `:saleAddress`-scoped routes so `/rooms/config` is never captured as a sale
   * address. No `address` param.
   */
  @Get('config')
  @UseInterceptors(CacheInterceptor)
  @CacheTTL(CONFIG_CACHE_TTL_MS)
  @ApiOperation({ operationId: 'getRoomConfig' })
  @ApiOkResponse({ type: RoomConfigViewDto })
  getRoomConfig(): RoomConfigViewDto {
    return this.rooms.getRoomConfig();
  }

  /** Members of a room (paginated). 404 if the room is unknown. */
  @Get(':saleAddress/members')
  @UseInterceptors(CacheInterceptor)
  @CacheTTL(MEMBERS_LIST_CACHE_TTL_MS)
  @ApiOperation({ operationId: 'listRoomMembers' })
  @ApiParam({ name: 'saleAddress', type: 'string' })
  @ApiQuery({ name: 'page', type: 'number', required: false })
  @ApiQuery({ name: 'limit', type: 'number', required: false })
  @ApiQuery({
    name: 'include_pending',
    type: 'boolean',
    required: false,
    description:
      'When true, also include eligible-but-not-yet-added members (relay_state != added). Default false = readable (added) members only.',
  })
  @ApiOkResponsePaginated(RoomMemberViewDto)
  async listRoomMembers(
    @Param('saleAddress') saleAddress: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit = 100,
    @Query('include_pending', new DefaultValuePipe(false), ParseBoolPipe)
    includePending = false,
  ): Promise<Pagination<RoomMemberViewDto>> {
    this.validatePagination(page, limit);
    return this.rooms.listRoomMembers(saleAddress, page, limit, includePending);
  }

  /** Current room-mute state for `(address, saleAddress)`. Public read. */
  @Get(':saleAddress/mute')
  @ApiOperation({ operationId: 'getRoomMute' })
  @ApiParam({ name: 'saleAddress', type: 'string' })
  @ApiQuery({ name: 'address', type: 'string', required: true })
  @ApiOkResponse({ type: RoomMuteViewDto })
  async getRoomMute(
    @Param('saleAddress') saleAddress: string,
    @Query('address', AeAccountAddressPipe) address: string,
  ): Promise<RoomMuteViewDto> {
    return this.mute.getMute(address, saleAddress);
  }

  /**
   * Issue a single-use nonce for the room-mute signed write. Reuses the shared
   * challenge table (per-address pending cap applies); intent is distinguished by
   * the message the client rebuilds and signs (see `room-mute.message.ts`).
   */
  @Post(':saleAddress/mute/challenge')
  @ApiOperation({ operationId: 'requestRoomMuteChallenge' })
  @ApiParam({ name: 'saleAddress', type: 'string' })
  async requestRoomMuteChallenge(@Body() dto: RequestChallengeDto) {
    return this.challenges.issue(dto.address);
  }

  /**
   * Set the per-room mute (and, optionally, mute-all) for `address`, signed. The
   * signature binds to the body-hashed room-mute message, so a captured nonce+sig
   * — or a swapped `muted`/`mute_all`/room — is rejected. Address is carried in
   * the body (the route varies only by `:saleAddress`).
   */
  @Post(':saleAddress/mute')
  @HttpCode(200)
  @ApiOperation({ operationId: 'setRoomMute' })
  @ApiParam({ name: 'saleAddress', type: 'string' })
  @ApiOkResponse({ type: RoomMuteViewDto })
  async setRoomMute(
    @Param('saleAddress') saleAddress: string,
    @Body() dto: UpdateRoomMuteDto,
  ): Promise<RoomMuteViewDto> {
    await this.challenges.verifyAndConsumeForRoomMute(
      dto.nonce,
      dto.address,
      saleAddress,
      dto.muted,
      dto.mute_all,
      dto.signature,
    );
    return this.mute.setMute(dto.address, saleAddress, dto.muted, dto.mute_all);
  }
}
