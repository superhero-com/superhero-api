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
});
