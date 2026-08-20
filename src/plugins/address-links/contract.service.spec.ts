import {
  BadRequestException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AeSdkService } from '@/ae/ae-sdk.service';
import { AddressLinksContractService } from './contract.service';

describe('AddressLinksContractService.mapContractError', () => {
  const service = new AddressLinksContractService(
    {} as unknown as AeSdkService,
  );
  // mapContractError is private; exercise it directly.
  const map = (message: string) =>
    (service as any).mapContractError(new Error(message), 'link') as Error;

  beforeAll(() => {
    // Silence expected warn/error logging from the mapper under test.
    const logger = (service as any).logger;
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  const CLIENT_CODES = [
    'INVALID_SIGNATURE',
    'INVALID_NONCE',
    'ALREADY_CLAIMED',
    'NO_LINKS',
    'LINK_NOT_FOUND',
    'EMPTY_VALUE',
    'VALUE_TOO_LONG',
    'INVALID_VALUE',
    'EMPTY_PRINCIPAL',
    'PRINCIPAL_TOO_LONG',
    'PRINCIPAL_NOT_FOUND',
    'PRINCIPAL_MISMATCH',
    'INVALID_PRINCIPAL',
    'INVALID_DID',
    'MESSAGE_TOO_LONG',
    'EMPTY_PROVIDER',
    'PROVIDER_TOO_LONG',
    'INVALID_PROVIDER',
    'PROVIDER_EXISTS',
  ];

  const WIRING_CODES = ['PROVIDER_NOT_FOUND', 'NOT_PROVIDER_OWNER'];

  it.each(CLIENT_CODES)('maps %s to a 400', (code) => {
    const result = map(`Invocation failed: "${code}"`);
    expect(result).toBeInstanceOf(BadRequestException);
    expect((result as BadRequestException).getStatus()).toBe(400);
  });

  it.each(WIRING_CODES)('maps %s to a 503', (code) => {
    const result = map(`Invocation failed: "${code}"`);
    expect(result).toBeInstanceOf(ServiceUnavailableException);
    expect((result as ServiceUnavailableException).getStatus()).toBe(503);
  });

  it('maps an unknown revert to a generic 500 that does not leak the raw error', () => {
    const leaky = 'ECONNREFUSED https://node.internal:3013 tx_backend_wallet';
    const result = map(leaky);
    expect(result).toBeInstanceOf(InternalServerErrorException);
    expect((result as InternalServerErrorException).getStatus()).toBe(500);
    expect(result.message).not.toContain('node.internal');
    expect(result.message).not.toContain('tx_backend_wallet');
  });

  it('treats the phantom NOT_LINKED code as unmapped (500, not 400)', () => {
    const result = map('Invocation failed: "NOT_LINKED"');
    expect(result).toBeInstanceOf(InternalServerErrorException);
  });
});
