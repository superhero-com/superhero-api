import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ArrayUnique,
  IsInt,
  Min,
  Max,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ImageRole, MediaRole } from './profile-media.config';

export class ImageChallengeDto {
  @ApiProperty({ enum: ['post'], required: false })
  @IsOptional()
  @IsIn(['post'])
  purpose?: 'post';
  @ApiProperty() @IsString() @MaxLength(100) address: string;
}
export class ImageVerifyDto {
  @ApiProperty() @Matches(/^[a-f0-9]{48}$/) id: string;
  @ApiProperty() @IsString() @MaxLength(256) signature: string;
}
export class ImageClaimDto {
  @ApiProperty({ enum: ['avatar', 'cover'] })
  @IsIn(['avatar', 'cover'])
  role: ImageRole;
  @ApiProperty({
    nullable: true,
    description: 'Uploaded directory CIDv1; null removes this image',
  })
  @ValidateIf((body) => body.cid !== null)
  @Matches(/^bafy[a-z2-7]{55}$/)
  cid: string | null;
}
export class ImageSubmitDto {
  @ApiProperty() @IsUUID() id: string;
  @ApiProperty() @IsString() @MaxLength(256) signature: string;
}
export class ImageUploadDto {
  @ApiProperty({ enum: ['avatar', 'cover', 'post'] })
  @IsIn(['avatar', 'cover', 'post'])
  role: MediaRole;
  @ApiProperty() @IsInt() @Min(1) @Max(10485760) bytes: number;
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) sha256: string;
}
export class ImagePartDto {
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) sha256: string;
}
export class ImageChecksumDto {
  @ApiProperty() @Matches(/^[a-f0-9]{64}$/) checksum: string;
}

export class PostAttachmentsDto {
  @ApiProperty({ type: [String], maxItems: 4 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ArrayUnique()
  @Matches(/^bafy[a-z2-7]{55}$/, { each: true })
  cids: string[];
}
