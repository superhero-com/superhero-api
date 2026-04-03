# Backend API Guide — `address-links` NestJS Module

Guide for creating a NestJS module that integrates with the AddressLink smart contract. The backend acts as the **provider owner**, builds messages for users to sign, broadcasts transactions, and keeps a local cache of links via contract event listening.

## Architecture overview

```
User (wallet)                   NestJS Backend                      Aeternity Chain
     |                               |                                    |
     |  POST /address-links/claim    |                                    |
     |  { address, provider, value } |                                    |
     |  ---------------------------> |                                    |
     |                               |  contract.get_nonce(address)       |
     |                               |  --------------------------------> |
     |                               |  <------ nonce (e.g. 3) --------- |
     |  <--- { message, nonce } ---- |                                    |
     |                               |                                    |
     |  (user signs message           |                                    |
     |   with their wallet)          |                                    |
     |                               |                                    |
     |  POST /address-links/submit   |                                    |
     |  { ..., signature }           |                                    |
     |  ---------------------------> |                                    |
     |                               |  contract.link(addr, ..., sig)     |
     |                               |  --------------------------------> |
     |                               |  <------ Link event ------------- |
     |  <--- { txHash } ------------ |                                    |
     |                               |                                    |
     |                               |  Event listener picks up Link      |
     |                               |  Updates accounts.links JSONB      |
```

---

## 1. Module structure

```
src/address-links/
├── address-links.module.ts
├── address-links.controller.ts
├── address-links.service.ts
├── contract.service.ts
├── event-listener.service.ts
└── dto/
    ├── claim-link.dto.ts
    ├── submit-link.dto.ts
    ├── claim-unlink.dto.ts
    └── submit-unlink.dto.ts
```

---

## 2. Environment variables

Add to your `.env`:

```env
# Provider wallet secret key (this backend is the provider owner)
ADDRESS_LINK_SECRET_KEY=sk_2aWi...

# Contract address
ADDRESS_LINK_CONTRACT=ct_2gK1B7YszMkjBn1EKKdWBSoXSfbFmmfJxTWzYj8poeTLkCN93H

# Contract source path (relative to project root)
ADDRESS_LINK_SOURCE=./contracts/AddressLink.aes

# Aeternity node & compiler
AE_NODE_URL=https://mainnet.aeternity.io
AE_COMPILER_URL=https://compiler.aeternity.io

# Aeternity middleware (for event listening)
AE_MDW_URL=https://mainnet.aeternity.io/mdw
```

---

## 3. Database migration

Add a `links` JSONB column to the existing `accounts` table.

```typescript
// migrations/<timestamp>-add-links-to-accounts.ts

import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLinksToAccounts<timestamp> implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE accounts
      ADD COLUMN links jsonb NOT NULL DEFAULT '{}'
    `);

    await queryRunner.query(`
      CREATE INDEX idx_accounts_links ON accounts USING gin(links)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_accounts_links`);
    await queryRunner.query(`ALTER TABLE accounts DROP COLUMN links`);
  }
}
```

### Update the Account entity

```typescript
// In your existing Account entity file

@Column({ type: 'jsonb', default: {} })
links: Record<string, string>;
// Example: { "nostr": "npub1abc...", "x": "myhandle" }
```

---

## 4. Contract service

Handles SDK initialization, message building, and transaction broadcasting.

```typescript
// src/address-links/contract.service.ts

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AeSdk,
  Node,
  MemoryAccount,
  CompilerHttp,
  Contract,
  getFileSystem,
} from '@aeternity/aepp-sdk';
import { readFileSync } from 'fs';

@Injectable()
export class ContractService implements OnModuleInit {
  private readonly logger = new Logger(ContractService.name);
  private contract: any;
  private providerAccount: MemoryAccount;

  constructor(private config: ConfigService) {}

  async onModuleInit() {
    const nodeUrl = this.config.getOrThrow('AE_NODE_URL');
    const compilerUrl = this.config.getOrThrow('AE_COMPILER_URL');
    const secretKey = this.config.getOrThrow('ADDRESS_LINK_SECRET_KEY');
    const contractAddress = this.config.getOrThrow('ADDRESS_LINK_CONTRACT');
    const contractSource = this.config.getOrThrow('ADDRESS_LINK_SOURCE');

    this.providerAccount = new MemoryAccount(secretKey);

    const node = new Node(nodeUrl);
    const compiler = new CompilerHttp(compilerUrl);

    const aeSdk = new AeSdk({
      nodes: [{ name: 'main', instance: node }],
      accounts: [this.providerAccount],
      onCompiler: compiler,
    });

    const sourceCode = readFileSync(contractSource, 'utf-8');
    const fileSystem = await getFileSystem(contractSource);

    this.contract = await Contract.initialize({
      ...aeSdk.getContext(),
      sourceCode,
      fileSystem,
      address: contractAddress,
    });

    this.logger.log(`Contract initialized at ${contractAddress}`);
  }

