import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RateLimitGuard } from '@/api-core/guards/rate-limit.guard';
import { RoomViewDto } from '../dto/room.view.dto';
import { RecheckRoomDto } from '../dto/recheck-room.dto';
import { RoomRecheckService } from '../services/room-recheck.service';

/**
 * On-demand room-access recheck (`POST /rooms/:saleAddress/recheck`).
 *
 * The client calls this when a holder is stuck on "Setting up your access…": unlike
 * the passive, cached `GET /rooms` read, this ACTIVELY recomputes eligibility,
 * reads the relay's authoritative member set, and heals/provisions the caller's
 * membership ({@link RoomRecheckService}). Returns the refreshed caller view so the
 * composer can unlock immediately. Rate-limited (idempotent + safe to repeat).
 *
 * Lives in `TokenGatedRoomsModule` (not `ClientRoomApiModule`) because the heal path
 * needs the relay writer + eligibility + room-backfill providers; co-locating it
 * there keeps the wiring acyclic.
 */
@ApiTags('Rooms')
@Controller('rooms')
@UseGuards(RateLimitGuard)
export class RoomRecheckController {
  constructor(private readonly recheck: RoomRecheckService) {}

  @Post(':saleAddress/recheck')
  @HttpCode(200)
  @ApiOperation({ operationId: 'recheckRoomAccess' })
  @ApiParam({ name: 'saleAddress', type: 'string' })
  @ApiOkResponse({
    type: RoomViewDto,
    description:
      'Refreshed caller view after the recheck. 200 with an empty body when the caller is not eligible / the sale address is not a gated room.',
  })
  async recheckRoomAccess(
    @Param('saleAddress') saleAddress: string,
    @Body() dto: RecheckRoomDto,
  ): Promise<RoomViewDto | null> {
    return this.recheck.recheck(dto.address, saleAddress);
  }
}
