import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ProfileAttestationService } from '../services/profile-attestation.service';
import { ProfileReadService } from '../services/profile-read.service';
import { CreateXAttestationDto } from '../dto/create-x-attestation.dto';

@Controller('profile')
@ApiTags('Profile')
export class ProfileController {
  constructor(
    private readonly profileAttestationService: ProfileAttestationService,
    private readonly profileReadService: ProfileReadService,
  ) {}

  @Post('x/attestation')
  @ApiOperation({
    operationId: 'createXAttestation',
    summary:
      'Create signed X username attestation for contract call. Accepts either { address, accessToken } or { address, code, code_verifier, redirect_uri } (OAuth2 PKCE code exchange).',
  })
  async createXAttestation(@Body() body: CreateXAttestationDto) {
    const options = body.accessToken
      ? { accessToken: body.accessToken }
      : {
          code: body.code!,
          code_verifier: body.code_verifier!,
          redirect_uri: body.redirect_uri!,
        };
    return this.profileAttestationService.createXAttestation(
      body.address,
      options,
    );
  }

  @Get('feed')
  @ApiOperation({
    operationId: 'getProfileFeed',
    summary: 'Get paginated profile feed from backend cache',
  })
  @ApiQuery({ name: 'limit', required: false, type: 'number' })
  @ApiQuery({ name: 'offset', required: false, type: 'number' })
  async getProfileFeed(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset = 0,
  ) {
    return this.profileReadService.getProfileFeed(limit, offset);
  }

  @Get()
  @ApiOperation({
    operationId: 'getProfiles',
    summary: 'Get multiple profiles by addresses list',
  })
  @ApiQuery({
    name: 'addresses',
    required: true,
    description: 'Comma-separated list of account addresses',
  })
  @ApiQuery({
    name: 'includeOnChain',
    required: false,
    description: 'When true, includes direct on-chain reads for each address',
  })
  async getProfiles(
    @Query('addresses') addresses: string,
    @Query('includeOnChain') includeOnChain?: string,
  ) {
    const parsed = (addresses || '')
      .split(',')
      .map((it) => it.trim())
      .filter(Boolean);
    return this.profileReadService.getProfilesByAddresses(parsed, {
      includeOnChain: includeOnChain === 'true',
    });
  }

  @Get(':address/onchain')
  @ApiOperation({
    operationId: 'getOnChainProfile',
    summary: 'Get profile directly from contract dry-run call',
  })
  async getOnChainProfile(@Param('address') address: string) {
    return this.profileReadService.getOnChainProfile(address);
  }

  @Get(':address')
  @ApiOperation({
    operationId: 'getProfile',
    summary: 'Get merged profile aggregate for frontend',
  })
  @ApiQuery({
    name: 'includeOnChain',
    required: false,
    description:
      'When true, augments response with fresh on-chain contract read',
  })
  async getProfile(
    @Param('address') address: string,
    @Query('includeOnChain') includeOnChain?: string,
  ) {
    return this.profileReadService.getProfile(address, {
      includeOnChain: includeOnChain === 'true',
    });
  }
}
