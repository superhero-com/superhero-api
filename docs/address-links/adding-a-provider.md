# Address Links -- Adding a New Provider

This guide walks through adding a new identity provider to the address-links module. Use the existing Nostr and X implementations as reference.

## What you need to create

For a provider named `foo`:

1. **DTOs** -- 4 request validation classes
2. **Verifier service** -- claim-time and submit-time verification logic
3. **Controller** -- 4 endpoints under `/address-links/foo/`
4. **Module registration** -- wire everything together

## Step 1: Create DTOs

Create `src/plugins/address-links/dto/foo/` with 4 files. Each DTO uses `class-validator` decorators.

### `claim-foo-link.dto.ts`

The claim DTO contains `address` (always required) plus any provider-specific fields needed to verify the claim. For example:
- Nostr sends `value` (the npub to link)
- X sends OAuth credentials (`x_access_token` or `x_code` + `x_code_verifier` + `x_redirect_uri`)

```typescript
import { IsString, IsNotEmpty } from 'class-validator';

export class ClaimFooLinkDto {
  @IsString()
  @IsNotEmpty()
  address: string;

  // Add provider-specific fields here
}
```

### `submit-foo-link.dto.ts`

The submit DTO always contains `address`, `value`, `nonce`, `signature`, plus any provider-specific proof fields.

```typescript
import { IsString, IsNotEmpty, IsNumber, MaxLength } from 'class-validator';

export class SubmitFooLinkDto {
  @IsString()
  @IsNotEmpty()
  address: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  value: string;

  @IsNumber()
  nonce: number;

  @IsString()
  @IsNotEmpty()
  signature: string;

  // Add provider-specific proof fields here
  // e.g. a signed event, a verification token, an API response, etc.
}
```

### `unclaim-foo-link.dto.ts`

Just `address`. Unlinking doesn't need provider-specific data.

```typescript
import { IsString, IsNotEmpty } from 'class-validator';

export class UnclaimFooLinkDto {
  @IsString()
  @IsNotEmpty()
  address: string;
}
```

### `submit-foo-unlink.dto.ts`

```typescript
import { IsString, IsNotEmpty, IsNumber } from 'class-validator';

export class SubmitFooUnlinkDto {
  @IsString()
  @IsNotEmpty()
  address: string;

  @IsNumber()
  nonce: number;

  @IsString()
  @IsNotEmpty()
  signature: string;
}
```

## Step 2: Create the verifier service

Create `src/plugins/address-links/verification/foo-link-verifier.service.ts`.

The verifier has two responsibilities:

1. **`verifyClaim`** -- Validate the claim request and determine the canonical `value` to store on-chain. Return a `VerifiedClaim` object.
2. **`verifySubmit`** -- Validate the proof included with the submit request. Throw `BadRequestException` if invalid.

```typescript
import { BadRequestException, Injectable } from '@nestjs/common';
import { ClaimFooLinkDto } from '../dto/foo/claim-foo-link.dto';
import { SubmitFooLinkDto } from '../dto/foo/submit-foo-link.dto';
import { VerifiedClaim } from './link-verifier.interface';

@Injectable()
export class FooLinkVerifierService {

  async verifyClaim(dto: ClaimFooLinkDto): Promise<VerifiedClaim> {
    // Validate provider-specific claim data
    // Determine the canonical value (e.g. normalize a username)
    const value = '...';

    return { value };
    // Optionally return { value, verificationToken } if you need
    // to pass server-signed state from claim to submit (like X does)
  }

  async verifySubmit(dto: SubmitFooLinkDto, expectedMessage: string): Promise<void> {
    // Verify the provider-specific proof in the submit request
    // Throw BadRequestException if anything is wrong
  }
}
```

### Verification patterns by provider type

**OAuth-based (like X):**
- Claim: Exchange OAuth code for access token, fetch user profile, extract username. Create an HMAC-signed verification token containing `{ address, provider, value, expiry }`. Return `{ value, verificationToken }`.
- Submit: Parse and verify the HMAC token. Check address, provider, value, and expiry match.

**Cryptographic proof (like Nostr):**
- Claim: Validate the `value` format (e.g. decode the npub). Return `{ value }`.
- Submit: Verify the signed proof (e.g. Nostr event kind 22242 with matching content, pubkey, and valid signature).