  async getNonce(address: string): Promise<number> {
    const { decodedResult } = await this.contract.get_nonce(address);
    return Number(decodedResult);
  }

  buildLinkMessage(
    address: string,
    provider: string,
    value: string,
    nonce: number,
  ): string {
    return `link:${address}:${provider}:${value}:${nonce}`;
  }

  buildUnlinkMessage(
    address: string,
    provider: string,
    nonce: number,
  ): string {
    return `unlink:${address}:${provider}:${nonce}`;
  }

  async link(
    address: string,
    provider: string,
    value: string,
    nonce: number,
    signature: string,
  ) {
    const sigBuffer = Buffer.from(signature, 'hex');

    const tx = await this.contract.link(
      address,
      provider,
      value,
      nonce,
      sigBuffer,
      { onAccount: this.providerAccount },
    );

    this.logger.log(`Link tx: ${tx.hash}`);
    return tx;
  }

  async unlink(
    address: string,
    provider: string,
    nonce: number,
    signature: string,
  ) {
    const sigBuffer = Buffer.from(signature, 'hex');

    const tx = await this.contract.unlink(
      address,
      provider,
      nonce,
      sigBuffer,
      { onAccount: this.providerAccount },
    );

    this.logger.log(`Unlink tx: ${tx.hash}`);
    return tx;
  }

  async getLinks(address: string): Promise<Record<string, string>> {
    const { decodedResult } = await this.contract.get_links(address);
    const links: Record<string, string> = {};
    if (decodedResult instanceof Map) {
      decodedResult.forEach((value: string, key: string) => {
        links[key] = value;
      });
    }
    return links;
  }
}
```

---

## 5. Event listener service

Polls the Aeternity middleware for contract events and updates the local `accounts.links` column.

```typescript
// src/address-links/event-listener.service.ts

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Account } from '../accounts/account.entity';

@Injectable()
export class EventListenerService implements OnModuleInit {
  private readonly logger = new Logger(EventListenerService.name);
  private mdwUrl: string;
  private contractAddress: string;
  private lastProcessedTxIndex: string | null = null;

  constructor(
    private config: ConfigService,
    @InjectRepository(Account)
    private accountRepo: Repository<Account>,
  ) {}

  onModuleInit() {
    this.mdwUrl = this.config.getOrThrow('AE_MDW_URL');
    this.contractAddress = this.config.getOrThrow('ADDRESS_LINK_CONTRACT');
    this.logger.log('Event listener initialized');
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async pollEvents() {
    try {
      await this.fetchAndProcessEvents();
    } catch (error) {
      this.logger.error('Event polling failed', error.message);
    }
  }

  private async fetchAndProcessEvents() {
    // Fetch contract logs from middleware
    // GET /v3/contracts/logs?contract_id=ct_...&direction=forward&limit=100
    let url = `${this.mdwUrl}/v3/contracts/logs?contract_id=${this.contractAddress}&direction=forward&limit=100`;

    if (this.lastProcessedTxIndex) {
      url += `&cursor=${this.lastProcessedTxIndex}`;
    }

    const response = await fetch(url);
    if (!response.ok) return;

    const data = await response.json();
    const logs = data.data ?? [];

    for (const log of logs) {
      await this.processLog(log);
    }

    if (data.next) {
      this.lastProcessedTxIndex = data.next;
    }
  }

  private async processLog(log: any) {
    // Contract events are ABI-encoded in the log
    // The event name is determined by the topic hash
    // Link and Unlink events carry: (address, "provider:value")

    const eventName = log.event_name;
    const address = log.args?.[0]; // ak_... address
    const payload = log.args?.[1]; // "provider:value" string

    if (!address || !payload) return;

    if (eventName === 'Link') {
      await this.handleLinkEvent(address, payload);
    } else if (eventName === 'Unlink') {
      await this.handleUnlinkEvent(address, payload);
    }
  }

  private async handleLinkEvent(address: string, payload: string) {
    const colonIdx = payload.indexOf(':');
    if (colonIdx === -1) return;

    const provider = payload.substring(0, colonIdx);
    const value = payload.substring(colonIdx + 1);

    this.logger.log(`Link: ${address} -> ${provider}:${value}`);

    await this.accountRepo
      .createQueryBuilder()
      .update(Account)
      .set({
        links: () =>
          `jsonb_set(COALESCE(links, '{}'), '{${provider}}', '"${value}"')`,
      })
      .where('address = :address', { address })
      .execute();
  }

  private async handleUnlinkEvent(address: string, payload: string) {
    const colonIdx = payload.indexOf(':');
    if (colonIdx === -1) return;

    const provider = payload.substring(0, colonIdx);

    this.logger.log(`Unlink: ${address} -> ${provider}`);

    await this.accountRepo
      .createQueryBuilder()
      .update(Account)
      .set({
        links: () => `links - '${provider}'`,
      })
      .where('address = :address', { address })
      .execute();
  }
}
```

> **Important**: The `jsonb_set` and `- 'key'` operators are PostgreSQL-specific. The provider name is safe for interpolation because the contract enforces `a-z` only (no SQL injection risk). If you want extra safety, use parameterized queries with `jsonb_set(links, :path, :value)`.

---

## 6. DTOs

```typescript
// src/address-links/dto/claim-link.dto.ts

import { IsString, IsNotEmpty, Matches, MaxLength } from 'class-validator';

export class ClaimLinkDto {
  @IsString()
  @IsNotEmpty()
  address: string; // ak_...

