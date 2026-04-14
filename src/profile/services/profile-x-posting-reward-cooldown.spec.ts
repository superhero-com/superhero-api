jest.mock('../profile.constants', () => ({
  PROFILE_X_POSTING_REWARD_AMOUNT_AE: '0.05',
  PROFILE_X_POSTING_REWARD_ENABLED: true,
  PROFILE_X_POSTING_REWARD_ENABLE_POST_FETCH: false,
  PROFILE_X_POSTING_REWARD_ENABLE_PERIODIC_RECHECKS: false,
  PROFILE_X_POSTING_REWARD_FETCH_TIMEOUT_MS: 5000,
  PROFILE_X_POSTING_REWARD_KEYWORDS: ['superhero.com'],
  PROFILE_X_POSTING_REWARD_MANUAL_RECHECK_COOLDOWN_SECONDS: 3600,
  PROFILE_X_POSTING_REWARD_RETRY_BASE_SECONDS: 1,
  PROFILE_X_POSTING_REWARD_RETRY_MAX_SECONDS: 60,
  PROFILE_X_POSTING_REWARD_SCAN_INTERVAL_SECONDS: 300,
  PROFILE_X_POSTING_REWARD_THRESHOLD: 10,
  PROFILE_X_VERIFICATION_REWARD_PRIVATE_KEY: '1'.repeat(64),
}));

import { ProfileXPostingRewardService } from './profile-x-posting-reward.service';

describe('ProfileXPostingRewardService – cooldown map pruning', () => {
  let service: ProfileXPostingRewardService;
  let cooldownMap: Map<string, number>;

  beforeEach(() => {
    service = Object.create(ProfileXPostingRewardService.prototype);
    cooldownMap = new Map();
    (service as any).manualRecheckBlockedUntilByAddress = cooldownMap;
  });

  it('does not prune when map is at or below MAX_COOLDOWN_MAP_SIZE', () => {
    const maxSize = (ProfileXPostingRewardService as any).MAX_COOLDOWN_MAP_SIZE;
    const expiredTs = Date.now() - 1000;

    for (let i = 0; i < maxSize; i++) {
      cooldownMap.set(`ak_addr_${i}`, expiredTs);
    }

    (service as any).pruneExpiredCooldowns();
    expect(cooldownMap.size).toBe(maxSize);
  });

  it('removes expired entries when map exceeds MAX_COOLDOWN_MAP_SIZE', () => {
    const maxSize = (ProfileXPostingRewardService as any).MAX_COOLDOWN_MAP_SIZE;
    const now = Date.now();

    for (let i = 0; i < maxSize; i++) {
      cooldownMap.set(`ak_expired_${i}`, now - 1000);
    }
    cooldownMap.set('ak_still_active', now + 60_000);
    cooldownMap.set('ak_trigger', now + 60_000);

    expect(cooldownMap.size).toBe(maxSize + 2);

    (service as any).pruneExpiredCooldowns();

    expect(cooldownMap.size).toBe(2);
    expect(cooldownMap.has('ak_still_active')).toBe(true);
    expect(cooldownMap.has('ak_trigger')).toBe(true);
  });

  it('keeps all entries when none are expired even if above limit', () => {
    const maxSize = (ProfileXPostingRewardService as any).MAX_COOLDOWN_MAP_SIZE;
    const futureTs = Date.now() + 3_600_000;

    for (let i = 0; i < maxSize + 5; i++) {
      cooldownMap.set(`ak_addr_${i}`, futureTs);
    }

    (service as any).pruneExpiredCooldowns();
    expect(cooldownMap.size).toBe(maxSize + 5);
  });
});
