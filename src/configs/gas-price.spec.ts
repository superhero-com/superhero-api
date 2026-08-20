import {
  buildTxAsync,
  encode,
  Encoding,
  Node,
  Tag,
  unpackTx,
} from '@aeternity/aepp-sdk';
import { pinNetworkGasPricing, resolveMinGasPrice } from './gas-price';

const RAMP_STEP_1 = 2_220_000_000n;
const CALL_DATA = encode(Buffer.alloc(32, 1), Encoding.ContractBytearray);
const STUB_ADDRESS = 'ak_11111111111111111111111111111111273Yts';

const fakeNode = (utilization: number, minGasPrice: bigint): Node =>
  ({
    getRecentGasPrices: async () => [{ minGasPrice, utilization, minutes: 1 }],
  }) as unknown as Node;

const buildSpend = async (onNode: Node) => {
  const tx = await buildTxAsync({
    tag: Tag.SpendTx,
    senderId: STUB_ADDRESS,
    recipientId: STUB_ADDRESS,
    amount: 1n,
    nonce: 1,
    ttl: 0,
    onNode,
  });
  const { fee } = unpackTx(tx, Tag.SpendTx) as unknown as { fee: string };
  return BigInt(fee);
};

const buildContractCall = async (
  onNode: Node,
  extra: Record<string, unknown> = {},
) => {
  const tx = await buildTxAsync({
    tag: Tag.ContractCallTx,
    callerId: STUB_ADDRESS,
    contractId: 'ct_11111111111111111111111111111111273Yts',
    amount: 0n,
    gas: 100000,
    nonce: 1,
    ttl: 0,
    callData: CALL_DATA,
    onNode,
    ...extra,
  });
  const unpacked = unpackTx(tx, Tag.ContractCallTx) as unknown as {
    fee: string;
    gasPrice: string;
  };
  return { fee: BigInt(unpacked.fee), gasPrice: BigInt(unpacked.gasPrice) };
};

describe('resolveMinGasPrice', () => {
  it('defaults to the SDK floor when unset', () => {
    expect(resolveMinGasPrice(undefined)).toBe(1_000_000_000n);
    expect(resolveMinGasPrice('  ')).toBe(1_000_000_000n);
  });

  it('never resolves below the SDK floor', () => {
    expect(resolveMinGasPrice('1')).toBe(1_000_000_000n);
  });

  it('limits an out-of-range value to the SDK maximum', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveMinGasPrice('999999999999999999')).toBe(100_000_000_000_000n);
  });

  it('falls back to the SDK floor on a non-integer value', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolveMinGasPrice('2.22e9')).toBe(1_000_000_000n);
  });

  it('accepts a configured floor above the SDK one', () => {
    expect(resolveMinGasPrice(String(RAMP_STEP_1))).toBe(RAMP_STEP_1);
  });
});

describe('pinNetworkGasPricing', () => {
  afterEach(() => jest.restoreAllMocks());

  it('pins utilization and lifts the reported price to the floor', async () => {
    const node = pinNetworkGasPricing(
      fakeNode(17, 1_000_000_000n),
      RAMP_STEP_1,
    );

    expect(await node.getRecentGasPrices()).toEqual([
      { minGasPrice: RAMP_STEP_1, utilization: 70, minutes: 1 },
    ]);
  });

  it('keeps a reported price above the floor', async () => {
    const node = pinNetworkGasPricing(
      fakeNode(90, 5_000_000_000n),
      RAMP_STEP_1,
    );

    expect((await node.getRecentGasPrices())[0].minGasPrice).toBe(
      5_000_000_000n,
    );
  });

  it('lifts the spend fee off the SDK fallback', async () => {
    // 16660 gas at the hardcoded 1e9, blind to any relay floor above it.
    expect(await buildSpend(fakeNode(17, 1_000_000_000n))).toBe(
      16_660_000_000_000n,
    );
    // Same gas at the pinned floor plus the SDK's own 1% headroom.
    expect(
      await buildSpend(
        pinNetworkGasPricing(fakeNode(17, 1_000_000_000n), RAMP_STEP_1),
      ),
    ).toBe(37_355_052_000_000n);
  });

  it('lifts both fee and gasPrice on a contract call', async () => {
    // An explicit gasPrice moves that field only — fee stays on the 1e9 basis,
    // which is the half a per-call-site override cannot reach.
    expect(
      await buildContractCall(fakeNode(17, 1_000_000_000n), {
        gasPrice: RAMP_STEP_1,
      }),
    ).toEqual({ fee: 182_500_000_000_000n, gasPrice: RAMP_STEP_1 });

    expect(
      await buildContractCall(
        pinNetworkGasPricing(fakeNode(17, 1_000_000_000n), RAMP_STEP_1),
      ),
    ).toEqual({ fee: 409_201_500_000_000n, gasPrice: 2_242_200_000n });
  });
});
