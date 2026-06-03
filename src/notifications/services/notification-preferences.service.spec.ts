import { NotificationPreferencesService } from './notification-preferences.service';

type Row = { address: string; type: string; enabled: boolean };

function makeRepo(rows: Row[] = []) {
  return {
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(
        rows.find(
          (r) => r.address === where.address && r.type === where.type,
        ) ?? null,
      ),
    ),
    find: jest.fn(({ where }: { where: { address: string } }) =>
      Promise.resolve(rows.filter((r) => r.address === where.address)),
    ),
    upsert: jest.fn().mockResolvedValue(undefined),
  };
}

describe('NotificationPreferencesService', () => {
  it('isEnabled defaults to true when no row exists (opt-out model)', async () => {
    const repo = makeRepo();
    const svc = new NotificationPreferencesService(repo as any);
    expect(await svc.isEnabled('ak_x', 'announcement')).toBe(true);
  });

  it('isEnabled returns the stored boolean when a row exists', async () => {
    const repo = makeRepo([
      { address: 'ak_x', type: 'announcement', enabled: false },
    ]);
    const svc = new NotificationPreferencesService(repo as any);
    expect(await svc.isEnabled('ak_x', 'announcement')).toBe(false);
  });

  it('listFor merges catalog with stored overrides; missing rows are enabled', async () => {
    const repo = makeRepo([
      { address: 'ak_x', type: 'announcement', enabled: false },
    ]);
    const svc = new NotificationPreferencesService(repo as any);
    const list = await svc.listFor('ak_x');
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'announcement', enabled: false }),
        expect.objectContaining({ id: 'incoming-transfer', enabled: true }),
      ]),
    );
    // Wire shape uses snake_case `short_description`.
    expect(list[0]).toHaveProperty('short_description');
  });

  it('applyPartial rejects unknown notification types', async () => {
    const repo = makeRepo();
    const svc = new NotificationPreferencesService(repo as any);
    await expect(
      svc.applyPartial('ak_x', [{ type: 'totally-fake', enabled: true }]),
    ).rejects.toThrow(/Unknown notification types/);
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('applyPartial upserts known items by (address, type)', async () => {
    const repo = makeRepo();
    const svc = new NotificationPreferencesService(repo as any);
    await svc.applyPartial('ak_x', [{ type: 'announcement', enabled: false }]);
    expect(repo.upsert).toHaveBeenCalledWith(
      [{ address: 'ak_x', type: 'announcement', enabled: false }],
      { conflictPaths: ['address', 'type'] },
    );
  });
});