  @IsString()
  @Matches(/^[a-z]+$/)
  @MaxLength(10)
  provider: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  value: string;
}
```

```typescript
// src/address-links/dto/submit-link.dto.ts

import {
  IsString,
  IsNotEmpty,
  IsNumber,
  Matches,
  MaxLength,
} from 'class-validator';

export class SubmitLinkDto {
  @IsString()
  @IsNotEmpty()
  address: string;

  @IsString()
  @Matches(/^[a-z]+$/)
  @MaxLength(10)
  provider: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  value: string;

  @IsNumber()
  nonce: number;

  @IsString()
  @IsNotEmpty()
  signature: string; // hex-encoded
}
```

```typescript
// src/address-links/dto/claim-unlink.dto.ts

import { IsString, IsNotEmpty, Matches, MaxLength } from 'class-validator';

export class ClaimUnlinkDto {
  @IsString()
  @IsNotEmpty()
  address: string;

  @IsString()
  @Matches(/^[a-z]+$/)
  @MaxLength(10)
  provider: string;
}
```

```typescript
// src/address-links/dto/submit-unlink.dto.ts

import { IsString, IsNotEmpty, IsNumber, Matches, MaxLength } from 'class-validator';

export class SubmitUnlinkDto {
  @IsString()
  @IsNotEmpty()
  address: string;

  @IsString()
  @Matches(/^[a-z]+$/)
  @MaxLength(10)
  provider: string;

  @IsNumber()
  nonce: number;

  @IsString()
  @IsNotEmpty()
  signature: string;
}
```

---

## 7. Service

```typescript
// src/address-links/address-links.service.ts

import {
  Injectable,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ContractService } from './contract.service';

@Injectable()
export class AddressLinksService {
  private readonly logger = new Logger(AddressLinksService.name);

  constructor(private contractService: ContractService) {}

  async claimLink(address: string, provider: string, value: string) {
    this.validateValue(value);

    const nonce = await this.contractService.getNonce(address);
    const message = this.contractService.buildLinkMessage(
      address,
      provider,
      value,
      nonce,
    );

    return { message, nonce };
  }

  async submitLink(
    address: string,
    provider: string,
    value: string,
    nonce: number,
    signature: string,
  ) {
    this.validateValue(value);

    const tx = await this.contractService.link(
      address,
      provider,
      value,
      nonce,
      signature,
    );

    return { txHash: tx.hash };
  }

  async claimUnlink(address: string, provider: string) {
    const nonce = await this.contractService.getNonce(address);
    const message = this.contractService.buildUnlinkMessage(
      address,
      provider,
      nonce,
    );

    return { message, nonce };
  }

  async submitUnlink(
    address: string,
    provider: string,
    nonce: number,
    signature: string,
  ) {
    const tx = await this.contractService.unlink(
      address,
      provider,
      nonce,
      signature,
    );

    return { txHash: tx.hash };
  }

