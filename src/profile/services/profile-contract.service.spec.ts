import fs from 'fs';
import path from 'path';
import { ProfileContractService } from './profile-contract.service';

describe('ProfileContractService', () => {
  const setup = () => {
    const initializeContract = jest.fn().mockResolvedValue({
      get_profile: jest.fn().mockResolvedValue({ decodedResult: null }),
    });
    const aeSdkService = {
      sdk: {
        initializeContract,
      },
    } as any;

    const service = new ProfileContractService(aeSdkService);
    return { service, initializeContract };
  };

  afterEach(() => {
    jest.restoreAllMocks();
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
