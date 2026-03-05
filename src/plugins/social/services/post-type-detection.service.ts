import { Injectable, Logger } from '@nestjs/common';
import { Tx } from '@/mdw-sync/entities/tx.entity';
import { IPostTypeInfo } from '@/social/interfaces/post.interfaces';

@Injectable()
export class PostTypeDetectionService {
  private readonly logger = new Logger(PostTypeDetectionService.name);

  /**
   * Detects the type of post from transaction arguments
   */
  detectPostType(tx: Tx): IPostTypeInfo | null {
    if (!tx?.raw?.arguments?.[1]?.value) {
      return null;
    }
    const argument = tx.raw.arguments[1];

    const postTypeInfo: IPostTypeInfo = {
      isComment: false,
      isBclSale: false,
      isBclTx: false,
      isBclGain: false,
    };

    postTypeInfo.isComment = argument.value.some((arg) =>
      arg.value?.includes('comment:'),
    );
    if (postTypeInfo.isComment) {
      const parentPostId = argument.value
        .find((arg) => arg.value?.includes('comment:'))
        ?.value?.split('comment:')[1];

      // Validate and clean the parent post ID
      if (parentPostId && parentPostId.trim().length > 0) {
        postTypeInfo.parentPostId = parentPostId.trim();
        // if post id doesn't end with _v3 add it
        if (!parentPostId.endsWith('_v3')) {
          postTypeInfo.parentPostId = `${parentPostId}_v3`;
        }
      } else {
        this.logger.warn(
          'Invalid comment format: missing or empty parent post ID',
          {
            txHash: tx.hash,
            parentPostId,
          },
        );
        // Mark as not a comment if parent ID is invalid
        postTypeInfo.isComment = false;
        postTypeInfo.parentPostId = undefined;
      }
    }

    postTypeInfo.isHidden = argument.value.some((arg) =>
      arg.value?.includes('hidden'),
    );

    postTypeInfo.isBclSale = argument.value.some((arg) =>
      arg.value?.includes('bcl:'),
    );

    postTypeInfo.isBclTx = argument.value.some((arg) =>
      arg.value?.includes('bcl-tx:'),
    );

    postTypeInfo.isBclGain = argument.value.some((arg) =>
      arg.value?.includes('bcl-gain:'),
    );

    return postTypeInfo;
  }
}
