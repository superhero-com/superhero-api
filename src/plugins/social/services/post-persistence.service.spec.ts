import { PostPersistenceService } from './post-persistence.service';
import { POST_SYNC_VERSION } from '@/social/config/post-contracts.config';

describe('PostPersistenceService', () => {
  const service = new PostPersistenceService(
    {} as any,
    {} as any,
    { emit: jest.fn() } as any,
  );

  it('stamps new posts with the shared POST_SYNC_VERSION', () => {
    const postData = service.createPostData(
      {
        hash: 'th_post',
        micro_time: '1700000000000',
        raw: { return: { value: '42' }, arguments: [] },
      } as any,
      { contractAddress: 'ct_post', version: 3 },
      { content: 'hello', topics: [], media: [], trendMentions: [] },
      [],
      { isComment: false, isBclSale: false, isBclTx: false, isBclGain: false },
    );
    expect(postData.version).toBe(POST_SYNC_VERSION);
    expect(postData.id).toBe('42_v3');
  });

  describe('emitMentionEvent', () => {
    const A = 'ak_2a1j2Mk9YSmC1gioUq4PWRm3bsv887MbuRVwyv4KaUGoR1eiKi';
    const B = 'ak_wNCqvVaG7mrkTVK4RjrjPwsFEgRVuWpkGHdkAp2GRiemN9G1t';
    let emitter: { emit: jest.Mock };
    let svc: PostPersistenceService;

    beforeEach(() => {
      emitter = { emit: jest.fn() };
      svc = new PostPersistenceService({} as any, {} as any, emitter as any);
    });

    it('emits tagged accounts, author excluded, for a live post', () => {
      svc.emitMentionEvent(
        {
          id: '5_v3',
          sender_address: A,
          content: `gm [account:${B}] [account:${A}]`,
        } as any,
        'th_post',
        'live' as any,
        'ak_parent',
      );
      expect(emitter.emit).toHaveBeenCalledWith('social.post.mentioned', {
        authorAddress: A,
        mentionedAddresses: [B],
        postId: '5_v3',
        txHash: 'th_post',
        parentAuthorAddress: 'ak_parent',
      });
    });

    it('stays quiet for backfill, replays and posts without mentions', () => {
      const post = {
        id: '5_v3',
        sender_address: A,
        content: `gm [account:${B}]`,
      } as any;
      svc.emitMentionEvent(post, 'th_post', 'backward' as any);
      svc.emitMentionEvent(post, 'th_post', 'reorg' as any);
      svc.emitMentionEvent(
        { ...post, content: `self [account:${A}] and ${B}` },
        'th_post',
        'live' as any,
      );
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });
});