  private validateValue(value: string) {
    if (value.includes(':')) {
      throw new BadRequestException('Value must not contain ":"');
    }
  }
}
```

---

## 8. Controller

```typescript
// src/address-links/address-links.controller.ts

import { Controller, Post, Body } from '@nestjs/common';
import { AddressLinksService } from './address-links.service';
import { ClaimLinkDto } from './dto/claim-link.dto';
import { SubmitLinkDto } from './dto/submit-link.dto';
import { ClaimUnlinkDto } from './dto/claim-unlink.dto';
import { SubmitUnlinkDto } from './dto/submit-unlink.dto';

@Controller('address-links')
export class AddressLinksController {
  constructor(private readonly service: AddressLinksService) {}

  /**
   * Step 1: User requests to link. Backend returns the message to sign.
   *
   * POST /address-links/claim
   * Body: { address: "ak_...", provider: "nostr", value: "npub1abc..." }
   * Response: { message: "link:ak_...:nostr:npub1abc...:3", nonce: 3 }
   */
  @Post('claim')
  async claimLink(@Body() dto: ClaimLinkDto) {
    return this.service.claimLink(dto.address, dto.provider, dto.value);
  }

  /**
   * Step 2: User submits the signed message. Backend broadcasts to chain.
   *
   * POST /address-links/submit
   * Body: { address, provider, value, nonce, signature }
   * Response: { txHash: "th_..." }
   */
  @Post('submit')
  async submitLink(@Body() dto: SubmitLinkDto) {
    return this.service.submitLink(
      dto.address,
      dto.provider,
      dto.value,
      dto.nonce,
      dto.signature,
    );
  }

  /**
   * Step 1: User requests to unlink. Backend returns the message to sign.
   *
   * POST /address-links/unclaim
   * Body: { address: "ak_...", provider: "nostr" }
   * Response: { message: "unlink:ak_...:nostr:4", nonce: 4 }
   */
  @Post('unclaim')
  async claimUnlink(@Body() dto: ClaimUnlinkDto) {
    return this.service.claimUnlink(dto.address, dto.provider);
  }

  /**
   * Step 2: User submits the signed unlink message. Backend broadcasts.
   *
   * POST /address-links/unclaim/submit
   * Body: { address, provider, nonce, signature }
   * Response: { txHash: "th_..." }
   */
  @Post('unclaim/submit')
  async submitUnlink(@Body() dto: SubmitUnlinkDto) {
    return this.service.submitUnlink(
      dto.address,
      dto.provider,
      dto.nonce,
      dto.signature,
    );
  }
}
```

---

## 9. Module

```typescript
// src/address-links/address-links.module.ts

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { Account } from '../accounts/account.entity';
import { AddressLinksController } from './address-links.controller';
import { AddressLinksService } from './address-links.service';
import { ContractService } from './contract.service';
import { EventListenerService } from './event-listener.service';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([Account]),
  ],
  controllers: [AddressLinksController],
  providers: [AddressLinksService, ContractService, EventListenerService],
  exports: [ContractService],
})
export class AddressLinksModule {}
```

Register in `app.module.ts`:

```typescript
import { AddressLinksModule } from './address-links/address-links.module';

@Module({
  imports: [
    // ... existing modules
    AddressLinksModule,
  ],
})
export class AppModule {}
```

---

## 10. API reference

### `POST /address-links/claim`

Returns a message for the user to sign in order to link their address to an external identity.

**Request:**

```json
{
  "address": "ak_2QkttUgEyPixKzqXkJ4LX7ugbRjwCDeh5qQ8YgqdMRtEzsuYiY",
  "provider": "nostr",
  "value": "npub1xyzabc..."
}
```

**Response:**

```json
{
  "message": "link:ak_2QkttUgEyPixKzqXkJ4LX7ugbRjwCDeh5qQ8YgqdMRtEzsuYiY:nostr:npub1xyzabc...:0",
  "nonce": 0
}
```

**Errors:**

| Status | Reason |
|---|---|
| 400 | Invalid provider format (must be `a-z`, max 10) |
| 400 | Value contains `:` or exceeds 200 chars |

---

### `POST /address-links/submit`

Broadcasts the signed link transaction to the chain.

**Request:**

```json
{
  "address": "ak_2QkttUgEyPixKzqXkJ4LX7ugbRjwCDeh5qQ8YgqdMRtEzsuYiY",
  "provider": "nostr",
  "value": "npub1xyzabc...",
  "nonce": 0,
  "signature": "ab12cd34...hex..."
}
```

**Response:**

```json
{
  "txHash": "th_2abc..."
}
```

**Errors:**

| Status | Reason |
|---|---|
| 400 | Validation error (missing fields, bad format) |
| 500 | Contract error (INVALID_NONCE, INVALID_SIGNATURE, ALREADY_CLAIMED, etc.) |

---

### `POST /address-links/unclaim`

Returns a message for the user to sign in order to unlink.

**Request:**

```json
{
  "address": "ak_2QkttUgEyPixKzqXkJ4LX7ugbRjwCDeh5qQ8YgqdMRtEzsuYiY",
  "provider": "nostr"
}
```

**Response:**

```json
{
  "message": "unlink:ak_2QkttUgEyPixKzqXkJ4LX7ugbRjwCDeh5qQ8YgqdMRtEzsuYiY:nostr:1",
  "nonce": 1
}
```

---

### `POST /address-links/unclaim/submit`

Broadcasts the signed unlink transaction to the chain.

**Request:**

```json
{
  "address": "ak_2QkttUgEyPixKzqXkJ4LX7ugbRjwCDeh5qQ8YgqdMRtEzsuYiY",
  "provider": "nostr",
  "nonce": 1,
  "signature": "ab12cd34...hex..."
}
```

**Response:**

```json
{
  "txHash": "th_2abc..."
}
```

---

## 11. Accounts `links` column shape

The `links` JSONB column stores a flat key-value map where keys are provider names and values are the linked identities:

```json
{
  "nostr": "npub1xyzabc...",
  "x": "superherocom"
}
```

After unlinking `nostr`:

```json
{
  "x": "superherocom"
}
```

Query examples:

```sql
-- Find all accounts linked to nostr
SELECT * FROM accounts WHERE links ? 'nostr';

