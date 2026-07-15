const redisSetMock = jest.fn();
const redisMock = {
  on: jest.fn().mockReturnThis(),
  quit: jest.fn().mockResolvedValue('OK'),
  set: redisSetMock,
};

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => redisMock),
}));

import { ReadsService } from './reads.service';

describe('ReadsService', () => {
  let repo: any;
  let service: ReadsService;

  const buildReq = (ua = 'Mozilla/5.0', ip = '1.2.3.4') =>
    ({
      headers: { 'user-agent': ua },
      ip,
      socket: { remoteAddress: ip },
    }) as any;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = { query: jest.fn().mockResolvedValue(undefined) };
    service = new ReadsService(repo);
  });

  it('counts the first read of a viewer per post per day', async () => {
    redisSetMock.mockResolvedValue('OK');

    await service.recordRead('post-1', buildReq());

    expect(redisSetMock).toHaveBeenCalledWith(
      expect.stringContaining('reads:seen:'),
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
    expect(repo.query).toHaveBeenCalledTimes(1);
  });

  it('skips repeat reads from the same viewer on the same day', async () => {
    redisSetMock.mockResolvedValue(null);

    await service.recordRead('post-1', buildReq());

    expect(repo.query).not.toHaveBeenCalled();
  });

  it('fails open and counts the read when Redis is unavailable', async () => {
    redisSetMock.mockRejectedValue(new Error('redis down'));

    await service.recordRead('post-1', buildReq());

    expect(repo.query).toHaveBeenCalledTimes(1);
  });

  it('ignores bot user agents entirely', async () => {
    await service.recordRead('post-1', buildReq('curl/8.0.1'));

    expect(redisSetMock).not.toHaveBeenCalled();
    expect(repo.query).not.toHaveBeenCalled();
  });

  it('treats a missing user agent as a bot', async () => {
    await service.recordRead('post-1', { headers: {} } as any);

    expect(redisSetMock).not.toHaveBeenCalled();
    expect(repo.query).not.toHaveBeenCalled();
  });

  it('fails open when the viewer IP cannot be determined', async () => {
    const req = {
      headers: { 'user-agent': 'Mozilla/5.0' },
      socket: {},
    } as any;

    await service.recordRead('post-1', req);

    expect(redisSetMock).not.toHaveBeenCalled();
    expect(repo.query).toHaveBeenCalledTimes(1);
  });

  it('identifies the viewer by the first x-forwarded-for hop only', async () => {
    redisSetMock.mockResolvedValue('OK');
    const reqWithXff = (xff: string) =>
      ({
        headers: { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': xff },
        ip: '10.0.0.1',
        socket: { remoteAddress: '10.0.0.1' },
      }) as any;

    await service.recordRead('post-1', reqWithXff('1.1.1.1, 2.2.2.2'));
    await service.recordRead('post-1', reqWithXff('1.1.1.1, 9.9.9.9'));
    await service.recordRead('post-1', reqWithXff('3.3.3.3, 2.2.2.2'));

    const keys = redisSetMock.mock.calls.map((call) => call[0]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('never throws when the reads upsert fails', async () => {
    redisSetMock.mockResolvedValue('OK');
    repo.query.mockRejectedValue(new Error('db down'));

    await expect(
      service.recordRead('post-1', buildReq()),
    ).resolves.toBeUndefined();
  });
});
