import { imageReference } from './image-reference';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ProfileMediaDatabase } from './profile-media-database.service';
import {
  imageCid,
  PROFILE_MEDIA_CONFIG,
  ProfileMediaConfig,
} from './profile-media.config';

@Injectable()
export class PostMediaService {
  constructor(
    private readonly db: ProfileMediaDatabase,
    @Inject(PROFILE_MEDIA_CONFIG) private readonly config: ProfileMediaConfig,
  ) {}

  /** Make the references durable BEFORE requesting the posting signature.
   * The client can disappear after broadcasting; indexer lag or a lost response
   * must never cause cleanup to remove an image from an immutable on-chain post.
   * A cancelled posting signature can therefore leave retained images behind.
   */
  async retain(address: string, cids: string[]) {
    if (
      !Array.isArray(cids) ||
      cids.length < 1 ||
      cids.length > 4 ||
      new Set(cids).size !== cids.length ||
      !cids.every(imageCid)
    )
      throw new BadRequestException('Attach between one and four images');
    await this.db.transaction(async (db) => {
      // Stable order avoids deadlocks for overlapping multi-image submissions.
      const rows = await db.query(
        `SELECT cid FROM profile_media_assets WHERE scope=$1 AND address=$2
        AND role='post' AND cid=ANY($3::text[]) AND ready
        AND cleanup_requested_at IS NULL AND deleted_at IS NULL
        ORDER BY cid FOR UPDATE`,
        [this.config.scope, address, cids],
      );
      if (rows.length !== cids.length)
        throw new BadRequestException(
          'Choose your images again; one is no longer available',
        );
      await db.query(
        `UPDATE profile_media_assets SET last_linked_at=coalesce(last_linked_at,now())
        WHERE scope=$1 AND address=$2 AND role='post' AND cid=ANY($3::text[])`,
        [this.config.scope, address, cids],
      );
    });
    return {
      media: cids.map((cid) => imageReference(cid)),
      previews: cids.map((cid) => imageReference(cid, true)),
    };
  }
}
