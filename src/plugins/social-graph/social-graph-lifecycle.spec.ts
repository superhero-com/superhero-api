import { Contract } from '@aeternity/aepp-sdk';
import { SocialGraphLifecycle } from './social-graph-lifecycle';
const policy = {
  contract: 'ct_destination',
  height: '120',
  block_hash: 'kh_snap',
  import_source: 'ct_source',
  legacy_source: null,
};
const activation = {
  txHash: 'th_act',
  height: '110',
  blockHash: 'mh_act',
  keyBlockHash: 'kh_act',
  events: [{ name: 'ImportCompleted', args: ['ak_source'] }],
};
const freeze = {
  txHash: 'th_freeze',
  height: '100',
  blockHash: 'mh_freeze',
  keyBlockHash: 'kh_freeze',
  events: [{ name: 'Frozen', args: ['ak_destination'] }],
};
describe('Migration evidence boundaries', () => {
  afterEach(() => jest.restoreAllMocks());
  it('does not invent lifecycle heights for a fresh deployment', async () => {
    expect(
      await new SocialGraphLifecycle({} as any).verify(
        { ...policy, import_source: null },
        {},
      ),
    ).toEqual({ sourceCutoff: null, activationHeight: null, proof: null });
  });
  it('requires matching source/destination receipt evidence before projection import', async () => {
    const service = new SocialGraphLifecycle({} as any);
    await expect(service.verify(policy, {})).rejects.toThrow('ACTIVATION_TX');
    jest
      .spyOn(service, 'receipt')
      .mockResolvedValueOnce(activation)
      .mockResolvedValueOnce(freeze);
    const proof = await service.verify(policy, {
      activationTx: 'th_act',
      freezeTx: 'th_freeze',
    });
    expect(proof).toMatchObject({
      sourceCutoff: '100',
      activationHeight: '110',
      proof: { kind: 'frozen-source' },
    });
    jest.spyOn(service, 'receipt').mockResolvedValueOnce({
      ...activation,
      events: [{ name: 'ImportCompleted', args: ['ak_wrong'] }],
    });
    await expect(
      service.verify(policy, { activationTx: 'th_act', freezeTx: 'th_freeze' }),
    ).rejects.toThrow('source');
  });
  it('checks legacy commitment and canonical snapshot while preserving the owner trust boundary', async () => {
    const service = new SocialGraphLifecycle({
      getKeyBlockByHash: async () => ({ hash: 'kh_legacy', height: 99 }),
      getKeyBlockByHeight: async () => ({ hash: 'kh_legacy' }),
    } as any);
    jest.spyOn(service, 'receipt').mockResolvedValue(activation);
    jest.spyOn(Contract, 'initialize').mockResolvedValue({
      get_import_progress: async () => ({
        decodedResult: [0n, 0n, 2n, 2n, Buffer.alloc(32, 1)],
      }),
    } as any);
    const legacy = {
      ...policy,
      import_source: null,
      legacy_source: 'ct_source',
    };
    const options = {
      activationTx: 'th_act',
      legacySnapshotHash: 'kh_legacy',
      legacyManifestHash: '01'.repeat(32),
    };
    expect(await service.verify(legacy, options)).toMatchObject({
      sourceCutoff: '99',
      proof: {
        kind: 'owner-approved-legacy',
        manifest_commitment: '01'.repeat(32),
      },
    });
    await expect(
      service.verify(legacy, {
        ...options,
        legacyManifestHash: '02'.repeat(32),
      }),
    ).rejects.toThrow('commitment');
  });
});
