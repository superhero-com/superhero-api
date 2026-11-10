import { ServiceUnavailableException } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Test } from '@nestjs/testing';
import { ProfileMediaAuth } from './profile-media-auth.service';
import {
  PROFILE_MEDIA_CONFIG,
  profileMediaConfig,
} from './profile-media.config';
import { ProfileMediaGate } from './profile-media.controller';

describe('ProfileMediaGate', () => {
  afterEach(() => jest.restoreAllMocks());

  it('starts with the standard proxy hop count when profile media is disabled', async () => {
    jest.replaceProperty(process, 'env', { TRUST_PROXY: '1' });
    const rate = jest.fn();
    const module = await Test.createTestingModule({
      providers: [
        ProfileMediaGate,
        { provide: PROFILE_MEDIA_CONFIG, useFactory: profileMediaConfig },
        { provide: ProfileMediaAuth, useValue: { rate } },
      ],
    }).compile();
    try {
      const gate = module.get(ProfileMediaGate);
      await expect(
        gate.canActivate(new ExecutionContextHost([])),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(rate).not.toHaveBeenCalled();
    } finally {
      await module.close();
    }
  });
});