-- Find who owns a specific nostr pubkey
SELECT * FROM accounts WHERE links->>'nostr' = 'npub1xyzabc...';

-- Find accounts with any links
SELECT * FROM accounts WHERE links != '{}';
```

---

## 12. Frontend signing reference

The user must sign the message returned by `/claim` or `/unclaim` using the Aeternity signed-message format. Here's the browser-side code:

```typescript
import { hash } from '@aeternity/aepp-sdk';

const MESSAGE_PREFIX = new Uint8Array([
  0x1a, 0x61, 0x65, 0x74, 0x65, 0x72, 0x6e, 0x69, 0x74, 0x79,
  0x20, 0x53, 0x69, 0x67, 0x6e, 0x65, 0x64, 0x20, 0x4d, 0x65,
  0x73, 0x73, 0x61, 0x67, 0x65, 0x3a, 0x0a, 0x20,
]);

async function signMessage(account, message: string): Promise<string> {
  const msgHash = hash(message);
  const digest = new Uint8Array(MESSAGE_PREFIX.length + msgHash.length);
  digest.set(MESSAGE_PREFIX);
  digest.set(msgHash, MESSAGE_PREFIX.length);
  const sig = await account.unsafeSign(digest);
  return Buffer.from(sig).toString('hex');
}
```

### Full frontend flow

```typescript
// 1. Request the message to sign
const claimRes = await fetch('/address-links/claim', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    address: userAccount.address,
    provider: 'nostr',
    value: 'npub1xyzabc...',
  }),
});
const { message, nonce } = await claimRes.json();

// 2. User signs the message
const signature = await signMessage(userAccount, message);

// 3. Submit the signed message
const submitRes = await fetch('/address-links/submit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    address: userAccount.address,
    provider: 'nostr',
    value: 'npub1xyzabc...',
    nonce,
    signature,
  }),
});
const { txHash } = await submitRes.json();
```

---

## 13. Contract event format

Events emitted by the contract:

| Event | Args | Format |
|---|---|---|
| `Link` | `(address, string)` | `("ak_...", "provider:value")` |
| `Unlink` | `(address, string)` | `("ak_...", "provider:value")` |
| `ProviderRegistered` | `(address, string)` | `("ak_...", "provider")` |

To parse `Link`/`Unlink` payloads, split on the **first** `:`:

```typescript
const colonIdx = payload.indexOf(':');
const provider = payload.substring(0, colonIdx);
const value = payload.substring(colonIdx + 1);
```

---

## 14. Dependencies

```bash
npm install @aeternity/aepp-sdk @nestjs/schedule
```

Ensure `@nestjs/config`, `@nestjs/typeorm`, and `class-validator` are already installed in the NestJS project.

---

## 15. Input constraints

| Field | Type | Max length | Allowed characters |
|---|---|---|---|
| `address` | string | — | Must be valid `ak_...` |
| `provider` | string | 10 | Lowercase `a-z` only |
| `value` | string | 200 | Any except `:` |
| `nonce` | number | — | Sequential integer per address |
| `signature` | string | — | Hex-encoded 64-byte Ed25519 signature |
