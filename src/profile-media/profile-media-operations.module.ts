import { Injectable, Module, Optional } from '@nestjs/common';
import { AccountMemory } from '@aeternity/aepp-sdk';
import { open, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { ProfileMediaChain } from './profile-media-chain.service';
import aci from '../plugins/address-links/aci/AddressLink.aci.json';
import { privateBucketConfig } from '../shorts/shorts-private-objects.service';
import {
  PROFILE_MEDIA_CONFIG,
  profileMediaConfig,
  profileMediaSecret,
} from './profile-media.config';

@Injectable()
export class ProfileMediaOperations {
  constructor(@Optional() private readonly chain?: ProfileMediaChain) {}
  async cleanupPolicy() {
    const config = profileMediaConfig();
    if (!config.enabled) throw new Error('Profile media must be configured');
    const bucket = await privateBucketConfig();
    const namespace = createHash('sha256')
      .update(
        JSON.stringify([
          config.network,
          config.storageContract || config.contract,
        ]),
      )
      .digest('hex');
    return {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
          Resource: [
            `arn:aws:s3:::${bucket.bucket}/${bucket.prefix}/${namespace}/profile-*/direct-part/*`,
          ],
        },
        {
          Effect: 'Allow',
          Action: ['s3:ListBucketVersions'],
          Resource: [`arn:aws:s3:::${bucket.bucket}`],
          Condition: {
            StringLike: {
              's3:prefix': [
                `${bucket.prefix}/${namespace}/profile-*/direct-part/*`,
              ],
            },
          },
        },
      ],
    };
  }
  async deploy() {
    if (!this.chain?.config.enabled || this.chain.config.network !== 'ae_uat')
      throw new Error('Explicit testnet profile configuration is required');
    const artifactPath = process.env.PROFILE_MEDIA_DEPLOY_ARTIFACT || '';
    const journalPath = process.env.PROFILE_MEDIA_DEPLOY_JOURNAL_FILE || '';
    if (
      ![artifactPath, journalPath].every(isAbsolute) ||
      (await stat(artifactPath)).size > 262144
    )
      throw new Error(
        'Bounded artifact and private deployment journal paths are required',
      );
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
    if (
      typeof artifact.bytecode !== 'string' ||
      !artifact.bytecode.startsWith('cb_') ||
      JSON.stringify(artifact.aci) !== JSON.stringify(aci)
    )
      throw new Error(
        'Deployment artifact must match the supported AddressLink ACI',
      );
    const identity = {
      network: this.chain.config.network,
      provider: this.chain.providerAddress,
      bytecodeSha256: createHash('sha256')
        .update(artifact.bytecode)
        .digest('hex'),
    };
    let record: any;
    try {
      record = JSON.parse(await readFile(journalPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (record) {
      if (
        Object.entries(identity).some(([key, value]) => record[key] !== value)
      )
        throw new Error(
          'Deployment journal belongs to a different artifact or account',
        );
      await this.chain.rebroadcast(record.signedTx).catch(() => {});
    } else {
      await this.chain.deploy(artifact.bytecode, async (transaction) => {
        record = { ...identity, ...transaction };
        const file = await open(journalPath, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify(record));
          await file.sync();
        } finally {
          await file.close();
        }
      });
    }
    return { ...identity, address: record.address, txHash: record.txHash };
  }
  async key() {
    const path = process.env.PROFILE_MEDIA_PROVIDER_KEY_FILE || '';
    if (!isAbsolute(path))
      throw new Error('An absolute provider credential path is required');
    let account: AccountMemory;
    try {
      account = new AccountMemory(
        (await profileMediaSecret(path)) as `sk_${string}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Existing provider credential could not be read');
      account = AccountMemory.generate();
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(account.secretKey);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    return { provider: account.address };
  }
  async providers(register: boolean) {
    if (!this.chain?.config.enabled)
      throw new Error('Profile media must be explicitly configured');
    const providers = register
      ? await this.chain.ensureProviders(true)
      : await this.chain.providers();
    return {
      network: this.chain.config.network,
      contract: this.chain.config.contract,
      provider: this.chain.providerAddress,
      providers,
    };
  }
}

@Module({ providers: [ProfileMediaOperations] })
export class ProfileMediaKeyModule {}

@Module({
  providers: [
    ProfileMediaOperations,
    ProfileMediaChain,
    {
      provide: PROFILE_MEDIA_CONFIG,
      useFactory: () => profileMediaConfig(),
    },
  ],
})
export class ProfileMediaOperationsModule {}
