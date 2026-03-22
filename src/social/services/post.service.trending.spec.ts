import { PostService } from './post.service';

jest.mock('../utils/content-parser.util', () => ({
  parsePostContent: jest.fn(() => ({
    content: 'parsed content',
    topics: [],
    media: [],
    trendMentions: ['ALPHA'],
  })),
}));

describe('PostService trending refresh', () => {
  let service: PostService;
  let postRepository: any;
  let topicRepository: any;
  let tokensService: any;

  beforeEach(() => {
    postRepository = {
      findOne: jest.fn(),
      manager: {
        transaction: jest.fn(async (handler: any) =>
          handler({
            create: jest.fn((_: any, postData: any) => postData),
            save: jest.fn(async (post: any) => post),
          }),
        ),
      },
    };
    topicRepository = {};
    tokensService = {
      updateTrendingScoresForSymbols: jest.fn(),
    };

    service = new PostService(
      postRepository as any,
      topicRepository as any,
      tokensService as any,
    );
  });

  it('keeps the saved post when trending refresh fails', async () => {
    jest.spyOn(service as any, 'validateTransaction').mockReturnValue(true);
    jest.spyOn(service as any, 'detectPostType').mockReturnValue({
      isComment: false,
      parentPostId: undefined,
      isHidden: false,
    });
    jest.spyOn(service as any, 'generatePostId').mockReturnValue('post-1');
    jest.spyOn(service as any, 'generatePostSlug').mockReturnValue('post-1');
    jest.spyOn(service as any, 'createOrGetTopics').mockResolvedValue([]);
    jest
      .spyOn(service as any, 'updateTopicPostCounts')
      .mockResolvedValue(undefined);
    postRepository.findOne.mockResolvedValue(null);
    tokensService.updateTrendingScoresForSymbols.mockRejectedValue(
      new Error('refresh failed'),
    );

    const result = await service.savePostFromTransaction(
      {
        hash: 'th_post',
        microTime: Date.now(),
        tx: {
          callerId: 'ak_sender',
          contractId: 'ct_contract',
          function: 'create_post',
          arguments: [{ value: 'raw content' }, { value: [] }],
        },
      } as any,
      {
        contractAddress: 'ct_contract',
        version: 3,
      } as any,
    );

    expect(result).toEqual(
      expect.objectContaining({
        id: 'post-1',
        token_mentions: ['ALPHA'],
      }),
    );
    expect(tokensService.updateTrendingScoresForSymbols).toHaveBeenCalledWith([
      'ALPHA',
    ]);
  });
});
