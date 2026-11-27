import { PostPersistenceService } from './post-persistence.service';
import { POST_SYNC_VERSION } from '@/social/config/post-contracts.config';

describe('PostPersistenceService', () => {
  const service = new PostPersistenceService(
    {} as any,
    {} as any,
    { emit: jest.fn() } as any,
  );

  it('accepts image-only posts and replies but rejects completely empty posts', () => {
    const tx = (content: unknown, media: unknown[]) =>
      ({ raw: { arguments: [{ value: content }, { value: media }] } }) as any;
    const media = [{ value: 'https://images.example/photo.webp' }];
    expect(service.validateContent(tx('', media))).toBe('');
    expect(
      service.validateContent(tx('', [{ value: 'comment:42_v3' }, ...media])),
    ).toBe('');
    expect(service.validateContent(tx('', []))).toBeNull();
    expect(
      service.validateContent(tx(' ', [{ value: 'comment:42_v3' }])),
    ).toBeNull();
    expect(service.validateContent(tx(undefined, media))).toBeNull();
    expect(
      service.validateContent(tx('', [{ value: 'javascript:alert(1)' }])),
    ).toBeNull();
  });

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
    const B = 'ak_28e8EYJ4wcni2KiSqhogHM7G11deM2mLPBcq1iKgVKRmSuAJgJ';
    const PARENT = 'ak_2Nn5Rr2fScJbMj3ZVtV1dkgF7Yc9QDYMATqFL8dAyNzTHGDKWd';
    let emitter: { emit: jest.Mock };
    let svc: PostPersistenceService;

    beforeEach(() => {
      emitter = { emit: jest.fn() };
      svc = new PostPersistenceService({} as any, {} as any, emitter as any);
    });

    it('emits tagged accounts, author and parent author excluded, for a live post', () => {
      svc.emitMentionEvent(
        {
          id: '5_v3',
          sender_address: A,
          content: `gm [account:${B}] [account:${A}] [account:${PARENT}]`,
        } as any,
        'th_post',
        'live' as any,
        PARENT,
      );
      expect(emitter.emit).toHaveBeenCalledWith('social.post.mentioned', {
        authorAddress: A,
        mentionedAddresses: [B],
        postId: '5_v3',
        txHash: 'th_post',
      });
    });

    it('stays quiet when the only mention is the parent author', () => {
      svc.emitMentionEvent(
        {
          id: '5_v3',
          sender_address: A,
          content: `reply [account:${PARENT}]`,
        } as any,
        'th_post',
        'live' as any,
        PARENT,
      );
      expect(emitter.emit).not.toHaveBeenCalled();
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
