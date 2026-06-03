import { ConflictException } from '@nestjs/common';
import { DeviceService } from './device.service';

describe('DeviceService', () => {
  let repo: any;
  let registry: any;
  let challenges: any;
  let config: any;
  let qb: any;
  let service: DeviceService;

  const validToken = 'ExponentPushToken[abc123]';
  const baseDto = {
    address: 'ak_alice',
    expoPushToken: validToken,
    platform: 'ios' as const,
    nonce: 'n1',
    signature: 'sg_ok',
  };
  const unlinkDto = {
    address: 'ak_alice',
    expoPushToken: validToken,
    nonce: 'n2',
    signature: 'sg_ok2',
  };

  beforeEach(() => {
    qb = {
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    repo = {
      query: jest.fn().mockResolvedValue([{ address: 'ak_alice' }]),
      exist: jest.fn().mockResolvedValue(false),
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => qb),
    };
    registry = {
      addAddress: jest.fn().mockResolvedValue(undefined),
      removeAddress: jest.fn().mockResolvedValue(undefined),
      rebuild: jest.fn().mockResolvedValue(undefined),
      listAddressesWithDevice: jest
        .fn()
        .mockResolvedValue(['ak_alice', 'ak_bob']),
    };
    challenges = {
      verifyAndConsume: jest.fn().mockResolvedValue(undefined),
      verifyAndConsumeForUnlink: jest.fn().mockResolvedValue(undefined),
    };
    config = { staleDeviceDays: 90 };
    service = new DeviceService(repo, registry, challenges, config);
  });

  it('verifies the token-bound challenge then INSERT…ON CONFLICT and addAddress', async () => {
    await service.register(baseDto);
    expect(challenges.verifyAndConsume).toHaveBeenCalledWith(
      'n1',
      'ak_alice',
      validToken,
      'sg_ok',
    );
    expect(repo.query).toHaveBeenCalled();
    const [sql, params] = repo.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO device_tokens/);
    expect(sql).toMatch(/ON CONFLICT \(expo_push_token\) DO UPDATE/);
    expect(sql).toMatch(/WHERE device_tokens.address = EXCLUDED.address/);
    expect(params[0]).toBe(validToken);
    expect(params[1]).toBe('ak_alice');
    expect(registry.addAddress).toHaveBeenCalledWith('ak_alice');
  });

  it('refuses to re-point a token already owned by a different address (RETURNING empty)', async () => {
    repo.query.mockResolvedValue([]); // conflict was on a row with another address
    await expect(service.register(baseDto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(registry.addAddress).not.toHaveBeenCalled();
  });

  it('unregister verifies the signed unlink challenge then runs the atomic CTE', async () => {
    repo.count.mockResolvedValue(0);
    // CTE returns: { deleted: number, existing_address: string|null }
    repo.query.mockResolvedValueOnce([{ deleted: 1, existing_address: null }]);

    await service.unregister(unlinkDto);

    expect(challenges.verifyAndConsumeForUnlink).toHaveBeenCalledWith(
      'n2',
      'ak_alice',
      validToken,
      'sg_ok2',
    );
    expect(repo.query).toHaveBeenCalled();
    const [sql, params] = repo.query.mock.calls[0];
    expect(sql).toMatch(/WITH deleted AS/);
    expect(sql).toMatch(/DELETE FROM device_tokens/);
    expect(sql).toMatch(/WHERE expo_push_token = \$1 AND address = \$2/);
    expect(params).toEqual([validToken, 'ak_alice']);
    expect(registry.removeAddress).toHaveBeenCalledWith('ak_alice');
  });

  it('unregister is idempotent for an unknown token (deleted=0, no existing row)', async () => {
    repo.query.mockResolvedValueOnce([{ deleted: 0, existing_address: null }]);
    await expect(service.unregister(unlinkDto)).resolves.toBeUndefined();
    expect(registry.removeAddress).not.toHaveBeenCalled();
  });

  it('unregister returns 409 when the token is owned by a different address (deleted=0, existing row)', async () => {
    repo.query.mockResolvedValueOnce([
      { deleted: 0, existing_address: 'ak_other' },
    ]);
    await expect(service.unregister(unlinkDto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(registry.removeAddress).not.toHaveBeenCalled();
  });

  it('getActiveTokens returns the token strings for an address', async () => {
    repo.find.mockResolvedValue([
      { expo_push_token: 't1' },
      { expo_push_token: 't2' },
    ]);
    await expect(service.getActiveTokens('ak_alice')).resolves.toEqual([
      't1',
      't2',
    ]);
  });

  it('distinctAddressesWithDevice delegates to the registry (single source of truth)', async () => {
    await expect(service.distinctAddressesWithDevice()).resolves.toEqual([
      'ak_alice',
      'ak_bob',
    ]);
    expect(registry.listAddressesWithDevice).toHaveBeenCalledTimes(1);
    // It must NOT run its own query — the registry owns it.
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  describe('cleanupStaleDevices', () => {
    const mockTx = (lockHeld: boolean, affected: number) => {
      const em = {
        query: jest
          .fn()
          .mockResolvedValue([{ pg_try_advisory_xact_lock: lockHeld }]),
        delete: jest.fn().mockResolvedValue({ affected }),
      };
      repo.manager = {
        transaction: jest.fn(async (cb: any) => cb(em)),
      };
      return em;
    };

    it('prunes by last_seen_at under an advisory lock, then rebuilds the gate', async () => {
      const em = mockTx(true, 3);
      await service.cleanupStaleDevices();
      // advisory lock acquired
      expect(em.query.mock.calls[0][0]).toMatch(/pg_try_advisory_xact_lock/);
      // delete used a LessThan(cutoff) on last_seen_at
      expect(em.delete).toHaveBeenCalledTimes(1);
      const [, criteria] = em.delete.mock.calls[0];
      expect(criteria).toHaveProperty('last_seen_at');
      // rebuild only runs because rows were actually pruned
      expect(registry.rebuild).toHaveBeenCalledTimes(1);
    });

    it('no-ops (no delete, no rebuild) when another replica holds the lock', async () => {
      const em = mockTx(false, 0);
      await service.cleanupStaleDevices();
      expect(em.delete).not.toHaveBeenCalled();
      expect(registry.rebuild).not.toHaveBeenCalled();
    });

    it('does not rebuild when nothing was stale', async () => {
      mockTx(true, 0);
      await service.cleanupStaleDevices();
      expect(registry.rebuild).not.toHaveBeenCalled();
    });

    it('swallows errors so the cron never throws', async () => {
      repo.manager = {
        transaction: jest.fn().mockRejectedValue(new Error('db down')),
      };
      await expect(service.cleanupStaleDevices()).resolves.toBeUndefined();
    });
  });
});
