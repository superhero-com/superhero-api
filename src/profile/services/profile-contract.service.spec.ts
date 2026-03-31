import fs from 'fs';
import path from 'path';
import { Contract } from '@aeternity/aepp-sdk';
import { ProfileContractService } from './profile-contract.service';

jest.mock('@aeternity/aepp-sdk', () => {
  const actual = jest.requireActual('@aeternity/aepp-sdk');
  return {
    ...actual,
    Contract: {
      ...actual.Contract,
      initialize: jest.fn(),
    },
  };
});

describe('ProfileContractService', () => {
  const setup = () => {
    const initializeContract = (
      Contract.initialize as jest.Mock
    ).mockResolvedValue({
      get_profile: jest.fn().mockResolvedValue({ decodedResult: null }),
    } as any);
    const aeSdkService = {
      sdk: {
        getContext: jest.fn().mockReturnValue({ onCompiler: {}, onNode: {} }),
      },
    } as any;

    const service = new ProfileContractService(aeSdkService);
    return { service, initializeContract };
  };

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('loads ACI from default relative path when available', async () => {
    const { service, initializeContract } = setup();
    const expectedPath = path.join(
      __dirname,
      '..',
      'contract',
      'ProfileRegistryACI.json',
    );

    jest
      .spyOn(fs, 'existsSync')
      .mockImplementation(
        (candidatePath: fs.PathLike) => String(candidatePath) === expectedPath,
      );
    jest.spyOn(fs, 'readFileSync').mockReturnValue('{}' as any);

    await (service as any).getContractInstance();

    expect(fs.readFileSync).toHaveBeenCalledWith(expectedPath, 'utf-8');
    expect(initializeContract).toHaveBeenCalledTimes(1);
  });

  it('falls back to dist/profile path when dist/src path is missing', async () => {
    const { service } = setup();
    const fallbackPath = path.join(
      process.cwd(),
      'dist',
      'profile',
      'contract',
      'ProfileRegistryACI.json',
    );

    jest
      .spyOn(fs, 'existsSync')
      .mockImplementation(
        (candidatePath: fs.PathLike) => String(candidatePath) === fallbackPath,
      );
    jest.spyOn(fs, 'readFileSync').mockReturnValue('{}' as any);

    await (service as any).getContractInstance();

    expect(fs.readFileSync).toHaveBeenCalledWith(fallbackPath, 'utf-8');
  });
});
