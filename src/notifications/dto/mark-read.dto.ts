import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional } from 'class-validator';

/**
 * Body for `POST :address/feed/read`. Omit `ids` to mark every unread item read;
 * pass a list to mark just those (still scoped to the session's address).
 */
export class MarkReadDto {
  @ApiPropertyOptional({
    type: [Number],
    description: 'Notification ids to mark read. Omit to mark all unread read.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @Type(() => Number)
  ids?: number[];
}
