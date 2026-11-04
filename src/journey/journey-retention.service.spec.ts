import { JourneyRetentionService } from './journey-retention.service';

describe('JourneyRetentionService', () => {
  it('logs a failed purge at error level with only the error code, without throwing', async () => {
    const query = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('value "secret" broke'), { code: '57014' }),
      );
    const service = new JourneyRetentionService({ query } as any);
    const error = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

    await expect(service.purgeExpired()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('57014');
    expect(String(error.mock.calls[0][0])).not.toContain('secret');
  });
});
