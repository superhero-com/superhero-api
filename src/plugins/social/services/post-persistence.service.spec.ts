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
});
