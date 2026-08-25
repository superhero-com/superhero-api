import { TopicManagementService } from './topic-management.service';
import { Topic } from '@/social/entities/topic.entity';

describe('TopicManagementService', () => {
  let service: TopicManagementService;
  let topicRepository: any;
  let postRepository: any;

  beforeEach(() => {
    topicRepository = {
      query: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(undefined),
    };
    postRepository = { createQueryBuilder: jest.fn() };
    service = new TopicManagementService(topicRepository, postRepository);
  });

  const groupedCountQueryBuilder = (rows: any[]) => ({
    innerJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  });

  describe('createOrGetTopics', () => {
    it('resolves every name with one bulk upsert and one read', async () => {
      const rows = [
        { id: 't-1', name: 'alpha' },
        { id: 't-2', name: 'beta' },
      ] as Topic[];
      topicRepository.find.mockResolvedValue(rows);

      const result = await service.createOrGetTopics(['Alpha', ' beta ']);

      expect(topicRepository.query).toHaveBeenCalledTimes(1);
      expect(topicRepository.find).toHaveBeenCalledTimes(1);
      // Normalized, not raw, and returned in request order.
      expect(topicRepository.query.mock.calls[0][1][1]).toEqual([
        'alpha',
        'beta',
      ]);
      expect(result.map((t) => t.name)).toEqual(['alpha', 'beta']);
    });

    it('never overwrites an existing topic on conflict', async () => {
      topicRepository.find.mockResolvedValue([{ id: 't-1', name: 'alpha' }]);

      await service.createOrGetTopics(['alpha']);

      // DO UPDATE would reset an already-accumulated post_count.
      expect(topicRepository.query.mock.calls[0][0]).toContain(
        'ON CONFLICT (name) DO NOTHING',
      );
    });

    it('de-duplicates names that normalize to the same topic', async () => {
      topicRepository.find.mockResolvedValue([{ id: 't-1', name: 'alpha' }]);

      const result = await service.createOrGetTopics([
        'Alpha',
        'ALPHA',
        'alpha',
      ]);

      expect(topicRepository.query.mock.calls[0][1][1]).toEqual(['alpha']);
      expect(result).toHaveLength(1);
    });

    it('touches the database for neither empty nor blank input', async () => {
      await expect(service.createOrGetTopics([])).resolves.toEqual([]);
      await expect(service.createOrGetTopics(['  ', ''])).resolves.toEqual([]);
      expect(topicRepository.query).not.toHaveBeenCalled();
      expect(topicRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('updateTopicPostCounts', () => {
    it('updates every topic from a single grouped count query', async () => {
      const qb = groupedCountQueryBuilder([
        { topic_id: 'topic-1', count: '5' },
        { topic_id: 'topic-2', count: '0' },
      ]);
      postRepository.createQueryBuilder.mockReturnValue(qb);

      await service.updateTopicPostCounts([
        { id: 'topic-1', name: 'one' },
        { id: 'topic-2', name: 'two' },
      ] as Topic[]);

      expect(postRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(qb.where).toHaveBeenCalledWith('topic.id IN (:...topicIds)', {
        topicIds: ['topic-1', 'topic-2'],
      });
      expect(topicRepository.update).toHaveBeenCalledWith('topic-1', {
        post_count: 5,
      });
      expect(topicRepository.update).toHaveBeenCalledWith('topic-2', {
        post_count: 0,
      });
    });

    it('defaults to zero for a topic missing from the grouped result', async () => {
      postRepository.createQueryBuilder.mockReturnValue(
        groupedCountQueryBuilder([]),
      );

      await service.updateTopicPostCounts([
        { id: 'topic-1', name: 'one' },
      ] as Topic[]);

      expect(topicRepository.update).toHaveBeenCalledWith('topic-1', {
        post_count: 0,
      });
    });

    it('skips the count query entirely for an empty topic list', async () => {
      await service.updateTopicPostCounts([]);

      expect(postRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(topicRepository.update).not.toHaveBeenCalled();
    });

    it('writes nothing when the grouped count query fails', async () => {
      const qb = groupedCountQueryBuilder([]);
      qb.getRawMany = jest.fn().mockRejectedValue(new Error('db down'));
      postRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.updateTopicPostCounts([
          { id: 'topic-1', name: 'one' },
        ] as Topic[]),
      ).resolves.toBeUndefined();

      // Better a stale count than every topic reset to 0.
      expect(topicRepository.update).not.toHaveBeenCalled();
    });

    it('prefers the transaction manager repositories when given one', async () => {
      const qb = groupedCountQueryBuilder([
        { topic_id: 'topic-1', count: '3' },
      ]);
      const managerPostRepo = {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      };
      const managerTopicRepo = {
        update: jest.fn().mockResolvedValue(undefined),
      };
      const manager: any = {
        getRepository: jest.fn((entity) =>
          entity === Topic ? managerTopicRepo : managerPostRepo,
        ),
      };

      await service.updateTopicPostCounts(
        [{ id: 'topic-1', name: 'one' }] as Topic[],
        manager,
      );

      expect(managerTopicRepo.update).toHaveBeenCalledWith('topic-1', {
        post_count: 3,
      });
      expect(postRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(topicRepository.update).not.toHaveBeenCalled();
    });
  });
});
