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
      validateParentPost: jest.fn(),
      emitCommentCreatedEvent: jest.fn(),
      generatePostId: jest.fn(),
    };
    tokensService = {
      queueTrendingScoresForSymbols: jest.fn(),
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
    persistenceService.validatePostData.mockImplementation(
      (postData: any) => postData,
    );
    persistenceService.savePost.mockResolvedValue(savedPost);
    topicManagementService.updateTopicPostCounts.mockResolvedValue(undefined);
    tokensService.queueTrendingScoresForSymbols.mockRejectedValue(
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
    expect(tokensService.queueTrendingScoresForSymbols).toHaveBeenCalledWith([
      'ALPHA',
    ]);
  });

  it('emits POST_COMMENT_CREATED_EVENT on the fresh-comment path after the savePost transaction', async () => {
    const parentPost = { id: 'p_parent', sender_address: 'ak_author' };
    const savedComment = {
      id: 'p_comment',
      sender_address: 'ak_commenter',
      token_mentions: [],
    };

    validationService.validateTransaction.mockResolvedValue({
      isValid: true,
      contract: {},
    });
    typeDetectionService.detectPostType.mockReturnValue({
      isComment: true,
      parentPostId: 'p_parent',
      isHidden: false,
    });
    persistenceService.getExistingPost.mockResolvedValue(null);
    persistenceService.validateContent.mockReturnValue('reply text');
    persistenceService.validateParentPost.mockResolvedValue(parentPost);
    topicManagementService.createOrGetTopics.mockResolvedValue([]);
    persistenceService.createPostData.mockReturnValue({
      id: 'p_comment',
      post_id: 'p_parent',
      sender_address: 'ak_commenter',
      token_mentions: [],
      topics: [],
      media: [],
    });
    persistenceService.validatePostData.mockImplementation(
      (postData: any) => postData,
    );
    persistenceService.savePost.mockResolvedValue(savedComment);
    persistenceService.updatePostCommentCount.mockResolvedValue(undefined);
    topicManagementService.updateTopicPostCounts.mockResolvedValue(undefined);
    tokensService.queueTrendingScoresForSymbols.mockResolvedValue(undefined);

    await service.processTransaction({
      hash: 'th_comment',
      raw: { arguments: [{ value: 'reply text' }, { value: [] }] },
    } as any);

    expect(persistenceService.emitCommentCreatedEvent).toHaveBeenCalledTimes(1);
    expect(persistenceService.emitCommentCreatedEvent).toHaveBeenCalledWith(
      parentPost,
      savedComment,
      'th_comment',
      'live',
    );
  });

  it('does NOT emit POST_COMMENT_CREATED_EVENT when the parent post is missing (comment converts to a regular post)', async () => {
    validationService.validateTransaction.mockResolvedValue({
      isValid: true,
      contract: {},
    });
    typeDetectionService.detectPostType.mockReturnValue({
      isComment: true,
      parentPostId: 'p_missing',
      isHidden: false,
    });
    persistenceService.getExistingPost.mockResolvedValue(null);
    persistenceService.validateContent.mockReturnValue('orphan text');
    persistenceService.validateParentPost.mockResolvedValue(null);
    topicManagementService.createOrGetTopics.mockResolvedValue([]);
    persistenceService.createPostData.mockReturnValue({
      id: 'p_orphan',
      post_id: null,
      token_mentions: [],
      topics: [],
      media: [],
    });
    persistenceService.validatePostData.mockImplementation(
      (postData: any) => postData,
    );
    persistenceService.savePost.mockResolvedValue({
      id: 'p_orphan',
      token_mentions: [],
    });
    topicManagementService.updateTopicPostCounts.mockResolvedValue(undefined);
    tokensService.queueTrendingScoresForSymbols.mockResolvedValue(undefined);

    await service.processTransaction({
      hash: 'th_orphan',
      raw: { arguments: [{ value: 'orphan text' }, { value: [] }] },
    } as any);

    expect(persistenceService.emitCommentCreatedEvent).not.toHaveBeenCalled();
  });

  it('inserts once when runs for the same hash overlap', async () => {
    const savedPost = { id: 'post-1', token_mentions: [] };
    let stored: any = null;

    validationService.validateTransaction.mockResolvedValue({
      isValid: true,
      contract: {},
    });
    typeDetectionService.detectPostType.mockReturnValue({
      isComment: false,
      isHidden: false,
    });
    persistenceService.getExistingPost.mockImplementation(async () => stored);
    persistenceService.generatePostId.mockReturnValue('post-1');
    persistenceService.validateContent.mockReturnValue('raw content');
    topicManagementService.createOrGetTopics.mockResolvedValue([]);
    persistenceService.createPostData.mockReturnValue({
      id: 'post-1',
      post_id: null,
      topics: [],
      media: [],
    });
    persistenceService.validatePostData.mockImplementation(
      (postData: any) => postData,
    );
    persistenceService.savePost.mockImplementation(async () => {
      stored = savedPost;
      return savedPost;
    });

    const tx = {
      hash: 'th_post',
      raw: { arguments: [{ value: 'raw content' }, { value: [] }] },
    } as any;
    const results = await Promise.all([
      service.processTransaction(tx),
      service.processTransaction(tx),
      service.processTransaction(tx),
    ]);

    expect(persistenceService.savePost).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result?.post)).toEqual([
      savedPost,
      savedPost,
      savedPost,
    ]);
    expect(results.every((result) => result?.success)).toBe(true);
  });

  it('runs different hashes concurrently', async () => {
    let releaseFirst: (value: unknown) => void;
    validationService.validateTransaction
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValue({ isValid: false });

    const first = service.processTransaction({ hash: 'th_a' } as any);
    const second = service.processTransaction({ hash: 'th_b' } as any);
    await new Promise((resolve) => setImmediate(resolve));

    expect(validationService.validateTransaction).toHaveBeenCalledTimes(2);
    releaseFirst({ isValid: false });
    await Promise.all([first, second]);
  });

  it('logs and still saves when a new post id belongs to another transaction', async () => {
    const savedPost = { id: '8_v3', token_mentions: [] };
    const logError = jest.spyOn((service as any).logger, 'error');

    validationService.validateTransaction.mockResolvedValue({
      isValid: true,
      contract: {},
    });
    typeDetectionService.detectPostType.mockReturnValue({
      isComment: false,
      isHidden: false,
    });
    persistenceService.getExistingPost.mockResolvedValue(null);
    persistenceService.validateContent.mockReturnValue('raw content');
    topicManagementService.createOrGetTopics.mockResolvedValue([]);
    persistenceService.createPostData.mockReturnValue({
      id: '8_v3',
      post_id: null,
      topics: [],
      media: [],
    });
    persistenceService.validatePostData.mockImplementation(
      (postData: any) => postData,
    );
    persistenceService.savePost.mockResolvedValue(savedPost);
    postRepository.findOne.mockResolvedValue({
      id: '8_v3',
      tx_hash: 'th_early',
    });

    const result = await service.processTransaction({
      hash: 'th_chain',
      raw: { arguments: [{ value: 'raw content' }, { value: [] }] },
    } as any);

    expect(result).toEqual({ post: savedPost, success: true, skipped: false });
    expect(persistenceService.savePost).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      'Post id already belongs to another transaction',
      { txHash: 'th_chain', postId: '8_v3', overwrittenTxHash: 'th_early' },
    );
  });

  it('logs an error when an existing post id differs from the chain result', async () => {
    const existingPost = { id: '7_v3', post_id: null };
    const logError = jest.spyOn((service as any).logger, 'error');

    validationService.validateTransaction.mockResolvedValue({
      isValid: true,
      contract: { version: 3 },
    });
    typeDetectionService.detectPostType.mockReturnValue({
      isComment: false,
      isHidden: false,
    });
    persistenceService.getExistingPost.mockResolvedValue(existingPost);
    persistenceService.generatePostId.mockReturnValue('8_v3');

    const result = await service.processTransaction({
      hash: 'th_forked',
      raw: { arguments: [{ value: 'text' }, { value: [] }] },
    } as any);
    expect(result).toEqual({
      post: existingPost,
      success: true,
      skipped: false,
    });
    expect(logError).toHaveBeenCalledWith(
      'Stored post id differs from the chain result',
      { txHash: 'th_forked', storedId: '7_v3', computedId: '8_v3' },
    );
  });
});
