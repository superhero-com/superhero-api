import { PostTransactionProcessorService } from './post-transaction-processor.service';

jest.mock('@/social/utils/content-parser.util', () => ({
  parsePostContent: jest.fn(() => ({
    content: 'parsed content',
    topics: [],
    media: [],
    trendMentions: ['ALPHA'],
  })),
}));

describe('PostTransactionProcessorService', () => {
  let service: PostTransactionProcessorService;
  let postRepository: any;
  let validationService: any;
  let typeDetectionService: any;
  let topicManagementService: any;
  let persistenceService: any;
  let tokensService: any;

  beforeEach(() => {
    postRepository = {
      manager: {
        transaction: jest.fn(async (handler: any) => handler({})),
      },
      findOne: jest.fn(),
    };
    validationService = {
      validateTransaction: jest.fn(),
    };
    typeDetectionService = {
      detectPostType: jest.fn(),
    };
    topicManagementService = {
      createOrGetTopics: jest.fn(),
      updateTopicPostCounts: jest.fn(),
    };
    persistenceService = {
      getExistingPost: jest.fn(),
      validateContent: jest.fn(),
      createPostData: jest.fn(),
      validatePostData: jest.fn(),
      savePost: jest.fn(),
      updatePostCommentCount: jest.fn(),
    };
    tokensService = {
      updateTrendingScoresForSymbols: jest.fn(),
    };

    service = new PostTransactionProcessorService(
      postRepository as any,
      validationService as any,
      typeDetectionService as any,
      topicManagementService as any,
      persistenceService as any,
      tokensService as any,
    );
  });

  it('keeps the saved post when trending refresh fails', async () => {
    const savedPost = { id: 'post-1', token_mentions: ['ALPHA'] };

    validationService.validateTransaction.mockResolvedValue({
      isValid: true,
      contract: {},
    });
    typeDetectionService.detectPostType.mockReturnValue({
      isComment: false,
      parentPostId: undefined,
      isHidden: false,
    });
    persistenceService.getExistingPost.mockResolvedValue(null);
    persistenceService.validateContent.mockReturnValue('raw content');
    topicManagementService.createOrGetTopics.mockResolvedValue([]);
    persistenceService.createPostData.mockReturnValue({
      id: 'post-1',
      post_id: null,
      token_mentions: ['ALPHA'],
      topics: [],
      media: [],
    });
    persistenceService.validatePostData.mockImplementation((postData: any) => postData);
    persistenceService.savePost.mockResolvedValue(savedPost);
    topicManagementService.updateTopicPostCounts.mockResolvedValue(undefined);
    tokensService.updateTrendingScoresForSymbols.mockRejectedValue(
      new Error('refresh failed'),
    );

    const result = await service.processTransaction({
      hash: 'th_post',
      raw: {
        arguments: [{ value: 'raw content' }, { value: [] }],
      },
    } as any);

    expect(result).toEqual({
      post: savedPost,
      success: true,
      skipped: false,
    });
    expect(tokensService.updateTrendingScoresForSymbols).toHaveBeenCalledWith([
      'ALPHA',
    ]);
  });
});
