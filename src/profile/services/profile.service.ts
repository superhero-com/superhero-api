import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
  HttpException,
  HttpStatus,
  RequestTimeoutException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { verifyMessage } from '@aeternity/aepp-sdk';
import { Repository } from 'typeorm';
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
  ) {}

  private readonly getProfileTimeoutMs = 15_000;

  async getProfile(address: string): Promise<Profile> {
    const findPromise = this.profileRepository.findOne({
      where: { address },
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new RequestTimeoutException('Profile fetch timeout')),
        this.getProfileTimeoutMs,
      );
    });
    const profile = await Promise.race([findPromise, timeoutPromise]);
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    return profile;
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

    const normalizedPayload = this.extractProfilePayload(payload);
    if (Object.keys(normalizedPayload).length === 0) {
      throw new BadRequestException(
        'At least one profile field must be provided',
      );
    }

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

    const normalizedPayload = this.extractProfilePayload(payload);
    if (Object.keys(normalizedPayload).length === 0) {
      throw new BadRequestException(
        'At least one profile field must be provided',
      );
    }

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

    const existing = await this.profileRepository.findOne({
      where: { address },
    });

    if (!existing) {
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
      if (typeof value === 'undefined') {
        continue;
      }

      payload[key] = typeof value === 'string' ? value.trim() : value;
    }

    return payload;
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

  private enforceRateLimit(
    map: Map<string, RateLimitEntry>,
    key: string,
    limit: number,
  ): void {
    const now = Date.now();
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
}
