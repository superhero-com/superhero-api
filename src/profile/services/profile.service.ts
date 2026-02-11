import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
  HttpException,
  HttpStatus,
  RequestTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { verifyMessage } from '@aeternity/aepp-sdk';
import { Repository } from 'typeorm';
import { AccountService } from '@/account/services/account.service';
import { OAuthService } from '@/affiliation/services/oauth.service';
import { Profile } from '../entities/profile.entity';
import { ProfileUpdateChallenge } from '../entities/profile-update-challenge.entity';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { ConsumeProfileChallengeDto } from '../dto/consume-profile-challenge.dto';

type ProfileWritableKey =
  | 'fullname'
  | 'bio'
  | 'nostrkey'
  | 'avatarurl'
  | 'username'
  | 'x_username'
  | 'chain_name'
  | 'sol_name';

const CHALLENGE_ACTION = 'update_profile';
const PROFILE_KEYS: ProfileWritableKey[] = [
  'fullname',
  'bio',
  'nostrkey',
  'avatarurl',
  'username',
  'x_username',
  'chain_name',
  'sol_name',
];

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

@Injectable()
export class ProfileService {
  private readonly challengeTtlMs =
    (parseInt(process.env.PROFILE_CHALLENGE_TTL_SECONDS || '300', 10) || 300) *
    1000;
  private readonly rateWindowMs = 60 * 1000;
  private readonly issueRateLimit = new Map<string, RateLimitEntry>();
  private readonly consumeRateLimit = new Map<string, RateLimitEntry>();

  constructor(
    @InjectRepository(Profile)
    private readonly profileRepository: Repository<Profile>,
    @InjectRepository(ProfileUpdateChallenge)
    private readonly challengeRepository: Repository<ProfileUpdateChallenge>,
    private readonly accountService: AccountService,
    private readonly oauthService: OAuthService,
  ) {}

  private readonly getProfileTimeoutMs = 15_000;

