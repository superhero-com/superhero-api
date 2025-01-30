import { Test, TestingModule } from '@nestjs/testing';
import { AeSdk, CompilerHttp } from '@aeternity/aepp-sdk';
import { AeSdkService } from './ae-sdk.service';
import { ACTIVE_NETWORK, nodes } from '../configs';

// Mock the AeSdk class
jest.mock('@aeternity/aepp-sdk', () => {
  const actualAeppSdk = jest.requireActual('@aeternity/aepp-sdk');
  return {
    AeSdk: jest.fn().mockImplementation(() => ({
      selectNode: jest.fn(),
    })),
    CompilerHttp: jest
      .fn()
      .mockImplementation((url) => new actualAeppSdk.CompilerHttp(url)), // Ensures a real instance is returned
    Node: jest.fn().mockImplementation(() => ({})),
  };
});

describe('AeSdkService', () => {
  let service: AeSdkService;
  let mockAeSdk: jest.Mocked<AeSdk>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AeSdkService],
    }).compile();

    service = module.get<AeSdkService>(AeSdkService);
    mockAeSdk = service.sdk as jest.Mocked<AeSdk>;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should initialize AeSdk with correct parameters', () => {
    // Verify that AeSdk was initialized with the correct parameters
    expect(AeSdk).toHaveBeenCalledWith({
      onCompiler: expect.any(Object),
      nodes,
    });

    // Verify that CompilerHttp was initialized with the correct URL
    expect(CompilerHttp).toHaveBeenCalledWith('https://v7.compiler.aepps.com');
  });

  it('should select the correct node on initialization', () => {
    // Verify that selectNode was called with the correct network name
    expect(mockAeSdk.selectNode).toHaveBeenCalledWith(ACTIVE_NETWORK.name);
  });
});