**API-based (e.g. DNS, GitHub):**
- Claim: Return `{ value }`. Optionally start an async verification.
- Submit: Query the external API to confirm ownership (e.g. check a DNS TXT record, verify a GitHub gist exists).

## Step 3: Create the controller

Create `src/plugins/address-links/foo-link.controller.ts`.

Every provider controller follows the same structure. The controller injects `AddressLinksService` (shared) and the provider-specific verifier.

```typescript
import { Controller, Post, Body } from '@nestjs/common';
import { AddressLinksService } from './address-links.service';
import { FooLinkVerifierService } from './verification/foo-link-verifier.service';
import { ClaimFooLinkDto } from './dto/foo/claim-foo-link.dto';
import { SubmitFooLinkDto } from './dto/foo/submit-foo-link.dto';
import { UnclaimFooLinkDto } from './dto/foo/unclaim-foo-link.dto';
import { SubmitFooUnlinkDto } from './dto/foo/submit-foo-unlink.dto';

@Controller('address-links/foo')
export class FooLinkController {
  private readonly provider = 'foo';

  constructor(
    private readonly service: AddressLinksService,
    private readonly verifier: FooLinkVerifierService,
  ) {}

  @Post('claim')
  async claim(@Body() dto: ClaimFooLinkDto) {
    const verified = await this.verifier.verifyClaim(dto);
    const result = await this.service.claimLink(
      dto.address,
      this.provider,
      verified.value,
    );
    return {
      ...result,
      // Include verificationToken if your provider uses one:
      // verification_token: verified.verificationToken,
    };
  }

  @Post('submit')
  async submit(@Body() dto: SubmitFooLinkDto) {
    const message = this.service.buildLinkMessage(
      dto.address,
      this.provider,
      dto.value,
      dto.nonce,
    );
    await this.verifier.verifySubmit(dto, message);
    return this.service.submitLink(
      dto.address,
      this.provider,
      dto.value,
      dto.nonce,
      dto.signature,
    );
  }

  @Post('unclaim')
  async unclaim(@Body() dto: UnclaimFooLinkDto) {
    return this.service.claimUnlink(dto.address, this.provider);
  }

  @Post('unclaim/submit')
  async submitUnlink(@Body() dto: SubmitFooUnlinkDto) {
    return this.service.submitUnlink(
      dto.address,
      this.provider,
      dto.nonce,
      dto.signature,
    );
  }
}
```

## Step 4: Register in the module

Update `src/plugins/address-links/address-links.module.ts`:

```typescript
import { FooLinkController } from './foo-link.controller';
import { FooLinkVerifierService } from './verification/foo-link-verifier.service';

@Module({
  // ...
  controllers: [NostrLinkController, XLinkController, FooLinkController],
  providers: [
    // ...existing providers
    FooLinkVerifierService,
  ],
})
export class AddressLinksModule {}
```

## Step 5: Add environment variables (if needed)

If the provider needs configuration (API keys, secrets, TTLs), add them to `address-links.constants.ts`:

```typescript
export const FOO_API_KEY = process.env.FOO_API_KEY || '';
```

And document them in the `.env` file.

## Checklist

- [ ] 4 DTOs in `dto/foo/`
- [ ] Verifier service in `verification/foo-link-verifier.service.ts`
- [ ] Controller in `foo-link.controller.ts`
- [ ] Controller added to `AddressLinksModule.controllers`
- [ ] Verifier added to `AddressLinksModule.providers`
- [ ] Environment variables added (if applicable)
- [ ] TypeScript compiles (`npx tsc --noEmit`)

No changes needed in `AddressLinksService`, `contract.service.ts`, or the plugin sync service -- those are provider-agnostic.

## Reference implementations

| Provider | Verification pattern | Key files |
|---|---|---|
| Nostr | Cryptographic proof (signed event) | `nostr-link.controller.ts`, `nostr-link-verifier.service.ts`, `dto/nostr/` |
| X | OAuth + HMAC token | `x-link.controller.ts`, `x-link-verifier.service.ts`, `dto/x/` |