  async getProfile(address: string): Promise<Profile> {
    const findPromise = this.profileRepository.findOne({
      where: { address },
    });
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new RequestTimeoutException('Profile fetch timeout')),
        this.getProfileTimeoutMs,
      );
    });
    try {
      const profile = await Promise.race([findPromise, timeoutPromise]);
      if (!profile) {
        throw new NotFoundException('Profile not found');
      }
      return profile;
    } finally {
      clearTimeout(timeoutId!);
    }
  }

  async getOwnedChainNames(address: string): Promise<string[]> {
    const names = await this.accountService.getOwnedChainNames(address);
    if (names === undefined) {
      throw new ServiceUnavailableException(
        'Unable to verify chain names; try again later',
      );
    }
    return names;
  }

  async verifyXUsername(address: string, accessCode: string): Promise<Profile> {
    const profile = await this.profileRepository.findOne({
      where: { address },
    });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    if (!profile.x_username) {
      throw new BadRequestException(
        'x_username must be set before verification',
      );
    }

    const userInfo = await this.oauthService.verifyAccessToken('x', accessCode);
    if (!userInfo.username) {
      throw new BadRequestException(
        'Could not resolve username from X OAuth response',
      );
    }

    const profileUsername = profile.x_username.toLowerCase();
    const oauthUsername = userInfo.username.toLowerCase();
    if (profileUsername !== oauthUsername) {
      throw new BadRequestException(
        'x_username does not match authenticated X account',
      );
    }

    const now = new Date();
    await this.profileRepository.update(address, {
      x_verified: true,
      x_verified_at: now,
      x_username: userInfo.username,
    });

    return (await this.profileRepository.findOne({ where: { address } }))!;
  }

  async issueUpdateChallenge(
    address: string,
    payload: UpdateProfileDto,
    ip?: string,
    userAgent?: string,
  ) {
    this.enforceRateLimit(
      this.issueRateLimit,
      `issue:${address}:${ip || 'unknown'}`,
      10,
    );

    const existingProfile = await this.profileRepository.findOne({
      where: { address },
    });
    const normalizedPayload = this.extractProfilePayload(payload);
    this.applyXVerificationReset(existingProfile, normalizedPayload);
    if (Object.keys(normalizedPayload).length === 0) {
      throw new BadRequestException(
        'At least one profile field must be provided',
      );
    }
    await this.assertUsernameAvailable(address, normalizedPayload.username);
    await this.assertOwnedChainName(address, normalizedPayload.chain_name);

    const payloadHash = this.createPayloadHash(address, normalizedPayload);
    const now = Date.now();
    const challenge = `${randomUUID()}-${payloadHash.slice(0, 16)}-${CHALLENGE_ACTION}-${now}-v1`;
    const expiresAt = new Date(now + this.challengeTtlMs);

    await this.challengeRepository.save({
      challenge,
      address,
      action: CHALLENGE_ACTION,
      payload_hash: payloadHash,
      expires_at: expiresAt,
      consumed_at: null,
      request_ip: ip || null,
      user_agent: userAgent || null,
    });

    return {
      challenge,
      payload_hash: payloadHash,
      expires_at: expiresAt,
      ttl_seconds: Math.floor(this.challengeTtlMs / 1000),
    };
  }

  async updateProfileWithChallenge(
    address: string,
    payload: ConsumeProfileChallengeDto,
    ip?: string,
  ) {
    this.enforceRateLimit(
      this.consumeRateLimit,
      `consume:${address}:${ip || 'unknown'}`,
      20,
    );

    const existingProfile = await this.profileRepository.findOne({
      where: { address },
    });
    const normalizedPayload = this.extractProfilePayload(payload);
    this.applyXVerificationReset(existingProfile, normalizedPayload);
    if (Object.keys(normalizedPayload).length === 0) {
      throw new BadRequestException(
        'At least one profile field must be provided',
      );
    }
    await this.assertUsernameAvailable(address, normalizedPayload.username);
    await this.assertOwnedChainName(address, normalizedPayload.chain_name);

    const payloadHash = this.createPayloadHash(address, normalizedPayload);
    const challengeEntry = await this.challengeRepository.findOne({
      where: {
        challenge: payload.challenge,
        address,
        action: CHALLENGE_ACTION,
      },
    });

    if (!challengeEntry) {
      throw new UnauthorizedException('Challenge not found');
    }

    if (challengeEntry.consumed_at) {
      throw new UnauthorizedException('Challenge already consumed');
    }

    if (challengeEntry.expires_at.getTime() <= Date.now()) {
      throw new UnauthorizedException('Challenge expired');
    }

    if (challengeEntry.payload_hash !== payloadHash) {
      throw new UnauthorizedException('Challenge payload mismatch');
    }

    if (
      !this.verifyChallengeSignature(
        challengeEntry.challenge,
        payload.signature,
        address,
      )
    ) {
      throw new UnauthorizedException('Invalid signature');
    }

    const consumeResult = await this.challengeRepository
      .createQueryBuilder()
      .update(ProfileUpdateChallenge)
      .set({ consumed_at: () => 'CURRENT_TIMESTAMP' })
      .where('id = :id', { id: challengeEntry.id })
      .andWhere('consumed_at IS NULL')
      .andWhere('expires_at > CURRENT_TIMESTAMP')
      .execute();

    if (!consumeResult.affected) {
      throw new UnauthorizedException('Challenge already used or expired');
    }

    if (!existingProfile) {
      await this.profileRepository.save({
        address,
        ...normalizedPayload,
      });
    } else {
      await this.profileRepository.update(address, normalizedPayload);
    }

    return await this.profileRepository.findOne({ where: { address } });
  }

  private verifyChallengeSignature(
    challenge: string,
    signatureHex: string,
    address: string,
  ): boolean {
    try {
      const signatureArray = Uint8Array.from(Buffer.from(signatureHex, 'hex'));
      return verifyMessage(
        challenge,
        signatureArray,
        address as `ak_${string}`,
      );
    } catch {
      return false;
    }
  }

  private extractProfilePayload(input: UpdateProfileDto): Partial<Profile> {
    const payload: Partial<Profile> = {};
    for (const key of PROFILE_KEYS) {
      const value = input[key];
      if (value === undefined || value === null) {
        continue;
      }

      const normalized = typeof value === 'string' ? value.trim() : value;
      // Omit empty strings so we never store "" (DTO should reject these; this is defense-in-depth)
      if (normalized === '') {
        continue;
      }
      // Store username in lowercase so the DB unique constraint enforces case-insensitive uniqueness
      payload[key] =
        key === 'username' && typeof normalized === 'string'
          ? normalized.toLowerCase()
          : normalized;
    }

    return payload;
  }

  private applyXVerificationReset(
    existingProfile: Profile | null,
    payload: Partial<Profile>,
  ): void {
    if (typeof payload.x_username === 'undefined') {
      return;
    }

    const previous = existingProfile?.x_username?.toLowerCase() ?? null;
    const incoming =
      typeof payload.x_username === 'string'
        ? payload.x_username.toLowerCase()
        : null;
    if (previous !== incoming) {
      payload.x_verified = false;
      payload.x_verified_at = null;
    }
  }

  private createPayloadHash(
    address: string,
    payload: Partial<Profile>,
  ): string {
    const sortedPayload = Object.keys(payload)
      .sort()
      .reduce<Record<string, string | null>>((acc, key) => {
        const value = payload[key as keyof Profile];
        acc[key] = value === null ? null : String(value);
        return acc;
      }, {});

    const canonicalObject = {
      action: CHALLENGE_ACTION,
      address,
      payload: sortedPayload,
    };
    const canonicalString = JSON.stringify(canonicalObject);

    return createHash('sha256').update(canonicalString).digest('hex');
  }

  private async assertUsernameAvailable(
    address: string,
    username?: string | null,
  ): Promise<void> {
    if (typeof username !== 'string') {
      return;
    }

    const canonical = username.toLowerCase();
    const conflict = await this.profileRepository
      .createQueryBuilder('profile')
      .where('LOWER(profile.username) = :canonical', { canonical })
      .andWhere('profile.address != :address', { address })
      .getOne();

    if (conflict) {
      throw new BadRequestException('username is already taken');
    }
  }

  private async assertOwnedChainName(
    address: string,
    chainName?: string,
  ): Promise<void> {
    if (typeof chainName === 'undefined') {
      return;
    }

    const ownedNames = await this.getOwnedChainNames(address);
    if (!ownedNames.includes(chainName)) {
      throw new BadRequestException(
        'chain_name must be one of the names currently owned by address',
      );
    }
  }

  private readonly rateLimitCleanupThreshold = 1000;

  private enforceRateLimit(
    map: Map<string, RateLimitEntry>,
    key: string,
    limit: number,
  ): void {
    const now = Date.now();

    if (map.size > this.rateLimitCleanupThreshold) {
      this.cleanupRateLimitMap(map, now);
    }

    const entry = map.get(key);

    if (!entry || now > entry.resetAt) {
      map.set(key, { count: 1, resetAt: now + this.rateWindowMs });
      return;
    }

    if (entry.count >= limit) {
      throw new HttpException(
        'Rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    entry.count += 1;
  }

  private cleanupRateLimitMap(
    map: Map<string, RateLimitEntry>,
    now: number,
  ): void {
    for (const [k, entry] of map.entries()) {
      if (now > entry.resetAt) {
        map.delete(k);
      }
    }
  }
}
